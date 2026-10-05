import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { embed as embedRequest } from "./ai/openai";
import { optionalUser, requireUser } from "./lib/auth";
import { endpointFor } from "./lib/endpoint";
import { fitVector } from "./lib/vectors";
import { parseModelRef } from "./lib/util";
import { vMemoryCategory, vMemoryScope } from "./lib/validators";
import { EMBEDDING_DIMENSIONS } from "./schema";

/** Memory tab API (PRD §3.9): view, edit, delete, export. Writes from chat go through the Jev gate. */

function clientMemory(m: Doc<"memories">) {
  return {
    id: m._id,
    text: m.text,
    category: m.category,
    scope: m.scope,
    threadId: m.threadId,
    confidence: m.confidence,
    source: m.source,
    createdAt: m._creationTime,
  };
}

export const list = query({
  args: { category: v.optional(vMemoryCategory), scope: v.optional(vMemoryScope) },
  handler: async (ctx, { category, scope }) => {
    const userId = await optionalUser(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    return rows
      .filter((m) => (!category || m.category === category) && (!scope || m.scope === scope))
      .map(clientMemory);
  },
});

export const exportAll = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return {
      exportedAt: new Date().toISOString(),
      memories: rows.map((m) => ({
        ...clientMemory(m),
        createdAt: new Date(m._creationTime).toISOString(),
      })),
    };
  },
});

export const create = mutation({
  args: {
    text: v.string(),
    category: vMemoryCategory,
    scope: v.optional(vMemoryScope),
    threadId: v.optional(v.id("threads")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const text = args.text.trim();
    if (!text) throw new ConvexError("Memory can't be empty.");
    if (text.length > 1000) throw new ConvexError("Keep memories under 1,000 characters.");
    if (args.threadId) {
      const t = await ctx.db.get(args.threadId);
      if (!t || t.userId !== userId) throw new ConvexError("Chat not found.");
    }
    const id = await ctx.db.insert("memories", {
      userId,
      threadId: args.threadId,
      scope: args.scope ?? (args.threadId ? "thread" : "global"),
      text,
      category: args.category,
      confidence: 1,
      source: "manual",
    });
    await ctx.scheduler.runAfter(0, internal.memories.embed, { memoryId: id });
    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id("memories"),
    text: v.optional(v.string()),
    category: v.optional(vMemoryCategory),
    scope: v.optional(vMemoryScope),
  },
  handler: async (ctx, { id, text, category, scope }) => {
    const userId = await requireUser(ctx);
    const m = await ctx.db.get(id);
    if (!m || m.userId !== userId) throw new ConvexError("Memory not found.");
    const patch: Partial<Doc<"memories">> = {};
    if (text !== undefined) {
      const t = text.trim();
      if (!t) throw new ConvexError("Memory can't be empty.");
      patch.text = t.slice(0, 1000);
    }
    if (category) patch.category = category;
    if (scope) {
      if (scope === "thread" && !m.threadId)
        throw new ConvexError("This memory isn't tied to a chat.");
      patch.scope = scope;
    }
    await ctx.db.patch(id, patch);
    if (patch.text && patch.text !== m.text)
      await ctx.scheduler.runAfter(0, internal.memories.embed, { memoryId: id });
  },
});

export const remove = mutation({
  args: { id: v.id("memories") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const m = await ctx.db.get(id);
    if (!m || m.userId !== userId) return;
    await ctx.db.delete(id);
  },
});

export const removeAll = mutation({
  args: { confirm: v.literal("delete all memories") },
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const m of rows) await ctx.db.delete(m._id);
    return rows.length;
  },
});

/* ------------------------------------------------------------------ internal */

export const insertInternal = internalMutation({
  args: {
    userId: v.id("users"),
    threadId: v.optional(v.id("threads")),
    scope: vMemoryScope,
    text: v.string(),
    category: vMemoryCategory,
    confidence: v.number(),
    source: v.union(v.literal("auto"), v.literal("confirmed"), v.literal("manual")),
    componentId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"memories"> | null> => {
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    if (rows.some((m) => norm(m.text) === norm(args.text))) return null;
    const id = await ctx.db.insert("memories", args);
    await ctx.scheduler.runAfter(0, internal.memories.embed, { memoryId: id });
    return id;
  },
});

export const forUser = internalQuery({
  args: { userId: v.id("users"), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit }) => {
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit ?? 300);
    return rows.map((m) => ({
      _id: m._id,
      text: m.text,
      category: m.category,
      scope: m.scope,
      threadId: m.threadId,
    }));
  },
});

export const byIds = internalQuery({
  args: { ids: v.array(v.id("memories")) },
  handler: async (ctx, { ids }) => {
    const out = [];
    for (const id of ids) {
      const m = await ctx.db.get(id);
      if (m)
        out.push({
          _id: m._id,
          userId: m.userId,
          text: m.text,
          category: m.category,
          scope: m.scope,
          threadId: m.threadId,
        });
    }
    return out;
  },
});

export const setEmbedding = internalMutation({
  args: {
    memoryId: v.id("memories"),
    embedding: v.optional(v.array(v.float64())),
    embeddingKey: v.optional(v.string()),
  },
  handler: async (ctx, { memoryId, embedding, embeddingKey }) => {
    const m = await ctx.db.get(memoryId);
    if (m) await ctx.db.patch(memoryId, { embedding, embeddingKey });
  },
});

export const embed = internalAction({
  args: { memoryId: v.id("memories") },
  handler: async (ctx, { memoryId }): Promise<void> => {
    const [m] = await ctx.runQuery(internal.memories.byIds, { ids: [memoryId] });
    if (!m) return;
    const settings = await ctx.runQuery(internal.settings.forUser, { userId: m.userId });
    const ref = settings.embeddingModelRef;
    const parsed = ref ? parseModelRef(ref) : null;
    if (!ref || !parsed) {
      await ctx.runMutation(internal.memories.setEmbedding, { memoryId });
      return;
    }
    const ep = await endpointFor(ctx, m.userId, parsed.providerId);
    if (!ep) return;
    try {
      const [vec] = await embedRequest(ep, parsed.modelId, [m.text], EMBEDDING_DIMENSIONS);
      if (vec?.length) {
        await ctx.runMutation(internal.memories.setEmbedding, {
          memoryId,
          embedding: fitVector(vec),
          embeddingKey: `${m.userId}|${ref}`,
        });
      }
    } catch (e) {
      console.warn("memory embedding failed", (e as Error).message);
    }
  },
});

export const reembedAll = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    let i = 0;
    for (const m of rows) {
      await ctx.scheduler.runAfter(i++ * 200, internal.memories.embed, { memoryId: m._id });
    }
  },
});
