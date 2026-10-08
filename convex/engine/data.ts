import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { registryProfile } from "../ai/registry";
import { loadSettings } from "../lib/settings";
import { parseModelRef } from "../lib/util";
import {
  vLocation,
  vMessageStatus,
  vPart,
  vReplyMeta,
  vSource,
  type CapabilityProfile,
} from "../lib/validators";

/** Reads and writes the engine needs from inside actions. */

const HISTORY_LIMIT = 60;

export const turnContext = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (!message) return null;
    const thread = await ctx.db.get(message.threadId);
    if (!thread) return null;
    const settings = await loadSettings(ctx, thread.userId);
    const before = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) =>
        q.eq("threadId", thread._id).lt("_creationTime", message._creationTime)
      )
      .order("desc")
      .take(HISTORY_LIMIT);
    return { message, thread, settings, history: before.reverse() };
  },
});

export const modelContext = internalQuery({
  args: { userId: v.id("users"), ref: v.string() },
  handler: async (ctx, { userId, ref }) => {
    const parsed = parseModelRef(ref);
    if (!parsed) return null;
    const provider = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", userId).eq("providerId", parsed.providerId)
      )
      .first();
    if (!provider) return null;
    const model = provider.models.find((m) => m.id === parsed.modelId) ?? null;
    const prof = await ctx.db
      .query("capabilityProfiles")
      .withIndex("by_user_model", (q) =>
        q.eq("userId", userId).eq("providerId", parsed.providerId).eq("modelId", parsed.modelId)
      )
      .first();
    const profile: CapabilityProfile = prof
      ? {
          reasoning: prof.reasoning,
          features: prof.features,
          params: prof.params,
          confidence: prof.confidence,
          source: prof.source,
          lastVerified: prof.lastVerified,
          version: prof.version,
        }
      : registryProfile(provider.baseUrl, parsed.modelId);
    return {
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      baseUrl: provider.baseUrl,
      keyCipher: provider.keyCipher,
      headersCipher: provider.headersCipher,
      contextWindow: model?.contextWindow ?? 32_768,
      pricing: model?.pricing,
      profile,
    };
  },
});

export const writeParts = internalMutation({
  args: {
    messageId: v.id("messages"),
    /** The run doing the writing; a reply that was regenerated since refuses it. */
    runId: v.optional(v.string()),
    parts: v.array(vPart),
    status: v.optional(vMessageStatus),
    meta: v.optional(vReplyMeta),
    error: v.optional(v.string()),
    searchText: v.optional(v.string()),
  },
  handler: async (ctx, { messageId, runId, parts, status, meta, error, searchText }) => {
    const m = await ctx.db.get(messageId);
    if (!m) return { stopped: true };
    if (m.runId && m.runId !== runId) return { stopped: true };
    const stopped = m.status === "stopped";
    const patch: Partial<Doc<"messages">> = { parts };
    if (status && !stopped) patch.status = status;
    if (meta) patch.meta = meta;
    if (error !== undefined) patch.error = error;
    if (searchText !== undefined) patch.searchText = searchText;
    await ctx.db.patch(messageId, patch);
    return { stopped };
  },
});

export const messageStatus = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => (await ctx.db.get(messageId))?.status ?? null,
});

export const setThreadMode = internalMutation({
  args: { threadId: v.id("threads"), mode: v.union(v.literal("chat"), v.literal("research")) },
  handler: async (ctx, { threadId, mode }) => {
    if (await ctx.db.get(threadId)) await ctx.db.patch(threadId, { mode });
  },
});

export const setThreadLocation = internalMutation({
  args: { threadId: v.id("threads"), location: vLocation },
  handler: async (ctx, { threadId, location }) => {
    if (await ctx.db.get(threadId)) await ctx.db.patch(threadId, { location });
  },
});

export const recordTurn = internalMutation({
  args: {
    messageId: v.id("messages"),
    reasoning: v.optional(
      v.object({
        modelRef: v.string(),
        levelRequested: v.string(),
        levelSent: v.string(),
        reasoningTokens: v.number(),
        outcome: v.string(),
      })
    ),
    sources: v.array(vSource),
  },
  handler: async (ctx, { messageId, reasoning, sources }) => {
    const m = await ctx.db.get(messageId);
    if (!m) return;
    if (reasoning) {
      await ctx.db.insert("reasoningEvents", {
        userId: m.userId,
        threadId: m.threadId,
        messageId,
        ...reasoning,
        ts: Date.now(),
      });
    }
    const existing = await ctx.db
      .query("sources")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    const seen = new Set(existing.map((s) => s.url));
    for (const s of sources) {
      if (seen.has(s.url)) continue;
      await ctx.db.insert("sources", {
        userId: m.userId,
        messageId,
        url: s.url,
        title: s.title,
        favicon: s.favicon,
        snippet: s.snippet,
        origin: s.origin,
      });
    }
  },
});

/**
 * Marks replies left "streaming" by a crashed or timed-out action as errors, along with a Deep
 * Research run whose progress reply that was.
 */
export const reapStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 20 * 60_000;
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_status", (q) => q.eq("status", "streaming"))
      .take(200);
    let n = 0;
    for (const m of rows) {
      if ((m.streamStartedAt ?? m._creationTime) < cutoff) {
        await ctx.db.patch(m._id, { status: "error", error: "The reply timed out." });
        const runs = await ctx.db
          .query("researchRuns")
          .withIndex("by_thread", (q) => q.eq("threadId", m.threadId))
          .order("desc")
          .take(10);
        for (const r of runs) {
          if (r.progressMessageId === m._id && ["running", "synthesizing"].includes(r.status))
            await ctx.db.patch(r._id, {
              status: "failed",
              error: "The research timed out.",
              finishedAt: Date.now(),
            });
        }
        n++;
      }
    }
    return n;
  },
});
