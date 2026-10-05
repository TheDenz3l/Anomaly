import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { mergeWorkerResults, runWorkers, timelineProps, type WorkerTask } from "./engine/agents";
import { modelEngine } from "./engine/context";
import { failTurn } from "./engine/finish";
import { runTurn } from "./engine/turn";
import { PartWriter } from "./engine/writer";
import { optionalUser } from "./lib/auth";
import { uid } from "./lib/util";
import { vAgentRole, vSource } from "./lib/validators";
import { SourceCollector } from "./web/sources";

/** Sub-agent runs (PRD §3.6): plan approval, worker bookkeeping, cancellation, run logs. */

const vBudget = v.object({
  maxTokens: v.number(),
  maxSearches: v.number(),
  maxMinutes: v.number(),
});

export const createPlan = internalMutation({
  args: {
    userId: v.id("users"),
    threadId: v.id("threads"),
    componentId: v.string(),
    goal: v.string(),
    tasks: v.array(
      v.object({
        id: v.string(),
        role: vAgentRole,
        brief: v.string(),
        inputs: v.optional(v.string()),
        model: v.string(),
      })
    ),
    budget: vBudget,
  },
  handler: async (ctx, a) =>
    await ctx.db.insert("agentRuns", {
      userId: a.userId,
      threadId: a.threadId,
      componentId: a.componentId,
      kind: "plan",
      role: "orchestrator",
      brief: a.goal,
      model: "",
      status: "proposed",
      budget: a.budget,
      plan: { goal: a.goal, tasks: a.tasks },
      tokens: 0,
      searches: 0,
    }),
});

export const createWorkers = internalMutation({
  args: {
    userId: v.id("users"),
    threadId: v.id("threads"),
    parentRunId: v.optional(v.id("agentRuns")),
    workers: v.array(v.object({ role: vAgentRole, brief: v.string(), model: v.string() })),
    budget: vBudget,
  },
  handler: async (ctx, a) => {
    const ids = [];
    for (const w of a.workers) {
      ids.push(
        await ctx.db.insert("agentRuns", {
          userId: a.userId,
          threadId: a.threadId,
          parentRunId: a.parentRunId,
          kind: "worker",
          role: w.role,
          brief: w.brief,
          model: w.model,
          status: "queued",
          budget: a.budget,
          tokens: 0,
          searches: 0,
        })
      );
    }
    return ids;
  },
});

export const runStatus = internalQuery({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, { runId }) => (await ctx.db.get(runId))?.status ?? null,
});

export const updateRun = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    status: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("running"),
        v.literal("done"),
        v.literal("failed"),
        v.literal("cancelled")
      )
    ),
    result: v.optional(v.string()),
    sources: v.optional(v.array(vSource)),
    tokens: v.optional(v.number()),
    searches: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { runId, ...patch }) => {
    const run = await ctx.db.get(runId);
    if (!run) return;
    // A user cancel wins over a late "done".
    if (run.status === "cancelled" && patch.status && patch.status !== "cancelled")
      delete patch.status;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, val]) => val !== undefined));
    await ctx.db.patch(runId, clean);
    if (patch.result) {
      await ctx.db.insert("agentSteps", {
        runId,
        kind: "result",
        input: null,
        output: patch.result.slice(0, 4000),
        tokens: patch.tokens ?? 0,
        ts: Date.now(),
      });
    }
  },
});

export const getPlan = internalQuery({
  args: { planRunId: v.id("agentRuns") },
  handler: async (ctx, { planRunId }) => await ctx.db.get(planRunId),
});

/** Runs an approved SubagentPlan into a fresh reply, then lets the main agent write the answer. */
export const executeApproved = internalAction({
  args: { planRunId: v.id("agentRuns"), messageId: v.id("messages") },
  handler: async (ctx, { planRunId, messageId }): Promise<void> => {
    const plan = await ctx.runQuery(internal.agents.getPlan, { planRunId });
    const data = await ctx.runQuery(internal.engine.data.turnContext, { messageId });
    if (!plan || !data || plan.status !== "queued") return;
    const sink = new PartWriter(ctx, messageId, data.message.parts).start();
    const meta = {
      modelRef: data.thread.modelRef,
      levelRequested: data.thread.reasoningLevel,
      levelSent: "off",
      reasoningTokens: 0,
    };
    let engine = null;
    try {
      engine = await modelEngine(
        ctx,
        { userId: data.thread.userId, thread: data.thread, settings: data.settings },
        data.thread.modelRef
      );
      const p = plan.plan as { goal: string; tasks: WorkerTask[]; approved?: string[] };
      const approved = p.approved?.length
        ? p.tasks.filter((t) => p.approved!.includes(t.id))
        : p.tasks;
      await ctx.runMutation(internal.agents.updateRun, {
        runId: planRunId,
        status: "running",
        startedAt: Date.now(),
      });
      const timelineId = sink.add({
        id: uid("cmp"),
        type: "component",
        name: "SubagentTimeline",
        props: timelineProps(
          approved.map((t) => ({
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
        fallbackText: `Running ${approved.length} workers.`,
      });
      const states = await runWorkers(engine, {
        goal: p.goal,
        tasks: approved,
        budget: plan.budget,
        parentRunId: planRunId,
        stopped: () => sink.stopped,
        hooks: {
          render: (s, live) =>
            sink.update(timelineId, (part) => ({
              ...(part as any),
              props: timelineProps(s, live),
              fallbackText: `${s.filter((x) => x.status === "done").length} of ${s.length} workers finished.`,
            })),
        },
      });
      const sources = new SourceCollector();
      const merged = mergeWorkerResults(states, sources);
      const failed = states.filter((s) => s.status !== "done").length;
      await ctx.runMutation(internal.agents.updateRun, {
        runId: planRunId,
        status: failed === states.length ? "failed" : "done",
        finishedAt: Date.now(),
        tokens: states.reduce((n, s) => n + s.tokens, 0),
      });
      if (sink.stopped) {
        await sink.finish({ status: "stopped", meta });
        return;
      }
      await sink.detach();
      await runTurn(ctx, messageId, {
        sources: sources.all(),
        injected: [
          "# Results from the sub-agents the user approved (cite with these [n] numbers)",
          merged,
          failed ? `${failed} worker(s) failed or were cancelled; note the gap.` : "",
          "Write the final answer from these results now. Don't spawn more workers.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    } catch (e) {
      await ctx.runMutation(internal.agents.updateRun, {
        runId: planRunId,
        status: "failed",
        error: String(e),
      });
      await failTurn(engine, sink, e, meta);
    }
  },
});

/** Run log for a thread: plans and workers with results (long outputs stay here, not in chat). */
export const forThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await optionalUser(ctx);
    if (!userId) return [];
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.userId !== userId) return [];
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .take(100);
    return runs.map((r) => ({
      id: r._id,
      kind: r.kind,
      parentRunId: r.parentRunId,
      role: r.role,
      brief: r.brief,
      model: r.model,
      status: r.status,
      result: r.result,
      sources: r.sources ?? [],
      tokens: r.tokens,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.error,
    }));
  },
});
