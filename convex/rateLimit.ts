import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Counts one use against several fixed-window limits at once: allowed only if every limit has room,
 * and only then counted, so a refused call uses up nothing. Each counter is one row updated in this
 * transaction, so concurrent calls can't both slip past a limit.
 */
export const hit = internalMutation({
  args: {
    limits: v.array(v.object({ key: v.string(), limit: v.number(), windowMs: v.number() })),
  },
  handler: async (ctx, { limits }) => {
    const now = Date.now();
    const rows = await Promise.all(
      limits.map(async (l) => {
        const row = await ctx.db
          .query("rateLimits")
          .withIndex("by_key", (q) => q.eq("key", l.key))
          .first();
        const fresh = !row || now - row.windowStart >= l.windowMs;
        return { l, row, count: fresh ? 0 : row.count, start: fresh ? now : row.windowStart };
      })
    );
    const full = rows.find((r) => r.count >= r.l.limit);
    if (full) return { ok: false as const, retryAfterMs: full.start + full.l.windowMs - now };
    for (const r of rows) {
      if (r.row) await ctx.db.patch(r.row._id, { windowStart: r.start, count: r.count + 1 });
      else await ctx.db.insert("rateLimits", { key: r.l.key, windowStart: now, count: 1 });
    }
    return { ok: true as const };
  },
});
