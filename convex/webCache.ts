import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/** URL/content cache with per-content-type TTLs (PRD §3.8) — also backs robots.txt and circuit breakers. */

const MAX_CONTENT = 180_000;

export const get = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("webCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!row || row.fetchedAt + row.ttl < Date.now()) return null;
    return { content: row.content, contentType: row.contentType, fetchedAt: row.fetchedAt };
  },
});

export const put = internalMutation({
  args: { key: v.string(), content: v.string(), contentType: v.string(), ttl: v.number() },
  handler: async (ctx, args) => {
    const content =
      args.content.length > MAX_CONTENT ? args.content.slice(0, MAX_CONTENT) : args.content;
    const existing = await ctx.db
      .query("webCache")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    const row = {
      key: args.key,
      content,
      contentType: args.contentType,
      ttl: args.ttl,
      fetchedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("webCache", row);
  },
});

export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    const old = await ctx.db
      .query("webCache")
      .withIndex("by_fetched", (q) => q.lt("fetchedAt", cutoff))
      .take(500);
    let removed = 0;
    for (const row of old) {
      await ctx.db.delete(row._id);
      removed++;
    }
    const now = Date.now();
    const recent = await ctx.db
      .query("webCache")
      .withIndex("by_fetched", (q) => q.gte("fetchedAt", cutoff))
      .take(1000);
    for (const row of recent) {
      if (row.fetchedAt + row.ttl < now) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    return removed;
  },
});
