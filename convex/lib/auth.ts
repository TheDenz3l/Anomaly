import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";

export async function requireUser(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Sign in first.");
  return userId;
}

export async function optionalUser(
  ctx: QueryCtx | MutationCtx | ActionCtx
): Promise<Id<"users"> | null> {
  return await getAuthUserId(ctx);
}

export async function ownThread(
  ctx: QueryCtx | MutationCtx,
  threadId: Id<"threads">,
  userId: Id<"users">
): Promise<Doc<"threads">> {
  const thread = await ctx.db.get(threadId);
  if (!thread || thread.userId !== userId) throw new ConvexError("Chat not found.");
  return thread;
}

export async function ownMessage(
  ctx: QueryCtx | MutationCtx,
  messageId: Id<"messages">,
  userId: Id<"users">
): Promise<Doc<"messages">> {
  const message = await ctx.db.get(messageId);
  if (!message || message.userId !== userId) throw new ConvexError("Message not found.");
  return message;
}
