import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { optionalUser, ownThread, requireUser } from "./lib/auth";
import { stopStreaming } from "./lib/messages";
import { loadSettings } from "./lib/settings";
import { vThreadMode } from "./lib/validators";

function clientThread(t: {
  _id: Id<"threads">;
  _creationTime: number;
  title: string;
  modelRef: string;
  mode: "chat" | "research";
  reasoningLevel: string;
  incognito: boolean;
  updatedAt: number;
  location?: { lat: number; lng: number; label: string };
  preview?: string;
  pinnedAt?: number;
}) {
  return {
    id: t._id,
    title: t.title,
    modelRef: t.modelRef,
    mode: t.mode,
    reasoningLevel: t.reasoningLevel,
    incognito: t.incognito,
    createdAt: t._creationTime,
    updatedAt: t.updatedAt,
    locationLabel: t.location?.label,
    preview: t.preview ?? "",
    pinnedAt: t.pinnedAt,
  };
}

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await optionalUser(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("threads")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .order("desc")
      .take(Math.min(limit ?? 200, 500));
    // Incognito chats are never listed: not in Recents, not in History.
    return rows.filter((t) => !t.incognito).map(clientThread);
  },
});

export const get = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await optionalUser(ctx);
    if (!userId) return null;
    const t = await ctx.db.get(threadId);
    return t && t.userId === userId ? clientThread(t) : null;
  },
});

export const create = mutation({
  args: {
    modelRef: v.optional(v.string()),
    reasoningLevel: v.optional(v.string()),
    incognito: v.optional(v.boolean()),
    mode: v.optional(vThreadMode),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const settings = await loadSettings(ctx, userId);
    const now = Date.now();
    return await ctx.db.insert("threads", {
      userId,
      title: args.title?.trim() || "New chat",
      modelRef: args.modelRef ?? settings.defaultModelRef,
      mode: args.mode ?? "chat",
      reasoningLevel: args.reasoningLevel ?? settings.thinkingLevel ?? "auto",
      incognito: args.incognito ?? false,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    threadId: v.id("threads"),
    title: v.optional(v.string()),
    modelRef: v.optional(v.string()),
    reasoningLevel: v.optional(v.string()),
    incognito: v.optional(v.boolean()),
    mode: v.optional(vThreadMode),
    pinned: v.optional(v.boolean()),
  },
  handler: async (ctx, { threadId, pinned, ...patch }) => {
    const userId = await requireUser(ctx);
    await ownThread(ctx, threadId, userId);
    if (pinned !== undefined)
      await ctx.db.patch(threadId, { pinnedAt: pinned ? Date.now() : undefined });
    if (patch.title !== undefined) {
      patch.title = patch.title.trim().slice(0, 120);
      if (!patch.title) throw new ConvexError("Title can't be empty.");
    }
    const clean = Object.fromEntries(Object.entries(patch).filter(([, val]) => val !== undefined));
    await ctx.db.patch(threadId, clean);
  },
});

export const clearLocation = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    await ownThread(ctx, threadId, userId);
    await ctx.db.patch(threadId, { location: undefined });
  },
});

export const remove = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    await discard(ctx, await ownThread(ctx, threadId, userId));
  },
});

async function discard(ctx: MutationCtx, thread: Doc<"threads">) {
  await stopStreaming(ctx, thread._id);
  await ctx.db.delete(thread._id);
  await ctx.scheduler.runAfter(0, internal.threads.purge, {
    threadId: thread._id,
    userId: thread.userId,
  });
}

/**
 * Throws away the user's incognito chats, all but the one still open. The app runs it as it
 * starts, so a chat left open when the app closed is gone the next time.
 */
export const discardIncognito = mutation({
  args: { keep: v.optional(v.id("threads")) },
  handler: async (ctx, { keep }) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("threads")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("incognito"), true))
      .collect();
    for (const t of rows) if (t._id !== keep) await discard(ctx, t);
  },
});

/** Incognito chats idle for a few hours, left behind by an app that never came back for them. */
export const sweepIncognito = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 3 * 60 * 60_000;
    const rows = await ctx.db
      .query("threads")
      .withIndex("by_incognito", (q) => q.eq("incognito", true).lt("updatedAt", cutoff))
      .take(100);
    for (const t of rows) await discard(ctx, t);
  },
});

/** Deletes everything a thread owned, in batches so large threads stay under mutation limits. */
export const purge = internalMutation({
  args: { threadId: v.id("threads"), userId: v.id("users") },
  handler: async (ctx, { threadId, userId }) => {
    const BATCH = 100;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .take(BATCH);
    for (const m of messages) {
      const srcs = await ctx.db
        .query("sources")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      for (const s of srcs) await ctx.db.delete(s._id);
      const atts = await ctx.db
        .query("attachments")
        .withIndex("by_message", (q) => q.eq("messageId", m._id))
        .collect();
      for (const a of atts) {
        await ctx.storage.delete(a.storageId).catch(() => {});
        await ctx.db.delete(a._id);
      }
      const saved = await ctx.db
        .query("saved")
        .withIndex("by_user_ref", (q) => q.eq("userId", userId).eq("refId", m._id))
        .collect();
      for (const s of saved) await ctx.db.delete(s._id);
      await ctx.db.delete(m._id);
    }
    if (messages.length === BATCH) {
      await ctx.scheduler.runAfter(0, internal.threads.purge, { threadId, userId });
      return;
    }
    for (const table of ["agentRuns", "researchRuns", "reasoningEvents"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect();
      for (const r of rows) {
        if (table === "agentRuns") {
          const steps = await ctx.db
            .query("agentSteps")
            .withIndex("by_run", (q) => q.eq("runId", r._id as Id<"agentRuns">))
            .collect();
          for (const s of steps) await ctx.db.delete(s._id);
        }
        await ctx.db.delete(r._id);
      }
    }
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const m of memories)
      if (m.threadId === threadId && m.scope === "thread") await ctx.db.delete(m._id);
  },
});

/** History search over titles and message text. */
export const search = query({
  args: { query: v.string() },
  handler: async (ctx, { query: q }) => {
    const userId = await optionalUser(ctx);
    const text = q.trim();
    if (!userId || !text) return [];
    const [byTitle, byText] = await Promise.all([
      ctx.db
        .query("threads")
        .withSearchIndex("search_title", (s) => s.search("title", text).eq("userId", userId))
        .take(20),
      ctx.db
        .query("messages")
        .withSearchIndex("search_text", (s) => s.search("searchText", text).eq("userId", userId))
        .take(40),
    ]);
    const hits = new Map<
      string,
      { threadId: Id<"threads">; title: string; snippet: string; updatedAt: number }
    >();
    for (const t of byTitle) {
      if (t.incognito) continue;
      hits.set(t._id, { threadId: t._id, title: t.title, snippet: "", updatedAt: t.updatedAt });
    }
    for (const m of byText) {
      if (hits.has(m.threadId)) continue;
      const t = await ctx.db.get(m.threadId);
      if (!t || t.incognito) continue;
      const body = m.searchText ?? "";
      const i = body.toLowerCase().indexOf(text.toLowerCase().split(/\s+/)[0]);
      const snippet = body.slice(Math.max(0, i - 40), Math.max(0, i - 40) + 160);
      hits.set(t._id, { threadId: t._id, title: t.title, snippet, updatedAt: t.updatedAt });
    }
    return [...hits.values()];
  },
});
