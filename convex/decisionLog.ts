import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { optionalUser, requireUser } from "./lib/auth";

/** Every decision and user override, kept as an evaluation set for Jev (PRD §4). */

export const recordMany = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    refId: v.optional(v.string()),
    items: v.array(
      v.object({
        kind: v.string(),
        input: v.any(),
        output: v.any(),
        confidence: v.number(),
        provider: v.string(),
        refId: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, { userId, refId, items }) => {
    const ts = Date.now();
    for (const d of items) {
      await ctx.db.insert("decisions", {
        userId,
        ...d,
        refId: d.refId ?? refId,
        overridden: false,
        ts,
      });
    }
  },
});

/** Marks decisions for a message/component as overridden by the user (e.g. dismissed a memory). */
export const markOverridden = internalMutation({
  args: { refId: v.string(), kind: v.optional(v.string()) },
  handler: async (ctx, { refId, kind }) => {
    const rows = await ctx.db
      .query("decisions")
      .withIndex("by_ref", (q) => q.eq("refId", refId))
      .collect();
    for (const r of rows)
      if (!kind || r.kind === kind) await ctx.db.patch(r._id, { overridden: true });
  },
});

export const override = mutation({
  args: { refId: v.string(), kind: v.optional(v.string()) },
  handler: async (ctx, { refId, kind }) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("decisions")
      .withIndex("by_ref", (q) => q.eq("refId", refId))
      .collect();
    for (const r of rows) {
      if (r.userId === userId && (!kind || r.kind === kind))
        await ctx.db.patch(r._id, { overridden: true });
    }
  },
});

export const recent = query({
  args: { kind: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { kind, limit }) => {
    const userId = await optionalUser(ctx);
    if (!userId) return [];
    const q = kind
      ? ctx.db
          .query("decisions")
          .withIndex("by_user_kind", (x) => x.eq("userId", userId).eq("kind", kind))
      : ctx.db.query("decisions").withIndex("by_user_kind", (x) => x.eq("userId", userId));
    return await q.order("desc").take(Math.min(limit ?? 100, 500));
  },
});
