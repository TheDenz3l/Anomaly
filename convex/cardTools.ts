import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { isOpenUITool, OPENUI_TOOLS } from "./ai/openuiTools";
import { requireUser } from "./lib/auth";

const MINUTE = 60_000;

/**
 * How often one user's cards may fetch: a program that refetches in a loop, or a slider dragged
 * across a query, shouldn't run up their web search bill or get the shared map servers to block us.
 * Web search costs most, so it has its own tighter limit.
 */
const LIMITS = { perMinute: 40, perDay: 800, searchPerMinute: 10 };

/**
 * Runs a live-data tool for an OpenUI card on the phone: a Query(…) the model wrote fetches through
 * here when the card shows and whenever a $variable it depends on changes, with no model call.
 */
export const call = action({
  args: { name: v.string(), args: v.any() },
  handler: async (ctx, a): Promise<unknown> => {
    const userId = await requireUser(ctx);
    if (!isOpenUITool(a.name)) throw new ConvexError(`There's no "${a.name}" tool for cards.`);
    const tool = OPENUI_TOOLS[a.name];
    const parsed = tool.args.safeParse(a.args ?? {});
    if (!parsed.success)
      throw new ConvexError(`Bad arguments for ${a.name}: ${parsed.error.issues[0]?.message}`);
    const allowed = await ctx.runMutation(internal.rateLimit.hit, {
      limits: [
        { key: `cards:${userId}:min`, limit: LIMITS.perMinute, windowMs: MINUTE },
        { key: `cards:${userId}:day`, limit: LIMITS.perDay, windowMs: 1440 * MINUTE },
        ...(a.name === "search"
          ? [{ key: `cards:${userId}:search`, limit: LIMITS.searchPerMinute, windowMs: MINUTE }]
          : []),
      ],
    });
    if (!allowed.ok)
      throw new ConvexError(
        `Too many live updates. Try again in ${Math.ceil(allowed.retryAfterMs / 1000)} s.`
      );
    return await (tool.run as (c: typeof ctx, u: typeof userId, x: unknown) => Promise<unknown>)(
      ctx,
      userId,
      parsed.data
    );
  },
});
