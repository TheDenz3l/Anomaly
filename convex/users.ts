import { query } from "./_generated/server";
import { optionalUser } from "./lib/auth";

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await optionalUser(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return {
      id: user._id,
      name: user.name ?? null,
      email: user.email ?? null,
      isAnonymous: user.isAnonymous ?? false,
    };
  },
});
