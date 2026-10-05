import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

/** Expo push (free) — used when background work like Deep Research finishes. */
export const send = internalAction({
  args: { userId: v.id("users"), title: v.string(), body: v.string(), data: v.optional(v.any()) },
  handler: async (ctx, { userId, title, body, data }): Promise<void> => {
    const settings = await ctx.runQuery(internal.settings.forUser, { userId });
    if (!settings.pushToken) return;
    try {
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          to: settings.pushToken,
          title,
          body,
          data: data ?? {},
          sound: "default",
        }),
      });
      if (!res.ok) console.warn("push failed", res.status, await res.text());
    } catch (e) {
      console.warn("push failed", (e as Error).message);
    }
  },
});
