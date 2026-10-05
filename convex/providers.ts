import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { listModels, LlmError, type Endpoint } from "./ai/openai";
import {
  applyRemoteRules,
  contextWindowOf,
  displayName,
  modelKind,
  pricingOf,
  registryProfile,
  type RemoteRule,
} from "./ai/registry";
import { optionalUser, requireUser } from "./lib/auth";
import {
  decryptSecret,
  encryptSecret,
  maskHeaders,
  normalizeApiKey,
  secretHint,
} from "./lib/crypto";
import { endpointFor } from "./lib/endpoint";
import { errorMessage } from "./lib/util";
import { vHeader } from "./lib/validators";
import { webCache } from "./web/cache";
import { providerUrl } from "./web/guard";

/** Bring-your-own providers (PRD §3.4). Keys are encrypted and never returned to the client. */

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function publicProvider(p: Doc<"providers">) {
  return {
    providerId: p.providerId,
    label: p.label,
    baseUrl: p.baseUrl,
    keyHint: p.keyHint,
    headers: p.headerHints,
    status: p.status,
    lastError: p.lastError,
    modelCount: p.models.filter((m) => m.kind === "chat").length,
    modelsFetchedAt: p.modelsFetchedAt,
  };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await optionalUser(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("providers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.map(publicProvider);
  },
});

/**
 * Adds or updates a provider, then fetches its models. apiKey: omitted keeps the stored key,
 * "" clears it. Header values follow the same rule per header key.
 */
export const save = action({
  args: {
    providerId: v.string(),
    label: v.string(),
    baseUrl: v.string(),
    apiKey: v.optional(v.string()),
    headers: v.optional(v.array(vHeader)),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ status: "connected" | "error"; models: number; error?: string }> => {
    const userId = await requireUser(ctx);
    const providerId = args.providerId.trim().toLowerCase();
    if (!PROVIDER_ID.test(providerId)) {
      throw new ConvexError("Provider ID: lowercase letters, digits, - or _, up to 32 characters.");
    }
    const url = providerUrl(args.baseUrl.trim());
    const baseUrl = url.toString().replace(/\/+$/, "");
    const existing = await ctx.runQuery(internal.providers.getInternal, { userId, providerId });

    let keyCipher = existing?.keyCipher;
    let keyHint = existing?.keyHint ?? "none";
    if (args.apiKey !== undefined) {
      const k = normalizeApiKey(args.apiKey);
      keyCipher = k ? await encryptSecret(k) : undefined;
      keyHint = secretHint(k);
    }
    let headersCipher = existing?.headersCipher;
    let headerHints = existing?.headerHints ?? [];
    if (args.headers !== undefined) {
      const previous: { key: string; value: string }[] = existing?.headersCipher
        ? JSON.parse(await decryptSecret(existing.headersCipher))
        : [];
      const merged = args.headers
        .filter((h) => h.key.trim())
        .map((h) => {
          const prior = previous.find((p) => p.key === h.key);
          const masked = existing?.headerHints.find((p) => p.key === h.key)?.value;
          return { key: h.key.trim(), value: prior && h.value === masked ? prior.value : h.value };
        });
      headersCipher = merged.length ? await encryptSecret(JSON.stringify(merged)) : undefined;
      headerHints = maskHeaders(merged);
    }
    await ctx.runMutation(internal.providers.upsertInternal, {
      userId,
      providerId,
      label: args.label.trim() || providerId,
      baseUrl,
      keyCipher,
      keyHint,
      headersCipher,
      headerHints,
    });
    return await ctx.runAction(internal.providers.refreshInternal, { userId, providerId });
  },
});

export const remove = mutation({
  args: { providerId: v.string() },
  handler: async (ctx, { providerId }) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .first();
    if (!row) return;
    await ctx.db.delete(row._id);
    const profiles = await ctx.db
      .query("capabilityProfiles")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .collect();
    for (const p of profiles) await ctx.db.delete(p._id);
  },
});

export const refresh = action({
  args: { providerId: v.string() },
  handler: async (
    ctx,
    { providerId }
  ): Promise<{ status: "connected" | "error"; models: number; error?: string }> => {
    const userId = await requireUser(ctx);
    return await ctx.runAction(internal.providers.refreshInternal, { userId, providerId });
  },
});

async function remoteRules(ctx: Parameters<typeof webCache>[0]): Promise<RemoteRule[]> {
  const url = process.env.REGISTRY_URL;
  if (!url) return [];
  const cache = webCache(ctx);
  const hit = await cache.get(`registry:${url}`);
  if (hit) return JSON.parse(hit.content);
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    const rules: RemoteRule[] = Array.isArray(json)
      ? json
      : Array.isArray(json?.rules)
        ? json.rules
        : [];
    await cache.put(`registry:${url}`, JSON.stringify(rules), "application/json", 6 * 3600_000);
    return rules;
  } catch {
    return [];
  }
}

export const refreshInternal = internalAction({
  args: { userId: v.id("users"), providerId: v.string() },
  handler: async (
    ctx,
    { userId, providerId }
  ): Promise<{ status: "connected" | "error"; models: number; error?: string }> => {
    const ep: Endpoint | null = await endpointFor(ctx, userId, providerId);
    if (!ep) throw new ConvexError("Provider not found.");
    await ctx.runMutation(internal.providers.setStatus, { userId, providerId, status: "checking" });
    try {
      const raw = await listModels(ep);
      const rules = await remoteRules(ctx);
      const models = raw
        .filter((m) => typeof m?.id === "string" && m.id)
        .slice(0, 800)
        .map((m) => ({
          id: String(m.id),
          name: displayName(String(m.id), m),
          contextWindow: contextWindowOf(String(m.id), m),
          kind: modelKind(String(m.id), m),
          pricing: pricingOf(m),
          profile: applyRemoteRules(
            registryProfile(ep.baseUrl, String(m.id), m),
            ep.baseUrl,
            String(m.id),
            rules
          ),
        }));
      await ctx.runMutation(internal.providers.setModels, { userId, providerId, models });
      return { status: "connected", models: models.filter((m) => m.kind === "chat").length };
    } catch (e) {
      const msg =
        e instanceof LlmError && e.kind === "auth"
          ? "The provider rejected the API key."
          : e instanceof LlmError && e.kind === "not_found"
            ? "No /models endpoint at this base URL. Check it ends in /v1 (or the provider's equivalent)."
            : errorMessage(e);
      await ctx.runMutation(internal.providers.setStatus, {
        userId,
        providerId,
        status: "error",
        error: msg,
      });
      return { status: "error", models: 0, error: msg };
    }
  },
});

export const getInternal = internalQuery({
  args: { userId: v.id("users"), providerId: v.string() },
  handler: async (ctx, { userId, providerId }) =>
    await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .first(),
});

export const upsertInternal = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.string(),
    label: v.string(),
    baseUrl: v.string(),
    keyCipher: v.optional(v.string()),
    keyHint: v.string(),
    headersCipher: v.optional(v.string()),
    headerHints: v.array(vHeader),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", args.userId).eq("providerId", args.providerId)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, status: "checking", lastError: undefined });
    } else {
      await ctx.db.insert("providers", { ...args, status: "checking", models: [] });
    }
  },
});

export const setStatus = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.string(),
    status: v.union(v.literal("connected"), v.literal("error"), v.literal("checking")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { userId, providerId, status, error }) => {
    const row = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .first();
    if (row) await ctx.db.patch(row._id, { status, lastError: error });
  },
});

export const setModels = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.string(),
    models: v.array(v.any()),
  },
  handler: async (ctx, { userId, providerId, models }) => {
    const row = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .first();
    if (!row) return;
    await ctx.db.patch(row._id, {
      status: "connected",
      lastError: undefined,
      modelsFetchedAt: Date.now(),
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        kind: m.kind,
        ...(m.pricing ? { pricing: m.pricing } : {}),
      })),
    });
    const existing = await ctx.db
      .query("capabilityProfiles")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .collect();
    const byModel = new Map(existing.map((p) => [p.modelId, p]));
    for (const m of models) {
      if (m.kind !== "chat") continue;
      const prior = byModel.get(m.id);
      // Probe, learned and manual profiles carry evidence; only registry rows are refreshed.
      if (prior && prior.source !== "registry") continue;
      const profile = {
        ...m.profile,
        successStreak: prior?.successStreak ?? 0,
        noopStrikes: prior?.noopStrikes ?? 0,
      };
      if (prior) await ctx.db.patch(prior._id, { ...profile, version: prior.version + 1 });
      else
        await ctx.db.insert("capabilityProfiles", {
          userId,
          providerId,
          modelId: m.id,
          ...profile,
        });
    }
  },
});
