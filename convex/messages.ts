import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { heuristicDecisions } from "./ai/decisions";
import { optionalUser, ownMessage, ownThread, requireUser } from "./lib/auth";
import { clientMessage, findComponent, stopStreaming, threadMessages } from "./lib/messages";
import { loadSettings } from "./lib/settings";
import { sanitizeValue, uid } from "./lib/util";
import { scheduleAutoProbe } from "./probes";
import type { Part } from "./lib/validators";

/** Chat API (PRD §3.1): every reply is an assistant message the engine streams into. */

export const list = query({
  args: { threadId: v.id("threads"), limit: v.optional(v.number()) },
  handler: async (ctx, { threadId, limit }) => {
    const userId = await optionalUser(ctx);
    if (!userId) return [];
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.userId !== userId) return [];
    const rows = await threadMessages(ctx, threadId, limit);
    return await Promise.all(rows.map((m) => clientMessage(ctx, m)));
  },
});

async function startReply(
  ctx: MutationCtx,
  thread: Doc<"threads">,
  userId: Id<"users">
): Promise<Id<"messages">> {
  const messageId = await ctx.db.insert("messages", {
    threadId: thread._id,
    userId,
    role: "assistant",
    parts: [],
    status: "streaming",
    meta: {
      modelRef: thread.modelRef,
      levelRequested: thread.reasoningLevel,
      levelSent: "",
      reasoningTokens: 0,
    },
  });
  await ctx.db.patch(thread._id, { updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.chat.run, { messageId });
  await scheduleAutoProbe(ctx, userId, thread.modelRef);
  return messageId;
}

async function firstModelRef(ctx: MutationCtx, userId: Id<"users">): Promise<string | null> {
  const providers = await ctx.db
    .query("providers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const p of providers) {
    const m = p.models.find((x) => x.kind === "chat");
    if (m) return `${p.providerId}/${m.id}`;
  }
  return null;
}

export const send = mutation({
  args: {
    threadId: v.optional(v.id("threads")),
    text: v.string(),
    attachments: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          width: v.optional(v.number()),
          height: v.optional(v.number()),
        })
      )
    ),
    research: v.optional(v.boolean()),
    draft: v.optional(
      v.object({ modelRef: v.string(), reasoningLevel: v.string(), incognito: v.boolean() })
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const text = args.text.trim();
    const attachments = args.attachments ?? [];
    if (!text && attachments.length === 0)
      throw new ConvexError("Type a message or attach a photo.");
    if (text.length > 32_000)
      throw new ConvexError("That message is too long (32,000 characters max).");
    if (attachments.length > 6) throw new ConvexError("Attach up to 6 photos per message.");

    let thread: Doc<"threads">;
    if (args.threadId) {
      thread = await ownThread(ctx, args.threadId, userId);
      if (args.research && thread.mode !== "research") {
        await ctx.db.patch(thread._id, { mode: "research" });
        thread = { ...thread, mode: "research" };
      } else if (!args.research && thread.mode === "research") {
        // Deep Research runs once per request. Once its report is in (or it ended), a reply
        // carries on as a normal chat that can see the report; mid-run replies still answer it.
        const run = await ctx.db
          .query("researchRuns")
          .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
          .order("desc")
          .first();
        if (!run || ["done", "failed", "cancelled"].includes(run.status)) {
          await ctx.db.patch(thread._id, { mode: "chat" });
          thread = { ...thread, mode: "chat" };
        }
      }
    } else {
      const settings = await loadSettings(ctx, userId);
      const modelRef =
        args.draft?.modelRef || settings.defaultModelRef || (await firstModelRef(ctx, userId));
      if (!modelRef) throw new ConvexError("Add a model provider in Settings first.");
      const id = await ctx.db.insert("threads", {
        userId,
        title: heuristicDecisions.title(text || "Photo"),
        modelRef,
        mode: args.research ? "research" : "chat",
        reasoningLevel: args.draft?.reasoningLevel ?? "auto",
        incognito: args.draft?.incognito ?? false,
        updatedAt: Date.now(),
      });
      thread = (await ctx.db.get(id))!;
    }
    await stopStreaming(ctx, thread._id);

    const parts: Part[] = [];
    const attachmentRows: Id<"attachments">[] = [];
    for (const a of attachments) {
      const row = await ctx.db
        .query("attachments")
        .withIndex("by_storage", (q) => q.eq("storageId", a.storageId))
        .first();
      if (!row || row.userId !== userId)
        throw new ConvexError("Attachment not found. Upload it again.");
      attachmentRows.push(row._id);
      parts.push({
        id: uid("img"),
        type: "image",
        storageId: a.storageId,
        mime: row.mime,
        width: a.width ?? row.width,
        height: a.height ?? row.height,
      });
    }
    if (text) parts.push({ id: uid("txt"), type: "text", text });
    const userMessageId = await ctx.db.insert("messages", {
      threadId: thread._id,
      userId,
      role: "user",
      parts,
      status: "done",
      searchText: thread.incognito ? undefined : text,
    });
    for (const id of attachmentRows) await ctx.db.patch(id, { messageId: userMessageId });
    await ctx.db.patch(thread._id, { preview: (text || "Photo").slice(0, 160) });
    const messageId = await startReply(ctx, thread, userId);
    return { threadId: thread._id, userMessageId, messageId };
  },
});

/** Structured result of a user interacting with an inline component (PRD §3.3 ui_event loop). */
export const emitUiEvent = mutation({
  args: {
    threadId: v.id("threads"),
    componentId: v.string(),
    component: v.string(),
    action: v.string(),
    label: v.string(),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const thread = await ownThread(ctx, args.threadId, userId);
    const found = await findComponent(ctx, thread._id, args.componentId);
    if (!found) throw new ConvexError("That card is no longer in this chat.");
    const payload =
      args.payload === undefined
        ? undefined
        : (sanitizeValue(args.payload) as Record<string, unknown>);
    const event: Part = {
      id: uid("evt"),
      type: "ui_event",
      componentId: args.componentId,
      component: args.component,
      action: args.action,
      label: args.label.slice(0, 500),
      payload,
    };
    const eventMessageId = await ctx.db.insert("messages", {
      threadId: thread._id,
      userId,
      role: "user",
      parts: [event],
      status: "done",
      searchText: thread.incognito ? undefined : args.label,
    });
    await ctx.db.patch(thread._id, { updatedAt: Date.now() });
    const p = (payload ?? {}) as Record<string, any>;

    // Silent events: handled here, no model turn (matches the client's isSilentEvent).
    if (args.component === "MemoryConfirm") {
      await handleMemoryEvent(ctx, userId, thread, found.part, args.action);
      return { eventMessageId, messageId: null };
    }
    if (args.action === "cancel_run") {
      const ids: string[] = Array.isArray(p.ids) ? p.ids.map(String) : [];
      for (const id of ids) {
        const runId = ctx.db.normalizeId("agentRuns", id);
        const run = runId ? await ctx.db.get(runId) : null;
        if (run && run.userId === userId && ["queued", "running"].includes(run.status)) {
          await ctx.db.patch(run._id, { status: "cancelled", finishedAt: Date.now() });
        }
      }
      return { eventMessageId, messageId: null };
    }

    if (args.component === "LocationRequest" && args.action === "allow") {
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lng) <= 180
      ) {
        await ctx.db.patch(thread._id, {
          location: {
            lat,
            lng,
            label:
              typeof p.label === "string" && p.label ? p.label.slice(0, 120) : "Current location",
          },
        });
      }
    }

    if (args.component === "SubagentPlan") {
      const plan = await ctx.db
        .query("agentRuns")
        .withIndex("by_component", (q) => q.eq("componentId", args.componentId))
        .first();
      if (plan && plan.userId === userId && plan.status === "proposed") {
        if (args.action === "approve") {
          const keep: string[] = Array.isArray(p.tasks) ? p.tasks.map(String) : [];
          await ctx.db.patch(plan._id, {
            status: "queued",
            plan: { ...(plan.plan ?? {}), approved: keep },
          });
          await stopStreaming(ctx, thread._id);
          const messageId = await ctx.db.insert("messages", {
            threadId: thread._id,
            userId,
            role: "assistant",
            parts: [],
            status: "streaming",
            meta: {
              modelRef: thread.modelRef,
              levelRequested: thread.reasoningLevel,
              levelSent: "",
              reasoningTokens: 0,
            },
          });
          await ctx.scheduler.runAfter(0, internal.agents.executeApproved, {
            planRunId: plan._id,
            messageId,
          });
          return { eventMessageId, messageId };
        }
        if (args.action === "cancel")
          await ctx.db.patch(plan._id, { status: "cancelled", finishedAt: Date.now() });
      }
    }

    await stopStreaming(ctx, thread._id);
    const messageId = await startReply(ctx, thread, userId);
    return { eventMessageId, messageId };
  },
});

async function handleMemoryEvent(
  ctx: MutationCtx,
  userId: Id<"users">,
  thread: Doc<"threads">,
  part: Extract<Part, { type: "component" }>,
  action: string
) {
  const existing = await ctx.db
    .query("memories")
    .withIndex("by_component", (q) => q.eq("componentId", part.id))
    .first();
  const props = (part.props ?? {}) as {
    text?: string;
    category?: any;
    scope?: any;
    confidence?: number;
  };
  if (action === "save" && !existing && props.text) {
    const id = await ctx.db.insert("memories", {
      userId,
      threadId: thread._id,
      scope: props.scope === "thread" ? "thread" : "global",
      text: props.text,
      category: ["preference", "fact", "person", "place", "work"].includes(props.category)
        ? props.category
        : "fact",
      confidence: props.confidence ?? 0.7,
      source: "confirmed",
      componentId: part.id,
    });
    await ctx.scheduler.runAfter(0, internal.memories.embed, { memoryId: id });
  } else if (action === "undo") {
    if (existing && existing.userId === userId) await ctx.db.delete(existing._id);
    await ctx.scheduler.runAfter(0, internal.decisionLog.markOverridden, {
      refId: part.id,
      kind: "memory_gate",
    });
  } else if (action === "dismiss") {
    await ctx.scheduler.runAfter(0, internal.decisionLog.markOverridden, {
      refId: part.id,
      kind: "memory_gate",
    });
  }
}

export const stop = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    await ownThread(ctx, threadId, userId);
    const stopped = await stopStreaming(ctx, threadId);
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    for (const r of runs) {
      if (["queued", "running"].includes(r.status))
        await ctx.db.patch(r._id, { status: "cancelled", finishedAt: Date.now() });
    }
    const research = await ctx.db
      .query("researchRuns")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    for (const r of research) {
      if (["running", "synthesizing"].includes(r.status))
        await ctx.db.patch(r._id, { status: "cancelled", finishedAt: Date.now() });
    }
    return { stopped };
  },
});

/** Re-runs the latest reply in place. */
export const regenerate = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const userId = await requireUser(ctx);
    const message = await ownMessage(ctx, messageId, userId);
    if (message.role !== "assistant") throw new ConvexError("Only replies can be regenerated.");
    if (message.status === "streaming")
      throw new ConvexError("Wait for the reply to finish, or stop it first.");
    const thread = await ownThread(ctx, message.threadId, userId);
    const latest = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
      .order("desc")
      .first();
    if (latest?._id !== messageId)
      throw new ConvexError("Only the latest reply can be regenerated.");
    const srcs = await ctx.db
      .query("sources")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    for (const s of srcs) await ctx.db.delete(s._id);
    await ctx.db.patch(messageId, {
      parts: [],
      status: "streaming",
      error: undefined,
      searchText: undefined,
      meta: {
        modelRef: thread.modelRef,
        levelRequested: thread.reasoningLevel,
        levelSent: "",
        reasoningTokens: 0,
      },
    });
    await ctx.scheduler.runAfter(0, internal.chat.run, { messageId });
    return { messageId };
  },
});

export const toggleSaved = mutation({
  args: {
    refId: v.string(),
    kind: v.optional(v.union(v.literal("message"), v.literal("artifact"))),
  },
  handler: async (ctx, { refId, kind }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("saved")
      .withIndex("by_user_ref", (q) => q.eq("userId", userId).eq("refId", refId))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
      return { saved: false };
    }
    await ctx.db.insert("saved", { userId, refId, kind: kind ?? "message", ts: Date.now() });
    return { saved: true };
  },
});

/** Recent replies that hold cards or reports, across non-incognito chats — feeds the Artifacts gallery. */
export const artifacts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await optionalUser(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(Math.min(limit ?? 400, 800));
    const threads = new Map<string, boolean>();
    const out = [];
    for (const m of rows) {
      if (m.role !== "assistant" || m.status === "streaming") continue;
      const rich =
        m.meta?.kind === "report" ||
        m.parts.some((p) => p.type === "component" && p.status === "ready");
      if (!rich) continue;
      if (!threads.has(m.threadId))
        threads.set(m.threadId, Boolean((await ctx.db.get(m.threadId))?.incognito ?? true));
      if (threads.get(m.threadId)) continue;
      out.push(await clientMessage(ctx, m));
    }
    return out;
  },
});

export const saved = query({
  args: {},
  handler: async (ctx) => {
    const userId = await optionalUser(ctx);
    if (!userId) return { messages: [], artifacts: [] };
    const rows = await ctx.db
      .query("saved")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId))
      .collect();
    const sorted = rows.sort((a, b) => b.ts - a.ts);
    return {
      messages: sorted.filter((r) => r.kind === "message").map((r) => r.refId),
      artifacts: sorted.filter((r) => r.kind === "artifact").map((r) => r.refId),
    };
  },
});
