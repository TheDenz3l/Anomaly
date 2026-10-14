import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
} from "./_generated/server";
import { optionalUser, requireUser } from "./lib/auth";
import { decryptSecret, encryptSecret, normalizeApiKey, secretHint } from "./lib/crypto";
import {
  normalizeEndpoint,
  probeFailure,
  probeImageEndpoint,
  readImageBalance,
  type ImageBalance,
  type ImageFlavor,
  type ImageProbe,
} from "./engine/image";
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

const vImageFlavor = v.union(v.literal("openai"), v.literal("chat"), v.literal("nanobanana"));
const vImageBalance = v.object({
  remaining: v.optional(v.number()),
  total: v.optional(v.number()),
  used: v.optional(v.number()),
  unit: v.string(),
  money: v.boolean(),
});

/** The saved image setup with its key in the clear, for actions that call the endpoint. */
async function imageSetup(
  ctx: ActionCtx,
  userId: Id<"users">
): Promise<{ baseUrl: string; key?: string; flavor: ImageFlavor } | null> {
  const g = (await ctx.runQuery(internal.settings.forUser, { userId })).imageGen;
  if (!g) return null;
  const { flavor } = normalizeEndpoint(g.baseUrl);
  return {
    baseUrl: g.baseUrl,
    key: g.keyCipher ? await decryptSecret(g.keyCipher) : undefined,
    flavor: flavor === "nanobanana" ? flavor : (g.flavor ?? flavor ?? "openai"),
  };
}

/** Reads the balance with the saved setup and records it; failures are recorded, not thrown. */
async function recheckBalance(ctx: ActionCtx, userId: Id<"users">): Promise<void> {
  const setup = await imageSetup(ctx, userId);
  if (!setup) return;
  try {
    const balance = await readImageBalance(setup.baseUrl, setup.key, setup.flavor);
    await ctx.runMutation(internal.settings.noteImageGen, { userId, balance });
  } catch (e) {
    await ctx.runMutation(internal.settings.noteImageGen, {
      userId,
      balanceError: probeFailure(e),
    });
  }
}

/**
 * Checks an image endpoint and key and lists the image models the key can use. Without a key it
 * tries the stored one, so an existing setup can be re-checked.
 */
export const probeImageGen = action({
  args: { baseUrl: v.string(), key: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ImageProbe> => {
    const userId = await requireUser(ctx);
    let endpoint: string;
    try {
      endpoint = normalizeEndpoint(args.baseUrl).baseUrl;
    } catch {
      throw new ConvexError("The endpoint needs to be a URL that starts with https://");
    }
    if (!/^https?:\/\//i.test(endpoint))
      throw new ConvexError("The endpoint needs to be a URL that starts with https://");
    let key = args.key ? normalizeApiKey(args.key) : undefined;
    if (!key) {
      const stored = (await ctx.runQuery(internal.settings.forUser, { userId })).imageGen;
      if (stored?.keyCipher) key = await decryptSecret(stored.keyCipher);
    }
    let probe: ImageProbe;
    try {
      probe = await probeImageEndpoint(args.baseUrl, key);
    } catch (e) {
      throw new ConvexError(probeFailure(e));
    }
    const saved = (await ctx.runQuery(internal.settings.forUser, { userId })).imageGen;
    if (!args.key && saved && normalizeEndpoint(saved.baseUrl).baseUrl === probe.baseUrl)
      await ctx.runMutation(internal.settings.noteImageGen, {
        userId,
        balance: probe.balance ?? null,
      });
    return probe;
  },
});

/**
 * The user's own image model. `key` left out keeps the stored key and "" clears it; `clear`
 * removes the whole setup.
 */
export const setImageGen = action({
  args: {
    baseUrl: v.optional(v.string()),
    model: v.optional(v.string()),
    key: v.optional(v.string()),
    flavor: v.optional(vImageFlavor),
    clear: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireUser(ctx);
    if (args.clear) {
      await ctx.runMutation(internal.settings.storeImageGen, { userId, value: null });
      return null;
    }
    let baseUrl: string;
    try {
      baseUrl = normalizeEndpoint(args.baseUrl ?? "").baseUrl;
    } catch {
      throw new ConvexError("The endpoint needs to be a URL that starts with https://");
    }
    const model = (args.model ?? "").trim();
    if (!/^https?:\/\/[^\s/]+/i.test(baseUrl))
      throw new ConvexError("The endpoint needs to be a URL that starts with https://");
    if (!model) throw new ConvexError("Add the model ID your endpoint expects.");
    const key = args.key === undefined ? undefined : normalizeApiKey(args.key);
    await ctx.runMutation(internal.settings.storeImageGen, {
      userId,
      value: {
        baseUrl,
        model,
        flavor: args.flavor,
        key:
          key === undefined
            ? undefined
            : key
              ? { cipher: await encryptSecret(key), hint: secretHint(key) }
              : null,
      },
    });
    await recheckBalance(ctx, userId);
    return null;
  },
});

export const storeImageGen = internalMutation({
  args: {
    userId: v.id("users"),
    value: v.union(
      v.null(),
      v.object({
        baseUrl: v.string(),
        model: v.string(),
        flavor: v.optional(vImageFlavor),
        /** Left out: keep the stored key. Null: no key. */
        key: v.optional(v.union(v.null(), v.object({ cipher: v.string(), hint: v.string() }))),
      })
    ),
  },
  handler: async (ctx, { userId, value }) => {
    const doc = await ensureSettings(ctx, userId);
    if (!value) {
      await ctx.db.patch(doc._id, { imageGen: undefined });
      return;
    }
    const prev = doc.imageGen;
    const kept = value.key === undefined ? prev : undefined;
    const keyCipher = kept ? kept.keyCipher : value.key?.cipher;
    // The month's count carries over; the balance only while it's the same key at the same place,
    // and the timing only for the same model.
    const sameAccount = kept !== undefined && prev?.baseUrl === value.baseUrl;
    // Convex values can't hold undefined: absent fields are left out rather than set to it.
    await ctx.db.patch(doc._id, {
      imageGen: {
        baseUrl: value.baseUrl,
        model: value.model,
        keyHint: kept ? kept.keyHint : (value.key?.hint ?? ""),
        ...(keyCipher ? { keyCipher } : {}),
        ...(value.flavor ? { flavor: value.flavor } : {}),
        ...(prev?.usage ? { usage: prev.usage } : {}),
        ...(sameAccount && prev?.balance ? { balance: prev.balance } : {}),
        ...(prev?.timing && prev.timing.model === value.model ? { timing: prev.timing } : {}),
      },
    });
  },
});

/** Reads the image key's balance again (Settings → Image generation → Refresh). */
export const refreshImageBalance = action({
  args: {},
  handler: async (ctx): Promise<null> => {
    const userId = await requireUser(ctx);
    await recheckBalance(ctx, userId);
    return null;
  },
});

/**
 * Records what an image cost and how long it took, and the key's balance as last read. A balance
 * that went up was topped up: the bar starts again from the new amount.
 */
export const noteImageGen = internalMutation({
  args: {
    userId: v.id("users"),
    model: v.optional(v.string()),
    ms: v.optional(v.number()),
    spent: v.optional(v.number()),
    /** Null: the service doesn't report a balance. */
    balance: v.optional(v.union(v.null(), vImageBalance)),
    balanceError: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const doc = await ensureSettings(ctx, a.userId);
    const g = doc.imageGen;
    if (!g) return;
    const now = Date.now();
    const next = { ...g };
    if (a.model && a.ms !== undefined) {
      const month = new Date(now).toISOString().slice(0, 7);
      const usage = g.usage?.month === month ? g.usage : { month, images: 0, spent: 0 };
      next.usage = { month, images: usage.images + 1, spent: usage.spent + (a.spent ?? 0) };
      const t = g.timing?.model === a.model ? g.timing : { model: a.model, avgMs: a.ms, n: 0 };
      const n = Math.min(t.n + 1, 8);
      next.timing = { model: a.model, avgMs: Math.round(t.avgMs + (a.ms - t.avgMs) / n), n };
    }
    if (a.balance === null) {
      next.balance = { status: "unsupported", unit: "", money: false, checkedAt: now };
    } else if (a.balance) {
      const b: ImageBalance = a.balance;
      const prev = g.balance?.status === "ok" && g.balance.unit === b.unit ? g.balance : undefined;
      const r = b.remaining;
      const peak =
        r === undefined
          ? undefined
          : prev?.remaining !== undefined && r <= prev.remaining
            ? Math.max(prev.peak ?? prev.remaining, r)
            : r;
      next.balance = {
        status: "ok",
        unit: b.unit,
        money: b.money,
        checkedAt: now,
        ...(r !== undefined ? { remaining: r } : {}),
        ...(b.total !== undefined ? { total: b.total } : {}),
        ...(b.used !== undefined ? { used: b.used } : {}),
        ...(peak !== undefined ? { peak } : {}),
      };
    } else if (a.balanceError) {
      next.balance = {
        ...(g.balance ?? { unit: "", money: false }),
        status: "error",
        error: a.balanceError,
        checkedAt: now,
      };
    }
    await ctx.db.patch(doc._id, { imageGen: next });
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
