import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { registryProfile } from "./ai/registry";
import { optionalUser, requireUser } from "./lib/auth";
import { modelRef, parseModelRef } from "./lib/util";
import { vFeatures, vReasoning, type CapabilityProfile } from "./lib/validators";

/** Model list + capability profiles (PRD §3.5): registry → probe → learned → manual (final). */

function toProfile(p: Doc<"capabilityProfiles">): CapabilityProfile {
  return {
    reasoning: p.reasoning,
    features: p.features,
    params: p.params,
    confidence: p.confidence,
    source: p.source,
    lastVerified: p.lastVerified,
    version: p.version,
  };
}

async function profileDoc(ctx: QueryCtx, userId: Id<"users">, providerId: string, modelId: string) {
  return await ctx.db
    .query("capabilityProfiles")
    .withIndex("by_user_model", (q) =>
      q.eq("userId", userId).eq("providerId", providerId).eq("modelId", modelId)
    )
    .first();
}

export const list = query({
  args: { includeAll: v.optional(v.boolean()) },
  handler: async (ctx, { includeAll }) => {
    const userId = await optionalUser(ctx);
    if (!userId) return [];
    const providers = await ctx.db
      .query("providers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out = [];
    for (const p of providers) {
      const profiles = await ctx.db
        .query("capabilityProfiles")
        .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", p.providerId))
        .collect();
      const byId = new Map(profiles.map((x) => [x.modelId, x]));
      for (const m of p.models) {
        if (!includeAll && m.kind !== "chat") continue;
        const prof = byId.get(m.id);
        out.push({
          id: m.id,
          name: m.name,
          providerId: p.providerId,
          providerLabel: p.label,
          ref: modelRef(p.providerId, m.id),
          kind: m.kind,
          contextWindow: m.contextWindow,
          pricing: m.pricing,
          profile: prof ? toProfile(prof) : registryProfile(p.baseUrl, m.id),
        });
      }
    }
    return out;
  },
});

/** Manual override (PRD §3.5 step 4): final, never overwritten by probes or learning. */
export const setOverride = mutation({
  args: {
    ref: v.string(),
    reasoning: v.optional(vReasoning),
    features: v.optional(
      v.object({
        vision: v.optional(v.boolean()),
        tools: v.optional(v.boolean()),
        streaming: v.optional(v.boolean()),
        reasoningText: v.optional(v.boolean()),
        audio: v.optional(v.boolean()),
        webSearch: v.optional(v.boolean()),
      })
    ),
  },
  handler: async (ctx, { ref, reasoning, features }) => {
    const userId = await requireUser(ctx);
    const parsed = parseModelRef(ref);
    if (!parsed) throw new ConvexError("Unknown model.");
    const provider = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", userId).eq("providerId", parsed.providerId)
      )
      .first();
    if (!provider) throw new ConvexError("Unknown provider.");
    if (reasoning && reasoning.style !== "none" && reasoning.levels.length === 0) {
      throw new ConvexError("Add at least one reasoning level, or set the style to none.");
    }
    const prior = await profileDoc(ctx, userId, parsed.providerId, parsed.modelId);
    const base = prior ? toProfile(prior) : registryProfile(provider.baseUrl, parsed.modelId);
    const next = {
      reasoning: reasoning ?? base.reasoning,
      features: {
        ...base.features,
        ...Object.fromEntries(
          Object.entries(features ?? {}).filter(([, val]) => val !== undefined)
        ),
      },
      params: base.params,
      confidence: 1,
      source: "manual" as const,
      lastVerified: Date.now(),
      version: base.version + 1,
      manualReasoning: reasoning !== undefined || prior?.manualReasoning === true,
    };
    if (prior) await ctx.db.patch(prior._id, next);
    else
      await ctx.db.insert("capabilityProfiles", {
        userId,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
        ...next,
        successStreak: 0,
        noopStrikes: 0,
      });
  },
});

export const clearOverride = mutation({
  args: { ref: v.string() },
  handler: async (ctx, { ref }) => {
    const userId = await requireUser(ctx);
    const parsed = parseModelRef(ref);
    if (!parsed) return;
    const provider = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", userId).eq("providerId", parsed.providerId)
      )
      .first();
    const prior = await profileDoc(ctx, userId, parsed.providerId, parsed.modelId);
    if (!provider || !prior) return;
    const fresh = registryProfile(provider.baseUrl, parsed.modelId);
    await ctx.db.patch(prior._id, {
      ...fresh,
      version: prior.version + 1,
      successStreak: 0,
      noopStrikes: 0,
      manualReasoning: undefined,
    });
  },
});

export const profileInternal = internalQuery({
  args: { userId: v.id("users"), providerId: v.string(), modelId: v.string() },
  handler: async (ctx, { userId, providerId, modelId }): Promise<CapabilityProfile | null> => {
    const prof = await profileDoc(ctx, userId, providerId, modelId);
    if (prof) return toProfile(prof);
    const provider = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .first();
    return provider ? registryProfile(provider.baseUrl, modelId) : null;
  },
});

const vLearnEvent = v.union(
  v.object({ kind: v.literal("param_rejected"), param: v.string() }),
  v.object({
    kind: v.literal("reasoning_tokens"),
    levelSent: v.string(),
    tokens: v.number(),
    reported: v.boolean(),
  }),
  v.object({ kind: v.literal("reasoning_text_seen") }),
  v.object({ kind: v.literal("success") }),
  v.object({
    kind: v.literal("max_tokens_field"),
    field: v.union(v.literal("max_tokens"), v.literal("max_completion_tokens")),
  })
);

/**
 * Learning from live traffic (PRD §3.5 step 3): rejected params downgrade the profile,
 * zero reasoning tokens twice in a row mark the level control a no-op, success streaks raise
 * confidence. Manual profiles are never touched.
 */
export const learn = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.string(),
    modelId: v.string(),
    events: v.array(vLearnEvent),
  },
  handler: async (ctx, { userId, providerId, modelId, events }) => {
    let prof = await profileDoc(ctx, userId, providerId, modelId);
    if (!prof) {
      const provider = await ctx.db
        .query("providers")
        .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
        .first();
      if (!provider) return;
      const id = await ctx.db.insert("capabilityProfiles", {
        userId,
        providerId,
        modelId,
        ...registryProfile(provider.baseUrl, modelId),
        successStreak: 0,
        noopStrikes: 0,
      });
      prof = (await ctx.db.get(id))!;
    }
    if (prof.source === "manual") return;
    const next = {
      reasoning: { ...prof.reasoning },
      features: { ...prof.features },
      params: { ...(prof.params ?? {}) },
      confidence: prof.confidence,
      successStreak: prof.successStreak,
      noopStrikes: prof.noopStrikes,
    };
    let changed = false;
    for (const ev of events) {
      switch (ev.kind) {
        case "param_rejected": {
          changed = true;
          next.successStreak = 0;
          if (
            ["reasoning", "reasoning_effort", "thinking", "chat_template_kwargs"].includes(ev.param)
          ) {
            next.reasoning = { style: "none", levels: [], defaultLevel: "off" };
            next.confidence = Math.min(next.confidence, 0.7);
          } else if (ev.param === "tools" || ev.param === "tool_choice") {
            next.features.tools = false;
          } else if (ev.param === "image_url") {
            next.features.vision = false;
          } else if (ev.param === "plugins" || ev.param === "web_search_options") {
            next.features.webSearch = false;
            delete next.params.nativeSearch;
          } else if (ev.param === "stream_options") {
            next.params.streamUsage = false;
          }
          break;
        }
        case "max_tokens_field":
          next.params.maxTokensField = ev.field;
          changed = true;
          break;
        case "reasoning_tokens": {
          if (
            !ev.reported ||
            ["off", "none"].includes(ev.levelSent) ||
            next.reasoning.style === "none"
          )
            break;
          if (ev.tokens === 0) {
            next.noopStrikes += 1;
            if (next.noopStrikes >= 2 && !next.reasoning.noop) {
              next.reasoning.noop = true;
              changed = true;
            }
          } else {
            if (next.reasoning.noop) changed = true;
            next.noopStrikes = 0;
            next.reasoning.noop = false;
          }
          break;
        }
        case "reasoning_text_seen":
          if (!next.features.reasoningText) {
            next.features.reasoningText = true;
            changed = true;
          }
          break;
        case "success":
          next.successStreak += 1;
          if (next.successStreak % 5 === 0 && next.confidence < 0.99) {
            next.confidence = Math.min(0.99, Math.round((next.confidence + 0.02) * 100) / 100);
            changed = true;
          }
          break;
      }
    }
    await ctx.db.patch(prof._id, {
      ...next,
      ...(changed
        ? { source: "learned" as const, version: prof.version + 1, lastVerified: Date.now() }
        : {}),
    });
  },
});

export const applyProbeResult = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.string(),
    modelId: v.string(),
    reasoning: v.optional(vReasoning),
    features: v.optional(vFeatures),
    maxTokensField: v.optional(
      v.union(v.literal("max_tokens"), v.literal("max_completion_tokens"))
    ),
    confidence: v.number(),
  },
  handler: async (ctx, a) => {
    const prof = await profileDoc(ctx, a.userId, a.providerId, a.modelId);
    if (prof?.source === "manual") {
      // Hand-set features stay; reasoning is still detected unless it was set by hand too.
      if (!prof.manualReasoning && a.reasoning) {
        await ctx.db.patch(prof._id, {
          reasoning: a.reasoning,
          params: {
            ...(prof.params ?? {}),
            ...(a.maxTokensField ? { maxTokensField: a.maxTokensField } : {}),
          },
          lastVerified: Date.now(),
          version: prof.version + 1,
        });
      }
      return;
    }
    const provider = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", a.userId).eq("providerId", a.providerId))
      .first();
    if (!provider) return;
    const base = prof ? toProfile(prof) : registryProfile(provider.baseUrl, a.modelId);
    const next = {
      reasoning: a.reasoning ?? base.reasoning,
      features: a.features ?? base.features,
      params: {
        ...(base.params ?? {}),
        ...(a.maxTokensField ? { maxTokensField: a.maxTokensField } : {}),
      },
      confidence: a.confidence,
      source: "probe" as const,
      lastVerified: Date.now(),
      version: base.version + 1,
    };
    if (prof) await ctx.db.patch(prof._id, next);
    else
      await ctx.db.insert("capabilityProfiles", {
        userId: a.userId,
        providerId: a.providerId,
        modelId: a.modelId,
        ...next,
        successStreak: 0,
        noopStrikes: 0,
      });
  },
});

/**
 * Re-derives every registry-sourced profile from the current registry rules. Those rows hold no
 * evidence, only the registry's guess, so run this after the rules improve.
 */
/**
 * Re-derives profiles that hold no evidence from the current registry rules: registry rows, and
 * probe or feature-only manual rows whose model was never actually probed (a run the spend cap
 * skipped used to record "no reasoning"). Repaired models get checked again on their next pick.
 */
export const refreshRegistryProfiles = internalMutation({
  args: {},
  handler: async (ctx) => {
    const baseUrls = new Map<string, string>();
    let updated = 0;
    for await (const prof of ctx.db.query("capabilityProfiles")) {
      const manualFeatures = prof.source === "manual" && !prof.manualReasoning;
      if (prof.source !== "registry" && prof.source !== "probe" && !manualFeatures) continue;
      const logs = await ctx.db
        .query("probeLogs")
        .withIndex("by_user_model", (q) =>
          q.eq("userId", prof.userId).eq("providerId", prof.providerId).eq("modelId", prof.modelId)
        )
        .collect();
      if (prof.source !== "registry" && logs.some((l) => l.probe !== "auto")) continue;
      const key = `${prof.userId}:${prof.providerId}`;
      let baseUrl = baseUrls.get(key);
      if (baseUrl === undefined) {
        const provider = await ctx.db
          .query("providers")
          .withIndex("by_user_provider", (q) =>
            q.eq("userId", prof.userId).eq("providerId", prof.providerId)
          )
          .first();
        baseUrl = provider?.baseUrl ?? "";
        baseUrls.set(key, baseUrl);
      }
      if (!baseUrl) continue;
      const fresh = registryProfile(baseUrl, prof.modelId);
      if (manualFeatures) {
        await ctx.db.patch(prof._id, { reasoning: fresh.reasoning, version: prof.version + 1 });
      } else {
        await ctx.db.patch(prof._id, {
          reasoning: fresh.reasoning,
          features: fresh.features,
          params: fresh.params,
          confidence: fresh.confidence,
          source: "registry",
          lastVerified: Date.now(),
          version: prof.version + 1,
        });
      }
      if (prof.source !== "registry") for (const l of logs) await ctx.db.delete(l._id);
      updated++;
    }
    return updated;
  },
});

export const reasoningLocked = internalQuery({
  args: { userId: v.id("users"), providerId: v.string(), modelId: v.string() },
  handler: async (ctx, { userId, providerId, modelId }) =>
    (await profileDoc(ctx, userId, providerId, modelId))?.manualReasoning === true,
});
