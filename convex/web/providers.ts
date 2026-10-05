import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { SearchProviderId } from "../lib/validators";
import { HOUR, webCache } from "./cache";

/**
 * web_search (PRD §3.8). The providers themselves live in pi-web-access (./access.ts, a Node
 * action); this side owns the cache and the circuit breakers: a user key that answers 401/402/403
 * is skipped for an hour, a server SearXNG instance (SEARXNG_URLS) that fails for ten minutes.
 */

export type SearchResult = { url: string; title: string; snippet: string; provider: string };
export type Recency = "day" | "week" | "month" | "year";

export type SearchConfig = {
  provider: SearchProviderId;
  key?: string;
  url?: string;
};

export type SearchOutcome = {
  results: SearchResult[];
  provider: string;
  errors: string[];
  /** Auth status (401/402/403) from the user's own provider, 0 otherwise. */
  ownStatus: number;
  searxngFailed: boolean;
};

/** Server-wide SearXNG pool (SEARXNG_URLS, comma-separated); the first healthy instance is used. */
function searxngPool(): string[] {
  return (process.env.SEARXNG_URLS ?? "")
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter((u) => /^https?:\/\//.test(u));
}

export async function searchWeb(
  ctx: ActionCtx,
  cfg: SearchConfig,
  query: string,
  opts: { limit?: number; recency?: Recency } = {}
): Promise<{ results: SearchResult[]; provider: string; errors: string[] }> {
  const cache = webCache(ctx);
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 10);
  const cacheKey = `search:${cfg.provider}:${opts.recency ?? ""}:${limit}:${query.toLowerCase().trim()}`;
  const hit = await cache.get(cacheKey);
  if (hit) {
    const parsed = JSON.parse(hit.content);
    return { results: parsed.results, provider: parsed.provider, errors: [] };
  }

  const ownBreaker = `breaker:own:${cfg.provider}`;
  const hasOwn = cfg.provider === "searxng" ? !!cfg.url : cfg.provider !== "none" && !!cfg.key;
  const own = hasOwn && !(await cache.get(ownBreaker)) ? cfg : undefined;
  let searxng: string | undefined;
  for (const url of searxngPool()) {
    if (url === cfg.url?.replace(/\/+$/, "")) continue;
    if (!(await cache.get(`breaker:searxng:${url}`))) {
      searxng = url;
      break;
    }
  }

  const r: SearchOutcome = await ctx.runAction(internal.web.access.search, {
    query,
    limit,
    recency: opts.recency,
    own: own && { provider: own.provider, key: own.key, url: own.url },
    searxng,
  });

  if (r.ownStatus) await cache.put(ownBreaker, String(r.ownStatus), "text/plain", HOUR);
  if (r.searxngFailed && searxng)
    await cache.put(`breaker:searxng:${searxng}`, "1", "text/plain", HOUR / 6);
  if (r.results.length) {
    await cache.put(
      cacheKey,
      JSON.stringify({ results: r.results, provider: r.provider }),
      "application/json",
      opts.recency === "day" ? HOUR : 6 * HOUR
    );
  }
  return { results: r.results, provider: r.provider, errors: r.errors };
}
