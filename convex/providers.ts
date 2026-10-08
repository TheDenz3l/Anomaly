import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
} from "./_generated/server";
import { fetchBalance } from "./ai/balance";
import {
  CHATGPT_BASE,
  CHATGPT_VERIFY_URL,
  ChatgptAuthError,
  chatgptHeaders,
  fetchChatgptLimits,
  listChatgptModels,
  pollDeviceAuth,
  refreshTokens,
  REFRESH_EARLY_MS,
  startDeviceAuth,
  type ChatgptTokens,
} from "./ai/chatgpt";
import { isCodex } from "./ai/codex";
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
import { vHeader, vProviderBalance, vProviderLimits } from "./lib/validators";
import { webCache } from "./web/cache";
import { providerUrl } from "./web/guard";

/** Bring-your-own providers (PRD §3.4). Keys are encrypted and never returned to the client. */

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

type Header = { key: string; value: string };

/**
 * Headers as sent by the app, with saved secrets restored. The app sends back masked values for
 * headers the user didn't change, so a value equal to a saved header's mask keeps that header's
 * real value, even when the key was renamed or padded with spaces. Keys are trimmed.
 */
export function mergeHeaders(sent: Header[], previous: Header[], hints: Header[]): Header[] {
  const maskOf = (p: Header) => hints.find((h) => h.key === p.key)?.value;
  return sent
    .map((h) => ({ key: h.key.trim(), value: h.value }))
    .filter((h) => h.key)
    .map((h) => {
      const matches = previous.filter((p) => maskOf(p) === h.value);
      const prior =
        matches.find((p) => p.key.trim().toLowerCase() === h.key.toLowerCase()) ?? matches[0];
      return { key: h.key, value: prior ? prior.value : h.value };
    });
}

/** Masks of saved headers whose real value is hidden, i.e. the secrets. */
function secretMasks(previous: Header[], hints: Header[]): string[] {
  return previous.flatMap((p) => {
    const mask = hints.find((h) => h.key === p.key)?.value;
    return mask !== undefined && mask !== p.value ? [mask] : [];
  });
}

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
    balance: p.balance,
    usage: p.usage,
    subscription: p.auth
      ? { vendor: p.auth.type, email: p.auth.email, plan: p.auth.plan ?? p.limits?.plan }
      : undefined,
    limits: p.limits,
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
    if (existing?.auth) {
      throw new ConvexError(
        "This provider is a ChatGPT sign-in. Sign out and in again to change it."
      );
    }
    // A saved key and header secrets belong to the host they were entered for.
    const moved = existing ? new URL(existing.baseUrl).host !== new URL(baseUrl).host : false;
    if (moved && args.apiKey === undefined && existing?.keyCipher) {
      throw new ConvexError(
        "The base URL now points to a different host. Paste the API key again to use it there."
      );
    }

    let keyCipher = existing?.keyCipher;
    let keyHint = existing?.keyHint ?? "none";
    if (args.apiKey !== undefined) {
      const k = normalizeApiKey(args.apiKey);
      keyCipher = k ? await encryptSecret(k) : undefined;
      keyHint = secretHint(k);
    }
    let headersCipher = existing?.headersCipher;
    let headerHints = existing?.headerHints ?? [];
    if (args.headers !== undefined || moved) {
      const previous: Header[] = existing?.headersCipher
        ? JSON.parse(await decryptSecret(existing.headersCipher))
        : [];
      const hints = existing?.headerHints ?? [];
      const masks = secretMasks(previous, hints);
      if (
        moved &&
        masks.length &&
        (args.headers === undefined || args.headers.some((h) => masks.includes(h.value)))
      ) {
        throw new ConvexError(
          "The base URL now points to a different host. Type the header values again to use them there."
        );
      }
      if (args.headers !== undefined) {
        const merged = mergeHeaders(args.headers, previous, hints);
        headersCipher = merged.length ? await encryptSecret(JSON.stringify(merged)) : undefined;
        headerHints = maskHeaders(merged);
      }
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

/** The /models request got the site's HTML (or nothing) instead of the API's JSON. */
function isWebPage(e: unknown): boolean {
  return e instanceof LlmError && e.message === "Provider returned non-JSON";
}

/**
 * Lists the endpoint's models. People often paste the site's address (api.example.com) rather
 * than the API's base (api.example.com/v1), which answers /models with a web page or a 404; in
 * that case /v1 is tried before giving up, and the working base URL is returned.
 */
async function discoverModels(ep: Endpoint): Promise<{ raw: any[]; baseUrl: string }> {
  try {
    return { raw: await listModels(ep), baseUrl: ep.baseUrl };
  } catch (e) {
    const missingVersion = !/\/v\d+[a-z0-9]*\/?$/i.test(new URL(ep.baseUrl).pathname);
    if (!missingVersion || !(isWebPage(e) || (e instanceof LlmError && e.kind === "not_found")))
      throw e;
    const baseUrl = `${ep.baseUrl.replace(/\/+$/, "")}/v1`;
    try {
      return { raw: await listModels({ ...ep, baseUrl }), baseUrl };
    } catch (retry) {
      // The /v1 answer says more than the web page did (a bad key, say), unless it's also a miss.
      throw retry instanceof LlmError && retry.kind !== "not_found" && !isWebPage(retry)
        ? retry
        : e;
    }
  }
}

export const refreshInternal = internalAction({
  args: { userId: v.id("users"), providerId: v.string() },
  handler: async (
    ctx,
    { userId, providerId }
  ): Promise<{ status: "connected" | "error"; models: number; error?: string }> => {
    const first: Endpoint | null = await endpointFor(ctx, userId, providerId);
    if (!first) throw new ConvexError("Provider not found.");
    let ep: Endpoint = first;
    await ctx.runMutation(internal.providers.setStatus, { userId, providerId, status: "checking" });
    try {
      const chatgpt = isCodex(ep.baseUrl);
      if (chatgpt) {
        // A refresh is also how a ChatGPT sign-in renews an access token that's about to lapse.
        await renewChatgpt(ctx, userId, providerId, false);
        ep = (await endpointFor(ctx, userId, providerId)) ?? ep;
      }
      const found = chatgpt
        ? { raw: await listChatgptModels(ep), baseUrl: ep.baseUrl }
        : await discoverModels(ep);
      const raw = found.raw;
      if (found.baseUrl !== ep.baseUrl) {
        ep.baseUrl = found.baseUrl;
        await ctx.runMutation(internal.providers.setBaseUrl, {
          userId,
          providerId,
          baseUrl: found.baseUrl,
        });
      }
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
      await ctx.scheduler.runAfter(0, internal.providers.balanceInternal, { userId, providerId });
      return { status: "connected", models: models.filter((m) => m.kind === "chat").length };
    } catch (e) {
      const msg =
        e instanceof ChatgptAuthError
          ? `${e.message} Sign in to ChatGPT again.`
          : e instanceof LlmError && e.kind === "auth" && isCodex(ep.baseUrl)
            ? "ChatGPT signed this app out. Sign in again."
            : e instanceof LlmError && e.kind === "auth"
              ? "The provider rejected the API key."
              : isWebPage(e)
                ? "This URL answered with a web page, not the API. Check the base URL; most end in /v1."
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

/** A balance read sooner than this is still current; replies and an open provider sheet ask often. */
const BALANCE_FRESH_MS = 15_000;
/** Providers without a balance API are asked again only this often, in case that changes. */
const UNSUPPORTED_RETRY_MS = 3600_000;
/** Gateways book a reply's cost a moment after it finishes; reading sooner shows the old balance. */
const BOOKING_DELAY_MS = 3_000;

type ProviderBalance = Infer<typeof vProviderBalance>;
type ProviderLimits = Infer<typeof vProviderLimits>;

function balanceDue(p: Doc<"providers">, now = Date.now()): boolean {
  if (p.auth) return !p.limits || now - p.limits.checkedAt > BALANCE_FRESH_MS;
  const b = p.balance;
  if (!b) return true;
  return now - b.checkedAt > (b.status === "unsupported" ? UNSUPPORTED_RETRY_MS : BALANCE_FRESH_MS);
}

async function updateBalance(
  ctx: ActionCtx,
  userId: Id<"users">,
  providerId: string
): Promise<void> {
  const ep = await endpointFor(ctx, userId, providerId);
  if (!ep) return;
  // A ChatGPT plan has no balance: its 5-hour and weekly windows are what run out.
  if (isCodex(ep.baseUrl)) {
    let limits: ProviderLimits;
    try {
      const found = await fetchChatgptLimits(ep);
      limits = { ...found, checkedAt: Date.now() };
    } catch (e) {
      limits = {
        windows: [],
        checkedAt: Date.now(),
        error:
          e instanceof LlmError && e.kind === "auth"
            ? "ChatGPT signed this app out. Sign in again."
            : "Couldn't read the plan's usage limits.",
      };
    }
    await ctx.runMutation(internal.providers.setLimits, { userId, providerId, limits });
    await ctx.runMutation(internal.providers.setBalance, {
      userId,
      providerId,
      balance: { status: "unsupported", checkedAt: Date.now() },
    });
    return;
  }
  let balance: ProviderBalance;
  try {
    const found = await fetchBalance(ep);
    balance = found
      ? { status: "ok", ...found, checkedAt: Date.now() }
      : { status: "unsupported", checkedAt: Date.now() };
  } catch (e) {
    const error =
      e instanceof LlmError && e.kind === "auth"
        ? "The provider rejected the key when asked for its balance."
        : e instanceof LlmError && e.kind === "network"
          ? "Couldn't reach the provider to read the balance."
          : errorMessage(e);
    balance = { status: "error", error, checkedAt: Date.now() };
  }
  await ctx.runMutation(internal.providers.setBalance, { userId, providerId, balance });
}

/**
 * Reads the balance of one provider, or of every provider that's due. The provider sheet calls this
 * while it's open; `force` is a tap on refresh, which still waits a few seconds between reads.
 */
export const checkBalance = action({
  args: { providerId: v.optional(v.string()), force: v.optional(v.boolean()) },
  handler: async (ctx, { providerId, force }): Promise<void> => {
    const userId = await requireUser(ctx);
    const rows: Doc<"providers">[] = await ctx.runQuery(internal.providers.listInternal, {
      userId,
    });
    const now = Date.now();
    const due = rows.filter(
      (p) =>
        (!providerId || p.providerId === providerId) &&
        (force
          ? now - ((p.auth ? p.limits?.checkedAt : p.balance?.checkedAt) ?? 0) > 3_000
          : balanceDue(p, now))
    );
    await Promise.all(due.map((p) => updateBalance(ctx, userId, p.providerId)));
  },
});

/** Scheduled after a save and after replies. `after`: skip when a read since then already landed. */
export const balanceInternal = internalAction({
  args: { userId: v.id("users"), providerId: v.string(), after: v.optional(v.number()) },
  handler: async (ctx, { userId, providerId, after }) => {
    if (after !== undefined) {
      const row = await ctx.runQuery(internal.providers.getInternal, { userId, providerId });
      if (!row || (row.balance && row.balance.checkedAt >= after)) return;
    }
    await updateBalance(ctx, userId, providerId);
  },
});

export const listInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) =>
    await ctx.db
      .query("providers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
});

export const setBalance = internalMutation({
  args: { userId: v.id("users"), providerId: v.string(), balance: vProviderBalance },
  handler: async (ctx, { userId, providerId, balance }) => {
    const row = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .first();
    if (!row) return;
    // A failed read keeps the last figures, marked with what went wrong.
    const prior = row.balance;
    const next: ProviderBalance =
      balance.status === "error" && prior && prior.status !== "unsupported"
        ? { ...prior, status: "error", error: balance.error, checkedAt: balance.checkedAt }
        : balance;
    // The drop since the last read is money spent: the only spend figure for endpoints that
    // publish no prices. A rise is a top-up and isn't counted.
    const drop =
      balance.status === "ok" &&
      prior?.remaining !== undefined &&
      balance.remaining !== undefined &&
      (prior.currency ?? "USD") === (balance.currency ?? "USD")
        ? prior.remaining - balance.remaining
        : 0;
    const patch: Partial<Doc<"providers">> = { balance: next };
    if (drop > 1e-6) {
      const month = new Date(balance.checkedAt).toISOString().slice(0, 7);
      const usage =
        row.usage?.month === month
          ? row.usage
          : { month, costUsd: 0, unpriced: 0, promptTokens: 0, completionTokens: 0, replies: 0 };
      patch.usage = { ...usage, balanceSpent: (usage.balanceSpent ?? 0) + drop };
    }
    await ctx.db.patch(row._id, patch);
  },
});

/**
 * Adds a finished reply to the provider's spend for the month, then reads the balance again once
 * the provider has booked the reply. costUsd is undefined when the model has no published price.
 */
export const recordUsage = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", a.userId).eq("providerId", a.providerId))
      .first();
    if (!row) return;
    const now = Date.now();
    const month = new Date(now).toISOString().slice(0, 7);
    const prev =
      row.usage?.month === month
        ? row.usage
        : { month, costUsd: 0, unpriced: 0, promptTokens: 0, completionTokens: 0, replies: 0 };
    await ctx.db.patch(row._id, {
      usage: {
        month,
        costUsd: prev.costUsd + (a.costUsd ?? 0),
        unpriced: prev.unpriced + (a.costUsd === undefined ? 1 : 0),
        promptTokens: prev.promptTokens + a.promptTokens,
        completionTokens: prev.completionTokens + a.completionTokens,
        replies: prev.replies + 1,
      },
    });
    if (row.balance?.status === "unsupported" && balanceDue(row, now) === false) return;
    const wait = Math.max(
      BOOKING_DELAY_MS,
      row.balance ? row.balance.checkedAt + BALANCE_FRESH_MS - now : 0
    );
    await ctx.scheduler.runAfter(wait, internal.providers.balanceInternal, {
      userId: a.userId,
      providerId: a.providerId,
      after: now,
    });
  },
});

// ── ChatGPT sign-in ────────────────────────────────────────────────────────────

const CHATGPT_ID = "chatgpt";

/** Starts signing in with a ChatGPT plan: the code the user approves at auth.openai.com. */
export const chatgptStart = action({
  args: {},
  handler: async (
    ctx
  ): Promise<{ deviceAuthId: string; userCode: string; intervalMs: number; verifyUrl: string }> => {
    await requireUser(ctx);
    try {
      return { ...(await startDeviceAuth()), verifyUrl: CHATGPT_VERIFY_URL };
    } catch (e) {
      throw new ConvexError(errorMessage(e));
    }
  },
});

/**
 * One check on a pending sign-in. Once the code is approved the plan is saved as the "chatgpt"
 * provider (its access token as the key) and its models are loaded.
 */
export const chatgptPoll = action({
  args: { deviceAuthId: v.string(), userCode: v.string() },
  handler: async (
    ctx,
    { deviceAuthId, userCode }
  ): Promise<{ status: "pending" | "connected" | "error"; error?: string; models?: number }> => {
    const userId = await requireUser(ctx);
    let tokens: ChatgptTokens | null;
    try {
      tokens = await pollDeviceAuth(deviceAuthId, userCode);
    } catch (e) {
      return { status: "error", error: errorMessage(e) };
    }
    if (!tokens) return { status: "pending" };
    await storeChatgpt(ctx, userId, CHATGPT_ID, tokens, true);
    const res = await ctx.runAction(internal.providers.refreshInternal, {
      userId,
      providerId: CHATGPT_ID,
    });
    return res.status === "connected"
      ? { status: "connected", models: res.models }
      : { status: "error", error: res.error };
  },
});

async function storeChatgpt(
  ctx: ActionCtx,
  userId: Id<"users">,
  providerId: string,
  t: ChatgptTokens,
  fresh: boolean
): Promise<void> {
  const headers = chatgptHeaders(t.accountId);
  await ctx.runMutation(internal.providers.setChatgpt, {
    userId,
    providerId,
    fresh,
    keyCipher: await encryptSecret(t.access),
    keyHint: t.email ?? "ChatGPT",
    headersCipher: await encryptSecret(JSON.stringify(headers)),
    headerHints: maskHeaders(headers),
    auth: {
      type: "chatgpt",
      refreshCipher: await encryptSecret(t.refresh),
      expiresAt: t.expiresAt,
      accountId: t.accountId,
      email: t.email,
      plan: t.plan,
    },
  });
  // Renewed shortly before it lapses, so replies never meet an expired token.
  await ctx.scheduler.runAfter(
    Math.max(60_000, t.expiresAt - REFRESH_EARLY_MS - Date.now()),
    internal.providers.chatgptRenew,
    { userId, providerId }
  );
}

/** Renews the access token when it's close to lapsing (or always, with `force`). */
async function renewChatgpt(
  ctx: ActionCtx,
  userId: Id<"users">,
  providerId: string,
  force: boolean
): Promise<void> {
  const row = await ctx.runQuery(internal.providers.getInternal, { userId, providerId });
  if (!row?.auth) return;
  if (!force && row.auth.expiresAt - Date.now() > REFRESH_EARLY_MS) return;
  try {
    const t = await refreshTokens(await decryptSecret(row.auth.refreshCipher));
    await storeChatgpt(ctx, userId, providerId, t, false);
  } catch (e) {
    if (e instanceof ChatgptAuthError && e.status >= 400 && e.status < 500) {
      await ctx.runMutation(internal.providers.setStatus, {
        userId,
        providerId,
        status: "error",
        error: "ChatGPT signed this app out. Sign in again.",
      });
    }
    throw e;
  }
}

export const chatgptRenew = internalAction({
  args: { userId: v.id("users"), providerId: v.string() },
  handler: async (ctx, { userId, providerId }) => {
    await renewChatgpt(ctx, userId, providerId, false).catch((e) =>
      console.warn("chatgpt renew failed", errorMessage(e))
    );
  },
});

export const setChatgpt = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.string(),
    fresh: v.boolean(),
    keyCipher: v.string(),
    keyHint: v.string(),
    headersCipher: v.string(),
    headerHints: v.array(vHeader),
    auth: v.object({
      type: v.literal("chatgpt"),
      refreshCipher: v.string(),
      expiresAt: v.number(),
      accountId: v.string(),
      email: v.optional(v.string()),
      plan: v.optional(v.string()),
    }),
  },
  handler: async (ctx, { fresh, ...a }) => {
    const row = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", a.userId).eq("providerId", a.providerId))
      .first();
    const fields = {
      keyCipher: a.keyCipher,
      keyHint: a.keyHint,
      headersCipher: a.headersCipher,
      headerHints: a.headerHints,
      auth: a.auth,
    };
    if (row) {
      await ctx.db.patch(row._id, {
        ...fields,
        ...(fresh
          ? {
              label: "ChatGPT",
              baseUrl: CHATGPT_BASE,
              status: "checking" as const,
              lastError: undefined,
            }
          : {}),
      });
    } else {
      await ctx.db.insert("providers", {
        userId: a.userId,
        providerId: a.providerId,
        label: "ChatGPT",
        baseUrl: CHATGPT_BASE,
        status: "checking",
        models: [],
        ...fields,
      });
    }
  },
});

export const setLimits = internalMutation({
  args: { userId: v.id("users"), providerId: v.string(), limits: vProviderLimits },
  handler: async (ctx, { userId, providerId, limits }) => {
    const row = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .first();
    if (!row) return;
    // A failed read keeps the last windows, marked with what went wrong.
    const next =
      limits.error && row.limits?.windows.length
        ? { ...row.limits, error: limits.error, checkedAt: limits.checkedAt }
        : limits;
    await ctx.db.patch(row._id, { limits: next });
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
      // Another endpoint or key has another balance; the old figure would mislead until it's read.
      const moved = existing.baseUrl !== args.baseUrl || existing.keyCipher !== args.keyCipher;
      await ctx.db.patch(existing._id, {
        ...args,
        status: "checking",
        lastError: undefined,
        ...(moved ? { balance: undefined } : {}),
      });
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

export const setBaseUrl = internalMutation({
  args: { userId: v.id("users"), providerId: v.string(), baseUrl: v.string() },
  handler: async (ctx, { userId, providerId, baseUrl }) => {
    const row = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) => q.eq("userId", userId).eq("providerId", providerId))
      .first();
    if (row) await ctx.db.patch(row._id, { baseUrl });
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
