import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { forkEngine, type Engine } from "./context";
import { runModelLoop, type LoopTool, type ToolOutcome } from "./loop";
import { UNTRUSTED_RULE } from "./prompt";
import { findPlacesTool, geocodeTool, readUrlTool, webSearchTool, type ToolEnv } from "./tools";
import { BufferSink, type Sink } from "./writer";
import { truncate, uid } from "../lib/util";
import type { AgentRole, Source } from "../lib/validators";
import { renumberCitations, SourceCollector } from "../web/sources";

/**
 * Sub-agent engine (PRD §3.6): orchestrator–worker. Workers get their own context, a role tool
 * allowlist, and a budget; they return distilled results with evidence. Depth is 1 — workers
 * never get spawn_subagents. Deep Research (§3.7) reuses runWorkers.
 */

export const ROLES: AgentRole[] = [
  "search",
  "reader",
  "maps",
  "code",
  "vision",
  "memory-read",
  "verifier",
];

const EST_TOKENS: Record<AgentRole, number> = {
  search: 9000,
  reader: 10000,
  maps: 3000,
  code: 5000,
  vision: 3000,
  "memory-read": 1500,
  verifier: 6000,
};

const ROLE_BRIEF: Record<AgentRole, string> = {
  search: "You search the web and read the best pages to answer your task with evidence.",
  reader: "You read the given URLs/inputs closely and extract what the task asks for.",
  maps: "You find places and distances using geocode and find_places.",
  code: "You reason carefully, do calculations, and write or explain code. No web access.",
  vision: "You analyse the described visual inputs.",
  "memory-read": "You answer from the provided notes about the user only.",
  verifier: "You check claims against sources; report which hold, which don't, and why.",
};

export type WorkerTask = {
  id: string;
  role: AgentRole;
  brief: string;
  inputs?: string;
  model: string;
};

export type WorkerState = WorkerTask & {
  runId?: Id<"agentRuns">;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  startedAt?: number;
  durationMs: number;
  sourcesRead: number;
  tokens: number;
  result: string;
  sources: Source[];
};

export type Budget = { maxTokens: number; maxSearches: number; maxMinutes: number };

export function planBudget(tasks: { role: AgentRole }[]): Budget {
  const tokens = tasks.reduce((n, t) => n + EST_TOKENS[t.role], 0);
  return {
    maxTokens: Math.round(tokens * 1.6),
    maxSearches: tasks.filter((t) => t.role === "search" || t.role === "verifier").length * 4 + 2,
    maxMinutes: 5,
  };
}

/** The plan's search allowance, drawn down by every worker of a run. */
export type SearchPool = { used: number; max: number };

/**
 * A worker's tool budget whose searches count against the shared pool (tools read `searches`
 * against `maxSearches` and increment it); `own` is how many this worker ran.
 */
export function workerBudget(pool: SearchPool, maxReads = 4) {
  let own = 0;
  return {
    get searches() {
      return pool.used;
    },
    set searches(n: number) {
      own += n - pool.used;
      pool.used = n;
    },
    get maxSearches() {
      return pool.max;
    },
    reads: 0,
    maxReads,
    get own() {
      return own;
    },
  };
}

export function estimateTaskTokens(role: AgentRole): number {
  return EST_TOKENS[role];
}

function toolsFor(role: AgentRole, env: ToolEnv): LoopTool[] {
  switch (role) {
    case "search":
    case "verifier":
      return [webSearchTool(env), readUrlTool(env)];
    case "reader":
      return [readUrlTool(env)];
    case "maps":
      return [geocodeTool(env), findPlacesTool(env)];
    default:
      return [];
  }
}

async function runWorker(
  parent: Engine,
  goal: string,
  task: WorkerTask,
  state: WorkerState,
  perWorkerTokens: number,
  isCancelled: () => Promise<boolean>,
  pool: SearchPool,
  context?: string
): Promise<{ cancelled: boolean }> {
  const engine = await forkEngine(parent, task.model);
  const sources = new SourceCollector();
  const sink = new BufferSink(isCancelled);
  const budget = workerBudget(pool);
  const env: ToolEnv = {
    engine,
    sink,
    sources,
    origin: "subagent",
    render: false,
    budget,
    location: () => parent.thread.location,
    setLocation: async () => {},
  };
  const system = [
    `You are a ${task.role} worker inside a research assistant. ${ROLE_BRIEF[task.role]}`,
    `Overall goal (context only): ${goal}`,
    "Do only your task. Be efficient: a few targeted tool calls, then answer.",
    "Return a concise result (under 200 words) in plain Markdown. Cite every factual claim with [n] from your tool results. If you couldn't find something, say so plainly.",
    UNTRUSTED_RULE,
    context ? `Notes provided by the orchestrator:\n${truncate(context, 4000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const levels = engine.profile.reasoning.levels.filter((l) => l !== "none");
  const res = await runModelLoop({
    engine,
    sink,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `Task: ${task.brief}${task.inputs ? `\nInputs: ${task.inputs}` : ""}`,
      },
    ],
    tools: toolsFor(task.role, env),
    components: [],
    level:
      task.role === "verifier"
        ? (levels[Math.floor(levels.length / 2)] ?? "auto")
        : (levels[0] ?? "off"),
    difficulty: task.role === "verifier" || task.role === "code" ? "moderate" : "easy",
    maxSteps: 5,
    maxTokens: Math.min(4000, Math.max(800, perWorkerTokens)),
    sources,
  });
  state.tokens = res.promptTokens + res.completionTokens;
  state.sources = sources.all();
  state.sourcesRead = budget.reads + budget.own;
  state.result = res.text.trim() || sink.out.trim();
  return { cancelled: sink.stopped };
}

export type TimelineHooks = {
  render: (states: WorkerState[], live: boolean) => void;
};

/** Runs up to 5 workers in parallel with a wall-clock cap; partial failures don't sink the batch. */
export async function runWorkers(
  engine: Engine,
  opts: {
    goal: string;
    tasks: WorkerTask[];
    budget: Budget;
    parentRunId?: Id<"agentRuns">;
    hooks?: TimelineHooks;
    context?: string;
    stopped?: () => boolean;
  }
): Promise<WorkerState[]> {
  const { ctx } = engine;
  const tasks = opts.tasks.slice(0, 5);
  const perWorker = Math.floor(opts.budget.maxTokens / Math.max(tasks.length, 1));
  const states: WorkerState[] = tasks.map((t) => ({
    ...t,
    status: "queued",
    durationMs: 0,
    sourcesRead: 0,
    tokens: 0,
    result: "",
    sources: [],
  }));
  const runIds = await ctx.runMutation(internal.agents.createWorkers, {
    userId: engine.userId,
    threadId: engine.thread._id,
    parentRunId: opts.parentRunId,
    workers: tasks.map((t) => ({ role: t.role, brief: t.brief, model: t.model })),
    budget: { ...opts.budget, maxTokens: perWorker },
  });
  states.forEach((s, i) => (s.runId = runIds[i]));
  const render = () =>
    opts.hooks?.render(
      states,
      states.some((s) => s.status === "queued" || s.status === "running")
    );
  render();

  const deadline = Date.now() + opts.budget.maxMinutes * 60_000;
  const pool: SearchPool = { used: 0, max: opts.budget.maxSearches };
  await Promise.all(
    states.map(async (s) => {
      const isCancelled = async () =>
        Boolean(opts.stopped?.()) ||
        Date.now() > deadline ||
        (s.runId
          ? (await ctx.runQuery(internal.agents.runStatus, { runId: s.runId })) === "cancelled"
          : false);
      s.status = "running";
      s.startedAt = Date.now();
      render();
      await ctx.runMutation(internal.agents.updateRun, {
        runId: s.runId!,
        status: "running",
        startedAt: s.startedAt,
      });
      try {
        const { cancelled } = await runWorker(
          engine,
          opts.goal,
          s,
          s,
          perWorker,
          isCancelled,
          pool,
          opts.context
        );
        s.status = cancelled ? "cancelled" : s.result ? "done" : "failed";
        if (!s.result) s.result = cancelled ? "Cancelled." : "No result.";
      } catch (e) {
        s.status = "failed";
        s.result = `Failed: ${truncate((e as Error).message, 200)}`;
      }
      s.durationMs = Date.now() - (s.startedAt ?? Date.now());
      const final = s.status as WorkerState["status"];
      render();
      await ctx.runMutation(internal.agents.updateRun, {
        runId: s.runId!,
        status: final === "queued" || final === "running" ? "failed" : final,
        result: truncate(s.result, 6000),
        sources: s.sources.slice(0, 20),
        tokens: s.tokens,
        searches: s.sourcesRead,
        finishedAt: Date.now(),
      });
    })
  );
  render();
  return states;
}

/** SubagentTimeline props. Running workers report elapsed + estimate so the client animates progress. */
export function timelineProps(states: WorkerState[], live: boolean) {
  return {
    live,
    runs: states.slice(0, 5).map((s) => {
      const running = s.status === "queued" || s.status === "running";
      const elapsed = s.startedAt ? Date.now() - s.startedAt : 0;
      return {
        id: s.runId ?? s.id,
        role: s.role,
        brief: truncate(s.brief, 160),
        model: s.model.split("/").pop() ?? s.model,
        durationMs: running ? elapsed + 30_000 : Math.max(1, s.durationMs),
        sourcesRead: s.sourcesRead,
        tokens: s.tokens,
        outcome:
          s.status === "failed" || s.status === "cancelled"
            ? ("failed" as const)
            : ("done" as const),
        result: running ? "" : truncate(s.result, 600),
        status: s.status,
      };
    }),
  };
}

/** Merges worker sources into the parent's numbering and rewrites their [k] citations to match. */
export function mergeWorkerResults(states: WorkerState[], sources: SourceCollector): string {
  return states
    .map((s, i) => {
      const map = new Map<number, number>();
      s.sources.forEach((src, k) => map.set(k + 1, sources.add({ ...src, origin: "subagent" })));
      const body = renumberCitations(s.result, map);
      return `## Worker ${i + 1} (${s.role}, ${s.status}): ${s.brief}\n${body}`;
    })
    .join("\n\n");
}

export type SpawnEnv = ToolEnv & {
  stoppedRef: () => boolean;
  /** Jev's delegation decision was only "confirm"-confident: always show the plan card first. */
  forceApproval?: boolean;
};

/**
 * spawn_subagents tool. Small plans run inline with a live SubagentTimeline; large or costly
 * plans (or "Always offer" mode) show a SubagentPlan approval card and end the turn.
 */
export function spawnTool(env: SpawnEnv, sink: Sink): LoopTool {
  const { engine } = env;
  return {
    def: {
      type: "function",
      function: {
        name: "spawn_subagents",
        description:
          "Run 1–5 parallel workers with separate context. Each task needs a role and a self-contained brief (what to find, what to return). Roles: search (web), reader (read given URLs), maps (places), code (reasoning/calculation), verifier (fact-check).",
        parameters: {
          type: "object",
          properties: {
            goal: { type: "string", description: "What the combined result is for" },
            tasks: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ROLES },
                  brief: { type: "string" },
                  inputs: { type: "string", description: "URLs, names or data the worker needs" },
                },
                required: ["role", "brief"],
                additionalProperties: false,
              },
            },
          },
          required: ["goal", "tasks"],
          additionalProperties: false,
        },
      },
    },
    async run(args): Promise<ToolOutcome> {
      const goal = truncate(String(args.goal ?? ""), 500);
      const raw: any[] = Array.isArray(args.tasks) ? args.tasks.slice(0, 5) : [];
      if (!raw.length) return { content: "Give at least one task." };
      const roleModels = engine.settings.roleModels;
      const tasks: WorkerTask[] = raw.map((t) => {
        const role: AgentRole = ROLES.includes(t.role) ? t.role : "search";
        return {
          id: uid("task"),
          role,
          brief: truncate(String(t.brief ?? goal), 600),
          inputs: t.inputs ? truncate(String(t.inputs), 1500) : undefined,
          model: (role === "verifier" ? roleModels.verifier : roleModels.worker) ?? engine.modelRef,
        };
      });
      const budget = planBudget(tasks);
      const price = engine.pricing
        ? engine.pricing.prompt * 0.7 + engine.pricing.completion * 0.3
        : null;
      const costEstimateUsd =
        price !== null ? Math.round(budget.maxTokens * price * 1000) / 1000 : 0;
      const needsApproval =
        env.forceApproval ||
        engine.settings.subagentMode === "offer" ||
        tasks.length >= 4 ||
        // No published price: the cost is unknown, not free.
        (costEstimateUsd === 0 && tasks.length >= 3) ||
        costEstimateUsd > Math.max(0.1, engine.settings.researchCostCapUsd / 2);

      if (needsApproval) {
        const componentId = uid("cmp");
        const props = {
          goal,
          tasks: tasks.map((t) => ({
            id: t.id,
            role: t.role,
            brief: t.brief,
            model: t.model.split("/").pop() ?? t.model,
            estTokens: EST_TOKENS[t.role],
          })),
          costEstimateUsd,
          budget,
        };
        await engine.ctx.runMutation(internal.agents.createPlan, {
          userId: engine.userId,
          threadId: engine.thread._id,
          componentId,
          goal,
          tasks: tasks.map((t) => ({
            id: t.id,
            role: t.role,
            brief: t.brief,
            inputs: t.inputs,
            model: t.model,
          })),
          budget,
        });
        sink.add({
          id: componentId,
          type: "component",
          name: "SubagentPlan",
          props,
          status: "ready",
          fallbackText: `Plan: ${tasks.length} workers — ${tasks.map((t) => t.brief).join("; ")}. Approve to start.`,
        });
        return {
          content:
            "Plan shown for approval. Write one short sentence inviting the user to approve or edit it, then stop.",
          final: true,
        };
      }

      const timelineId = sink.add({
        id: uid("cmp"),
        type: "component",
        name: "SubagentTimeline",
        props: timelineProps(
          tasks.map((t) => ({
            ...t,
            status: "queued",
            durationMs: 0,
            sourcesRead: 0,
            tokens: 0,
            result: "",
            sources: [],
          })),
          true
        ),
        status: "ready",
        fallbackText: `Running ${tasks.length} workers.`,
      });
      const states = await runWorkers(engine, {
        goal,
        tasks,
        budget,
        stopped: env.stoppedRef,
        hooks: {
          render: (s, live) =>
            sink.update(timelineId, (p) => ({
              ...(p as any),
              props: timelineProps(s, live),
              fallbackText: `${s.filter((x) => x.status === "done").length} of ${s.length} workers finished.`,
            })),
        },
      });
      const failed = states.filter((s) => s.status !== "done");
      const merged = mergeWorkerResults(states, env.sources);
      return {
        content: `Worker results (cite with the [n] numbers shown):\n\n${merged}${
          failed.length
            ? `\n\n${failed.length} worker(s) failed or were cancelled; note the gap in your answer.`
            : ""
        }\n\nNow write the final answer for the user.`,
      };
    },
  };
}
