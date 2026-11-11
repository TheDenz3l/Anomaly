import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { LlmError, streamChat, type Endpoint } from "./ai/openai";
import { buildRequest } from "./ai/reasoning";
import { registryProfile } from "./ai/registry";
import { requireUser } from "./lib/auth";
import { endpointFor } from "./lib/endpoint";
import {
  CHECK_TIMEOUT_MS,
  foldReading,
  readCheck,
  type CheckOutcome,
  type HealthReading,
  type HealthStatus,
} from "./lib/health";
import { errorMessage, sleep } from "./lib/util";
import { vHealthStatus, type CapabilityProfile } from "./lib/validators";

/**
 * Model status checks: one tiny request per model (a few tokens in, the first words out), run when
 * the provider's page opens and its readings are stale, when the model list is sorted by speed, or
 * on Refresh. Each reading also times the model: how long to the first streamed event and to the
 * first answer text.
 */

/** A model checked this recently is skipped unless the check is forced. */
const FRESH_MS = 2 * 60_000;
/** Checks at once per provider; relays slow down when handed many requests together. */
const PARALLEL = 8;
/** A real reply that worked only rewrites a normal reading this old, unless it brings a timing. */
const REPLY_REFRESH_MS = 10 * 60_000;
/** Once a model has started streaming, how long a check waits for its first answer text. */
const TEXT_WAIT_MS = 5_000;
/** A failure that may pass is tried again no sooner than this. */
const RETRY_GAP_MS = 1500;

const vReading = v.object({
  status: vHealthStatus,
  detail: v.optional(v.string()),
  latencyMs: v.optional(v.number()),
  textMs: v.optional(v.number()),
  transient: v.optional(v.boolean()),
});

type Target = {
  modelId: string;
  profile: CapabilityProfile;
  checkedAt: number;
  status?: HealthStatus;
  latencyMs?: number;
};

export const targets = internalQuery({
  args: { userId: v.id("users"), providerId: v.string() },
  handler: async (ctx, { userId, providerId }): Promise<Target[] | null> => {
    const provider = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .first();
    if (!provider) return null;
    const byProvider = (q: any) => q.eq("userId", userId).eq("providerId", providerId);
    const profiles = await ctx.db
      .query("capabilityProfiles")
      .withIndex("by_user_provider", byProvider)
      .collect();
    const health = await ctx.db
      .query("modelHealth")
      .withIndex("by_user_provider", byProvider)
      .collect();
    const profileOf = new Map(profiles.map((p) => [p.modelId, p]));
    const healthOf = new Map(health.map((h) => [h.modelId, h]));
    return provider.models
      .filter((m) => m.kind === "chat")
      .map((m) => {
        const p = profileOf.get(m.id);
        const h = healthOf.get(m.id);
        const profile: CapabilityProfile = p
          ? {
              reasoning: p.reasoning,
              features: p.features,
              params: p.params,
              confidence: p.confidence,
              source: p.source,
              lastVerified: p.lastVerified,
              version: p.version,
            }
          : registryProfile(provider.baseUrl, m.id);
        return {
          modelId: m.id,
          profile,
          checkedAt: h?.checkedAt ?? 0,
          status: h?.status,
          latencyMs: h?.latencyMs,
        };
      });
  },
});

export const providerIds = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<string[]> => {
    const rows = await ctx.db
      .query("providers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.map((p) => p.providerId);
  },
});

export const record = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.string(),
    modelId: v.string(),
    reading: vReading,
    /** A check already retried; a real reply's first failure is only a strike. */
    confirmed: v.boolean(),
    source: v.union(v.literal("check"), v.literal("reply")),
  },
  handler: async (ctx, { userId, providerId, modelId, reading, confirmed, source }) => {
    const row = await ctx.db
      .query("modelHealth")
      .withIndex("by_user_model", (q) =>
        q.eq("userId", userId).eq("providerId", providerId).eq("modelId", modelId)
      )
      .first();
    const now = Date.now();
    if (
      source === "reply" &&
      reading.status === "normal" &&
      reading.latencyMs === undefined &&
      row?.status === "normal" &&
      now - row.checkedAt < REPLY_REFRESH_MS
    )
      return;
    const next = foldReading(row, reading, confirmed);
    const doc = { ...next, checkedAt: now, source };
    if (row) await ctx.db.replace(row._id, { userId, providerId, modelId, ...doc });
    else await ctx.db.insert("modelHealth", { userId, providerId, modelId, ...doc });
  },
});

/**
 * Sends the smallest reply request the model takes and times it: to the first streamed event,
 * then (for a few seconds more at most) to the first answer text.
 */
async function ping(
  ep: Endpoint,
  modelId: string,
  profile: CapabilityProfile
): Promise<CheckOutcome> {
  const levels = profile.reasoning.levels;
  const level = ["off", "none", "minimal", "low"].find((l) => levels.includes(l)) ?? "low";
  const built = buildRequest({
    model: modelId,
    profile,
    level,
    difficulty: "easy",
    messages: [{ role: "user", content: "Reply with OK." }],
    maxTokens: 16,
  });
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, CHECK_TIMEOUT_MS);
  let wait: ReturnType<typeof setTimeout> | undefined;
  let firstMs: number | undefined;
  let textMs: number | undefined;
  const sent = Date.now();
  try {
    for await (const ev of streamChat(ep, built.body, stop.signal, CHECK_TIMEOUT_MS)) {
      const at = Date.now() - sent;
      if (firstMs === undefined) {
        firstMs = at;
        clearTimeout(timer);
        wait = setTimeout(() => stop.abort(), TEXT_WAIT_MS);
      }
      if (ev.type === "text" && ev.delta.trim()) {
        textMs = at;
        break;
      }
    }
    if (firstMs !== undefined) return { ok: true, firstMs, textMs };
    return timedOut ? { ok: false, timedOut: true } : { ok: true, firstMs: Date.now() - sent };
  } catch (e) {
    // It had started answering: the wait for its first words ran out, or the stream broke off.
    if (firstMs !== undefined) return { ok: true, firstMs };
    if (timedOut) return { ok: false, timedOut: true };
    if (e instanceof LlmError) return { ok: false, kind: e.kind, status: e.status, body: e.body };
    return { ok: false, kind: "network", status: 0, body: errorMessage(e) };
  } finally {
    clearTimeout(timer);
    clearTimeout(wait);
    // The first words are all a reading needs.
    stop.abort();
  }
}

/** Runs `fn` over the items, a few at a time. */
async function pooled<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let m = queue.shift(); m !== undefined; m = queue.shift()) await fn(m);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
}

/**
 * Models that answered last time go first, quickest first, so the list fills in fast; ones that
 * were down go last, where their timeouts hold nothing up.
 */
export function checkOrder<T extends { status?: HealthStatus; latencyMs?: number }>(
  list: T[]
): T[] {
  const rank = (m: T) => (m.status === "down" ? 2 : m.status === undefined ? 1 : 0);
  return [...list].sort(
    (a, b) => rank(a) - rank(b) || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)
  );
}

/** The provider's models that are due a check, or null when the provider is gone. */
async function dueFor(
  ctx: ActionCtx,
  userId: Id<"users">,
  providerId: string,
  force?: boolean
): Promise<Target[] | null> {
  const list = await ctx.runQuery(internal.health.targets, { userId, providerId });
  if (!list) return null;
  const now = Date.now();
  return checkOrder(list.filter((m) => force || now - m.checkedAt > FRESH_MS));
}

/**
 * Checks the models and stores each reading as it comes in. A failure that may pass gets one more
 * try, so a single dropped request doesn't read as down; those second tries run after everything
 * else, so waiting on them never holds up a model that hasn't been checked yet.
 */
async function runChecks(
  ctx: ActionCtx,
  userId: Id<"users">,
  providerId: string,
  due: Target[]
): Promise<boolean> {
  const ep = await endpointFor(ctx, userId, providerId);
  if (!ep) return false;
  const save = async (modelId: string, reading: HealthReading) => {
    await ctx.runMutation(internal.health.record, {
      userId,
      providerId,
      modelId,
      reading,
      confirmed: true,
      source: "check",
    });
  };
  const again: { target: Target; failedAt: number }[] = [];
  await pooled(due, async (m) => {
    const first = readCheck(await ping(ep, m.modelId, m.profile));
    if (first.status === "normal" || !first.transient || first.detail?.startsWith("No response"))
      return save(m.modelId, first);
    again.push({ target: m, failedAt: Date.now() });
  });
  await pooled(again, async ({ target: m, failedAt }) => {
    const gap = RETRY_GAP_MS - (Date.now() - failedAt);
    if (gap > 0) await sleep(gap);
    const second = readCheck(await ping(ep, m.modelId, m.profile));
    await save(
      m.modelId,
      second.status === "normal"
        ? { ...second, status: "degraded", detail: "Failed once, then answered" }
        : second
    );
  });
  return true;
}

async function allowChecks(ctx: ActionCtx, userId: Id<"users">): Promise<void> {
  const allowed = await ctx.runMutation(internal.rateLimit.hit, {
    limits: [{ key: `health:${userId}`, limit: 12, windowMs: 10 * 60_000 }],
  });
  if (!allowed.ok) {
    throw new ConvexError("Statuses were checked a lot just now. Try again in a few minutes.");
  }
}

export const check = action({
  args: { providerId: v.string(), force: v.optional(v.boolean()) },
  handler: async (ctx, { providerId, force }): Promise<{ checked: number }> => {
    const userId = await requireUser(ctx);
    const due = await dueFor(ctx, userId, providerId, force);
    if (!due) throw new ConvexError("This provider is gone. Close the sheet and try again.");
    if (!due.length) return { checked: 0 };
    await allowChecks(ctx, userId);
    if (!(await runChecks(ctx, userId, providerId, due)))
      throw new ConvexError("This provider is gone. Close the sheet and try again.");
    return { checked: due.length };
  },
});

/** Checks every provider's due models at once, each provider with its own set of requests. */
export const checkAll = action({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }): Promise<{ checked: number }> => {
    const userId = await requireUser(ctx);
    const ids = await ctx.runQuery(internal.health.providerIds, { userId });
    const lists = await Promise.all(
      ids.map(async (providerId) => ({
        providerId,
        due: (await dueFor(ctx, userId, providerId, force)) ?? [],
      }))
    );
    const busy = lists.filter((l) => l.due.length > 0);
    if (!busy.length) return { checked: 0 };
    await allowChecks(ctx, userId);
    const ran = await Promise.all(
      busy.map((l) =>
        runChecks(ctx, userId, l.providerId, l.due).catch((e) => {
          console.warn(`health ${l.providerId}: ${errorMessage(e)}`);
          return false;
        })
      )
    );
    return { checked: busy.reduce((n, l, i) => n + (ran[i] ? l.due.length : 0), 0) };
  },
});

/**
 * A real reply's outcome as a reading: worked (with how fast it started, when known), or failed at
 * the provider. Other failures say nothing.
 */
export async function recordReply(
  ctx: ActionCtx,
  userId: Id<"users">,
  providerId: string,
  modelId: string,
  error?: unknown,
  timing?: { firstMs?: number; textMs?: number }
): Promise<void> {
  let reading: HealthReading;
  if (error === undefined) {
    reading = {
      status: "normal",
      ...(timing?.firstMs === undefined ? {} : { latencyMs: timing.firstMs }),
      ...(timing?.textMs === undefined ? {} : { textMs: timing.textMs }),
    };
  } else if (error instanceof LlmError) {
    reading = readCheck({ ok: false, kind: error.kind, status: error.status, body: error.body });
  } else return;
  await ctx
    .runMutation(internal.health.record, {
      userId,
      providerId,
      modelId,
      reading,
      confirmed: false,
      source: "reply",
    })
    .catch((e) => console.warn(`health ${providerId}/${modelId}: ${errorMessage(e)}`));
}
