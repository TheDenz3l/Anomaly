import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { runTurn } from "./engine/turn";

/** Runs one assistant reply. Scheduled by messages.send / emitUiEvent / regenerate. */
export const run = internalAction({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }): Promise<void> => {
    await runTurn(ctx, messageId);
  },
});
