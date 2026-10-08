import { LlmError, requestJson, type Endpoint } from "./openai";

/**
 * Account balance as the provider reports it. There is no standard for this: OpenRouter, DeepSeek,
 * Moonshot and SiliconFlow each have their own endpoint, and the one-api / new-api gateways most
 * resellers run answer OpenAI's old dashboard billing routes. Anything else reports nothing.
 */

export type Balance = {
  /** Money or credits left. */
  remaining?: number;
  /** The limit or credits bought that `remaining` counts down from. */
  total?: number;
  /** Spent against `total`, or overall when there's no limit. */
  used?: number;
  currency: string;
};

const TIMEOUT_MS = 10_000;

/** Hosts known to have no balance endpoint a bearer key can read; asking them is a wasted request. */
const NO_BALANCE = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.groq.com",
  "api.x.ai",
  "api.mistral.ai",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.cerebras.ai",
  "api.perplexity.ai",
];

const amount = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

function at(ep: Endpoint, baseUrl: string): Endpoint {
  return { ...ep, baseUrl };
}

async function openRouter(ep: Endpoint): Promise<Balance | null> {
  const key = (await requestJson(ep, "/key", { timeoutMs: TIMEOUT_MS }))?.data ?? {};
  const limit = amount(key.limit);
  const used = amount(key.usage);
  // A key with its own spending limit: what's left of that limit is what this key can spend.
  if (limit !== undefined) {
    return {
      remaining: amount(key.limit_remaining) ?? Math.max(0, limit - (used ?? 0)),
      total: limit,
      used,
      currency: "USD",
    };
  }
  try {
    const c = (await requestJson(ep, "/credits", { timeoutMs: TIMEOUT_MS }))?.data ?? {};
    const total = amount(c.total_credits);
    const spent = amount(c.total_usage);
    if (total !== undefined && spent !== undefined)
      return { remaining: Math.max(0, total - spent), total, used: spent, currency: "USD" };
  } catch {
    // Account credits need a key allowed to read them; the key's own usage still stands.
  }
  return used === undefined ? null : { used, currency: "USD" };
}

async function deepSeek(ep: Endpoint, origin: string): Promise<Balance | null> {
  const res = await requestJson(at(ep, origin), "/user/balance", { timeoutMs: TIMEOUT_MS });
  const infos: any[] = Array.isArray(res?.balance_infos) ? res.balance_infos : [];
  const info = infos.find((i) => i?.currency === "USD") ?? infos[0];
  const remaining = amount(info?.total_balance);
  return remaining === undefined ? null : { remaining, currency: String(info.currency ?? "USD") };
}

async function moonshot(ep: Endpoint, origin: string, host: string): Promise<Balance | null> {
  const res = await requestJson(at(ep, origin), "/v1/users/me/balance", { timeoutMs: TIMEOUT_MS });
  const remaining = amount(res?.data?.available_balance);
  return remaining === undefined
    ? null
    : { remaining, currency: host.endsWith(".cn") ? "CNY" : "USD" };
}

async function siliconFlow(ep: Endpoint, origin: string, host: string): Promise<Balance | null> {
  const res = await requestJson(at(ep, origin), "/v1/user/info", { timeoutMs: TIMEOUT_MS });
  const remaining = amount(res?.data?.totalBalance ?? res?.data?.balance);
  return remaining === undefined
    ? null
    : { remaining, currency: host.endsWith(".cn") ? "CNY" : "USD" };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * OpenAI's retired dashboard routes, still served by one-api / new-api gateways: the subscription's
 * hard limit is the key's quota (left + used) and usage is in cents.
 */
async function dashboard(base: Endpoint): Promise<Balance | null> {
  // A base saved without its version (https://gateway.example) serves the site at /dashboard.
  const bases = [base.baseUrl];
  if (!/\/v\d+[a-z0-9]*\/?$/i.test(new URL(base.baseUrl).pathname))
    bases.push(`${base.baseUrl.replace(/\/+$/, "")}/v1`);
  let ep = base;
  let sub: any;
  for (const [i, url] of bases.entries()) {
    ep = at(base, url);
    try {
      sub = await requestJson(ep, "/dashboard/billing/subscription", { timeoutMs: TIMEOUT_MS });
      break;
    } catch (err) {
      if (i === bases.length - 1) throw err;
    }
  }
  const limit = amount(sub?.hard_limit_usd ?? sub?.system_hard_limit_usd);
  if (limit === undefined) return null;
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(now.getTime() + 86_400_000);
  let used: number | undefined;
  try {
    const usage = await requestJson(
      ep,
      `/dashboard/billing/usage?start_date=${day(from)}&end_date=${day(to)}`,
      { timeoutMs: TIMEOUT_MS }
    );
    const cents = amount(usage?.total_usage);
    if (cents !== undefined) used = cents / 100;
  } catch {
    // The limit alone still says how much the key may spend.
  }
  // Gateways report an unlimited key as a hundred million dollars.
  if (limit >= 1e7) return used === undefined ? null : { used, currency: "USD" };
  return {
    remaining: Math.max(0, limit - (used ?? 0)),
    total: limit,
    used,
    currency: "USD",
  };
}

/** The balance for this endpoint's key, or null when the provider doesn't report one. Throws on auth and network errors. */
export async function fetchBalance(ep: Endpoint): Promise<Balance | null> {
  const url = new URL(ep.baseUrl);
  const host = url.hostname.toLowerCase();
  if (NO_BALANCE.some((h) => host === h)) return null;
  if (host.endsWith("openrouter.ai")) return openRouter(ep);
  if (host.endsWith("deepseek.com")) return deepSeek(ep, url.origin);
  if (/(^|\.)moonshot\.(ai|cn)$/.test(host)) return moonshot(ep, url.origin, host);
  if (/(^|\.)siliconflow\.(cn|com)$/.test(host)) return siliconFlow(ep, url.origin, host);
  // Unknown hosts get the gateway routes; any answer but a real one means there's nothing to read.
  // A refused key is the key's problem, not a missing balance API: report it rather than cache it.
  return dashboard(ep).catch((err) => {
    if (err instanceof LlmError && (err.kind === "network" || err.kind === "auth")) throw err;
    return null;
  });
}
