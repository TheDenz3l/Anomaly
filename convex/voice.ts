import { v } from "convex/values";
import { action } from "./_generated/server";
import { decisionProvider } from "./ai/decisions";
import { requireUser } from "./lib/auth";

/**
 * Voice (PRD §3.11). Speech is recognised and spoken on the device; the server only helps
 * hands-free mode decide when a turn is over.
 */

/** Hands-free mode: should the app keep listening, send, or stop speaking? */
export const turnTaking = action({
  args: { transcript: v.string(), silenceMs: v.number() },
  handler: async (
    ctx,
    args
  ): Promise<{ choice: "continue" | "end" | "interrupt"; confidence: number }> => {
    await requireUser(ctx);
    const d = await decisionProvider().turnTaking(args);
    return { choice: d.choice, confidence: d.confidence };
  },
});
