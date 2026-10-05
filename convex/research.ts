import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { forkEngine, modelEngine, type Engine } from "./engine/context";
import { failTurn, finishTurn } from "./engine/finish";
import { runModelLoop } from "./engine/loop";
import { highest, sourceList } from "./engine/research";
import { PartWriter } from "./engine/writer";
import { optionalUser } from "./lib/auth";
import type { Part, ReplyMeta } from "./lib/validators";
import { vSource } from "./lib/validators";
import { SourceCollector, verifyCitations } from "./web/sources";

/** Deep Research run state (PRD §3.7). The flow itself lives in engine/research.ts. */

const vStatus = v.union(
  v.literal("clarifying"),
  v.literal("awaiting_approval"),
  v.literal("running"),
  v.literal("synthesizing"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("cancelled")
);

const vPlan = v.object({
  steps: v.array(v.object({ id: v.string(), title: v.string(), queries: v.array(v.string()) })),
  depth: v.number(),
});

export const start = internalMutation({
  args: {
    userId: v.id("users"),
    threadId: v.id("threads"),
    question: v.string(),
    clarifyComponentId: v.string(),
    maxUsd: v.number(),
  },
  handler: async (ctx, a) =>
    await ctx.db.insert("researchRuns", {
      userId: a.userId,
      threadId: a.threadId,
      status: "clarifying",
      question: a.question,
      clarifications: [],
      depth: 2,
      budget: { maxUsd: a.maxUsd, maxSources: 40, maxSearches: 24 },
      spentUsd: 0,
      notes: [],
      sources: [],
      clarifyComponentId: a.clarifyComponentId,
    }),
});

export const patch = internalMutation({
  args: {
    runId: v.id("researchRuns"),
    status: v.optional(vStatus),
    clarifications: v.optional(v.array(v.string())),
    plan: v.optional(vPlan),
    depth: v.optional(v.number()),
    planComponentId: v.optional(v.string()),
    notes: v.optional(
      v.array(
        v.object({
          stepId: v.string(),
          title: v.string(),
          text: v.string(),
          sourceIds: v.array(v.string()),
        })
      )
    ),
    sources: v.optional(v.array(vSource)),
    spentUsd: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    progressMessageId: v.optional(v.id("messages")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { runId, ...patch }) => {
    const run = await ctx.db.get(runId);
    if (!run) return;
    if (run.status === "cancelled" && patch.status && patch.status !== "cancelled")
      delete patch.status;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, val]) => val !== undefined));
    await ctx.db.patch(runId, clean);
  },
});

export const latest = internalQuery({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) =>
    await ctx.db
      .query("researchRuns")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .first(),
});

export const get = internalQuery({
  args: { runId: v.id("researchRuns") },
  handler: async (ctx, { runId }) => await ctx.db.get(runId),
});

/** Status for the composer/progress UI. */
export const forThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await optionalUser(ctx);
    if (!userId) return null;
    const run = await ctx.db
      .query("researchRuns")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .first();
    if (!run || run.userId !== userId) return null;
    return {
      id: run._id,
      status: run.status,
      question: run.question,
      depth: run.depth,
      steps: run.plan?.steps ?? [],
      sourcesKept: run.sources.length,
      spentUsd: run.spentUsd,
      budgetUsd: run.budget.maxUsd,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  },
});

const REPORT_SYSTEM = [
  "You write deep research reports for a personal assistant app.",
  "Structure: a 2-4 sentence summary first, then ## sections in a logical order, then ## Limitations (gaps, conflicting sources, what's uncertain).",
  "Cite every factual sentence with [n] using ONLY the numbered sources provided. Never invent sources or numbers. If the notes don't support a claim, leave it out.",
  "Prefer specifics (numbers, names, dates) from the notes. Be direct; no filler.",
].join("\n");

/** Step 5–7: synthesize with the strongest model at high reasoning, verify citations, deliver. */
export const synthesize = internalAction({
  args: { runId: v.id("researchRuns"), messageId: v.id("messages") },
  handler: async (ctx, { runId, messageId }): Promise<void> => {
    const run: Doc<"researchRuns"> | null = await ctx.runQuery(internal.research.get, { runId });
    const data = await ctx.runQuery(internal.engine.data.turnContext, { messageId });
    if (!run || !data) return;
    if (data.message.status !== "streaming" || run.status === "cancelled") {
      await ctx.runMutation(internal.research.patch, {
        runId,
        status: "cancelled",
        finishedAt: Date.now(),
      });
      return;
    }
    const sink = new PartWriter(ctx, messageId, data.message.parts).start();
    const signal = new AbortController();
    sink.onStop = () => signal.abort();
    const meta: ReplyMeta = {
      modelRef: data.thread.modelRef,
      levelRequested: "high",
      levelSent: "off",
      reasoningTokens: 0,
    };
    let engine: Engine | null = null;
    try {
      const base = await modelEngine(
        ctx,
        { userId: data.thread.userId, thread: data.thread, settings: data.settings },
        data.thread.modelRef
      );
      engine = await forkEngine(
        base,
        data.settings.roleModels.synthesizer ?? data.settings.researchModelRef
      );
      meta.modelRef = engine.modelRef;
      const sources = new SourceCollector(run.sources);
      const before = new Set(sink.parts.map((p) => p.id));
      const notes = run.notes.map((n) => `## ${n.title}\n${n.text}`).join("\n\n");
      const result = await runModelLoop({
        engine,
        sink,
        messages: [
          { role: "system", content: REPORT_SYSTEM },
          {
            role: "user",
            content: `Question: ${run.question}\nUser's focus: ${run.clarifications.join("; ") || "none"}\n\nResearch notes:\n${notes || "(no notes — say the research found nothing reliable)"}\n\nSources:\n${sourceList(run.sources)}`,
          },
        ],
        tools: [],
        components: [],
        level: highest(engine),
        difficulty: "hard",
        maxSteps: 1,
        maxTokens: 8000,
        showThinking: true,
        sources,
        signal,
      });
      if (
        !sink.parts.some((p) => p.type === "text" && !before.has(p.id) && p.text.trim()) &&
        !sink.stopped
      ) {
        sink.text(
          `I couldn't write the full report, so here are the research notes.\n\n${run.notes.map((n) => `### ${n.title}\n${n.text}`).join("\n\n") || "No usable sources were found."}`
        );
      }
      let dropped = 0;
      for (const p of sink.parts) {
        if (p.type === "text" && !before.has(p.id)) {
          const v = verifyCitations(p.text, sources.size);
          dropped += v.dropped;
          sink.update(p.id, (x) => ({
            ...(x as Extract<Part, { type: "text" }>),
            text: v.text.trimStart(),
          }));
        }
      }
      await ctx.runMutation(internal.research.patch, {
        runId,
        status: sink.stopped ? "cancelled" : "done",
        finishedAt: Date.now(),
        spentUsd: run.spentUsd + (result.costUsd ?? 0),
        error: dropped ? `Dropped ${dropped} unverifiable citation(s).` : undefined,
      });
      await finishTurn(engine, sink, { messageId, sources, result, meta, kind: "report" });
      if (!sink.stopped) {
        await ctx.scheduler.runAfter(0, internal.notifications.send, {
          userId: data.thread.userId,
          title: "Research report ready",
          body: run.question.slice(0, 140),
          data: { threadId: data.thread._id, messageId },
        });
      }
    } catch (e) {
      await ctx.runMutation(internal.research.patch, {
        runId,
        status: "failed",
        error: String(e),
        finishedAt: Date.now(),
      });
      await failTurn(engine, sink, e, meta);
    }
  },
});
