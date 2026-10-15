import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { registryProfile } from "./ai/registry";
import { profileRequest } from "./engine/profile";
import { optionalUser, ownThread, requireUser } from "./lib/auth";
import { clientMessage, threadMessages } from "./lib/messages";
import { pickProfileModel, speedCandidates, speedsDue } from "./lib/profileModel";
import { loadSettings } from "./lib/settings";
import { parseModelRef, uid } from "./lib/util";
import { vEntityCard, type Entity, type EntityKind } from "./lib/validators";
import { startReply } from "./messages";
import { countHit } from "./rateLimit";
import { entityKey } from "./web/entity";

/**
 * Profile sheets (engine/profile.ts). A name marked in a reply opens a hidden chat about it: its
 * first reply is the profile, written at low effort by the chat's model or a quicker one from the
 * same provider (lib/profileModel.ts), and questions asked in the sheet carry on there. The same
 * name tapped again within a few days reopens it.
 */

const KINDS: EntityKind[] = ["person", "place", "organization", "work", "product", "event"];
/** A profile this old is written again, so tour dates and news stay current. */
const FRESH_MS = 3 * 24 * 60 * 60_000;
/** Profiles opened in a row start one speed probe per provider at most this often. */
const PROBE_GAP_MS = 10 * 60_000;

/** The marked name as the model wrote it, tidied: no brackets or pipes, sensible lengths. */
export function cleanEntity(raw: { name: string; kind?: string; hint?: string }): Entity | null {
  const tidy = (s: string, max: number) =>
    s
      .replace(/[[\]|\n\r]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  const name = tidy(raw.name, 80);
  if (!/[\p{L}\p{N}]/u.test(name)) return null;
  const kind = (raw.kind ?? "").trim().toLowerCase();
  return {
    name,
    kind: KINDS.includes(kind as EntityKind) ? (kind as EntityKind) : "thing",
    hint: tidy(raw.hint ?? "", 120),
  };
}

export const open = mutation({
  args: {
    /** The chat the name was tapped in: a normal chat, or another profile. */
    threadId: v.id("threads"),
    name: v.string(),
    kind: v.optional(v.string()),
    hint: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const from = await ownThread(ctx, args.threadId, userId);
    const entity = cleanEntity(args);
    if (!entity) throw new ConvexError("There's nothing to look up in that name.");
    const key = entityKey(entity);
    const last = await ctx.db
      .query("threads")
      .withIndex("by_user_entity", (q) => q.eq("userId", userId).eq("entityKey", key))
      .order("desc")
      .first();
    // An incognito chat's profile stays with incognito chats, and a normal one with normal ones.
    if (last && last.incognito === from.incognito && last._creationTime > Date.now() - FRESH_MS)
      return { threadId: last._id };

    // Profiles opened from inside a profile belong to the chat the first one came from, so they
    // all go when it does.
    const root = from.parentThreadId ? await ctx.db.get(from.parentThreadId) : from;
    const id = await ctx.db.insert("threads", {
      userId,
      title: entity.name,
      modelRef: await profileModel(ctx, userId, from.modelRef),
      mode: "chat",
      // A profile is a write-up from search results the user is waiting on, not a puzzle.
      reasoningLevel: "low",
      incognito: from.incognito,
      updatedAt: Date.now(),
      parentThreadId: root?._id ?? from._id,
      entity,
      entityKey: key,
    });
    await ctx.db.insert("messages", {
      threadId: id,
      userId,
      role: "user",
      parts: [{ id: uid("txt"), type: "text", text: profileRequest(entity, root?.title) }],
      status: "done",
    });
    await startReply(ctx, (await ctx.db.get(id))!, userId);
    return { threadId: id };
  },
});

/**
 * The model for a new profile: the one the user set for side work, or the chat's model unless
 * another of theirs on the same provider starts clearly sooner by the speed probe, which this
 * starts again when its readings are missing or old.
 */
async function profileModel(
  ctx: MutationCtx,
  userId: Id<"users">,
  chatRef: string
): Promise<string> {
  const chat = parseModelRef(chatRef);
  if (!chat) return chatRef;
  const providers = await ctx.db
    .query("providers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const worker = (await loadSettings(ctx, userId)).roleModels.worker;
  const w = worker ? parseModelRef(worker) : null;
  if (
    w &&
    providers.some(
      (p) =>
        p.providerId === w.providerId &&
        p.status !== "error" &&
        p.models.some((m) => m.id === w.modelId && m.kind === "chat")
    )
  )
    return worker!;

  const provider = providers.find((p) => p.providerId === chat.providerId);
  if (!provider || provider.status === "error") return chatRef;
  const profiles = await ctx.db
    .query("capabilityProfiles")
    .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", chat.providerId))
    .collect();
  const toolsOf = (id: string) =>
    (profiles.find((p) => p.modelId === id) ?? registryProfile(provider.baseUrl, id)).features
      .tools;
  const refs = speedCandidates(
    chatRef,
    provider.models.map((m) => ({ id: m.id, kind: m.kind, tools: toolsOf(m.id) }))
  );
  const speeds = await ctx.db
    .query("modelSpeeds")
    .withIndex("by_user_model", (q) => q.eq("userId", userId).eq("providerId", chat.providerId))
    .collect();
  const candidates = refs.map((ref) => ({
    ref,
    speed: speeds.find((s) => `${s.providerId}/${s.modelId}` === ref),
  }));
  const now = Date.now();
  if (
    speedsDue(candidates, now) &&
    (
      await countHit(ctx, [
        { key: `speed-probe:${userId}:${chat.providerId}`, limit: 1, windowMs: PROBE_GAP_MS },
      ])
    ).ok
  )
    await ctx.scheduler.runAfter(0, internal.engine.speed.probe, { userId, refs });
  return pickProfileModel(candidates, now);
}

/** Everything a profile sheet shows: the name with its photos and overview, and the chat. */
export const sheet = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await optionalUser(ctx);
    if (!userId) return null;
    const t = await ctx.db.get(threadId);
    if (!t || t.userId !== userId || !t.entity) return null;
    const rows = await threadMessages(ctx, threadId);
    return {
      entity: t.entity,
      messages: await Promise.all(rows.map((m) => clientMessage(ctx, m))),
    };
  },
});

export const setCard = internalMutation({
  args: { threadId: v.id("threads"), card: vEntityCard },
  handler: async (ctx, { threadId, card }) => {
    const t = await ctx.db.get(threadId);
    if (!t?.entity) return;
    await ctx.db.patch(threadId, { entity: { ...t.entity, card } });
  },
});
