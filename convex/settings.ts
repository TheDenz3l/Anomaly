import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { optionalUser, requireUser } from "./lib/auth";
import { encryptSecret, normalizeApiKey, secretHint } from "./lib/crypto";
import { DEFAULT_SETTINGS, ensureSettings, loadSettings, publicSettings } from "./lib/settings";
import {
  vRoleModels,
  vSearchProvider,
  vSubagentMode,
  vVoiceMode,
  vWebMode,
} from "./lib/validators";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = await optionalUser(ctx);
    if (!userId) return publicSettings(DEFAULT_SETTINGS);
    return publicSettings(await loadSettings(ctx, userId));
  },
});

export const update = mutation({
  args: {
    customInstructions: v.optional(v.string()),
    memoryEnabled: v.optional(v.boolean()),
    subagentMode: v.optional(vSubagentMode),
    webMode: v.optional(vWebMode),
    searchProvider: v.optional(vSearchProvider),
    searchUrl: v.optional(v.string()),
    voiceInput: v.optional(vVoiceMode),
    voiceOutput: v.optional(vVoiceMode),
    voiceId: v.optional(v.string()),
    readRepliesAloud: v.optional(v.boolean()),
    probeSpendCapUsd: v.optional(v.number()),
    defaultModelRef: v.optional(v.string()),
    researchModelRef: v.optional(v.union(v.string(), v.null())),
    embeddingModelRef: v.optional(v.union(v.string(), v.null())),
    transcriptionModelRef: v.optional(v.union(v.string(), v.null())),
    speechModelRef: v.optional(v.union(v.string(), v.null())),
    roleModels: v.optional(vRoleModels),
    researchCostCapUsd: v.optional(v.number()),
    thinkingLevel: v.optional(v.string()),
    resetProbeSpend: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const doc = await ensureSettings(ctx, userId);
    const { resetProbeSpend, ...patch } = args;
    if (patch.customInstructions !== undefined && patch.customInstructions.length > 4000) {
      throw new ConvexError("Custom instructions are limited to 4,000 characters.");
    }
    if (
      patch.probeSpendCapUsd !== undefined &&
      (patch.probeSpendCapUsd < 0 || patch.probeSpendCapUsd > 5)
    ) {
      throw new ConvexError("Probe spend cap must be between $0 and $5.");
    }
    if (patch.searchUrl !== undefined && patch.searchUrl && !/^https?:\/\//.test(patch.searchUrl)) {
      throw new ConvexError("Search URL must start with http:// or https://");
    }
    await ctx.db.patch(doc._id, { ...patch, ...(resetProbeSpend ? { probeSpentUsd: 0 } : {}) });
    if (
      patch.embeddingModelRef !== undefined &&
      patch.embeddingModelRef !== doc.embeddingModelRef
    ) {
      await ctx.scheduler.runAfter(0, internal.memories.reembedAll, { userId });
    }
  },
});

/** Stores the app-side search key (Brave/Tavily/Firecrawl) encrypted. Empty string clears it. */
export const setSearchKey = action({
  args: { provider: vSearchProvider, key: v.string(), url: v.optional(v.string()) },
  handler: async (ctx, { provider, key, url }): Promise<{ hint: string }> => {
    const userId = await requireUser(ctx);
    const trimmed = normalizeApiKey(key);
    const cipher = trimmed ? await encryptSecret(trimmed) : undefined;
    const hint = trimmed ? secretHint(trimmed) : (url ?? "");
    await ctx.runMutation(internal.settings.storeSearchKey, {
      userId,
      provider,
      cipher,
      hint,
      url,
    });
    return { hint };
  },
});

export const storeSearchKey = internalMutation({
  args: {
    userId: v.id("users"),
    provider: vSearchProvider,
    cipher: v.optional(v.string()),
    hint: v.string(),
    url: v.optional(v.string()),
  },
  handler: async (ctx, { userId, provider, cipher, hint, url }) => {
    const doc = await ensureSettings(ctx, userId);
    await ctx.db.patch(doc._id, {
      searchProvider: provider,
      searchKeyCipher: cipher,
      searchKeyHint: hint,
      ...(url !== undefined ? { searchUrl: url } : {}),
    });
  },
});

export const registerPushToken = mutation({
  args: { token: v.union(v.string(), v.null()) },
  handler: async (ctx, { token }) => {
    const userId = await requireUser(ctx);
    if (token && !/^Expo(nent)?PushToken\[.+\]$/.test(token))
      throw new ConvexError("Not an Expo push token.");
    const doc = await ensureSettings(ctx, userId);
    await ctx.db.patch(doc._id, { pushToken: token ?? undefined });
  },
});

/** Full settings including ciphertexts — engine only. */
export const forUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => loadSettings(ctx, userId),
});

export const addProbeSpend = internalMutation({
  args: { userId: v.id("users"), usd: v.number() },
  handler: async (ctx, { userId, usd }) => {
    const doc = await ensureSettings(ctx, userId);
    await ctx.db.patch(doc._id, { probeSpentUsd: doc.probeSpentUsd + usd });
  },
});

export const resetProbeSpendAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    for await (const doc of ctx.db.query("settings")) {
      if (doc.probeSpentUsd > 0) await ctx.db.patch(doc._id, { probeSpentUsd: 0 });
    }
  },
});
