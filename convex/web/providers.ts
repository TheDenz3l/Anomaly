import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { errorMessage } from "../lib/util";
import type { SearchProviderId } from "../lib/validators";
import { HOUR, type WebCache, webCache } from "./cache";
import { benchKey, firecrawlKeys, firecrawlSearch } from "./firecrawl";
import { judgeResults } from "./relevance";
import { hostname, normalizeUrl } from "./sources";

/**
 * web_search (PRD §3.8). Order: the user's own provider, then Firecrawl (./firecrawl.ts — the
 * user's key if Firecrawl is their provider, else the deployment's FIRECRAWL_API_KEY), then
 * pi-web-access's chain in ./access.ts (Exa, deployment-keyed Brave/Tavily/Jina, DuckDuckGo,
 * Keenable), then the server SearXNG pool (SEARXNG_URLS, every healthy instance queried at once
 * from here). Public instances run last: they are slow (6–25 s) or geo-skewed often enough to be a
 * fallback only.
 *
 * "Got results" is not "search worked": a SearXNG instance whose upstream engines are blocked
 * answers every query with the same unrelated pages. Each set is judged (./relevance.ts) and an
 * off-topic one falls through to the next backend. Breakers: a user key answering 401/402/403 is
 * skipped for an hour; a pool instance that errors for ten minutes, one serving junk for an hour.
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
  /** The set passed the relevance check (./relevance.ts). */
  ok: boolean;
  /** Share of results on topic, for picking the best of several failed sets. */
  score: number;
  /** Auth status (401/402/403) from the user's own provider, 0 otherwise. */
  ownStatus: number;
};

type Judged = Pick<SearchOutcome, "results" | "provider" | "ok" | "score">;

const SEARXNG_TIMEOUT = 12_000;

/** Server-wide SearXNG pool (SEARXNG_URLS, comma-separated); the first healthy instance is used. */
function searxngPool(): string[] {
  return (process.env.SEARXNG_URLS ?? "")
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter((u) => /^https?:\/\//.test(u));
}

async function searxng(base: string, query: string, recency?: Recency): Promise<SearchResult[]> {
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  if (recency) url.searchParams.set("time_range", recency);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARXNG_TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      results?: { url?: string; title?: string; content?: string }[];
    };
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const r of data.results ?? []) {
      if (!r.url || !/^https?:\/\//.test(r.url)) continue;
      const key = normalizeUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        url: r.url,
        title: r.title || r.url,
        snippet: (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
        provider: "searxng",
      });
      if (out.length >= 10) break;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Queries every healthy pool instance at once and keeps the best on-topic set. An instance that
 * errors is benched for ten minutes; one serving junk while another answers on topic, for an hour.
 */
async function searchPool(
  cache: WebCache,
  pool: string[],
  query: string,
  recency: Recency | undefined,
  errors: string[]
): Promise<Judged | null> {
  const runs = await Promise.all(
    pool.map(async (base) => {
      try {
        return {
          base,
          provider: "searxng",
          ...judgeResults(query, await searxng(base, query, recency)),
        };
      } catch (e) {
        errors.push(`searxng ${hostname(base)}: ${errorMessage(e).slice(0, 160)}`);
        await cache.put(`breaker:searxng:${base}`, "error", "text/plain", HOUR / 6);
        return null;
      }
    })
  );
  const done = runs
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => Number(b.ok) - Number(a.ok) || b.score - a.score);
  const best = done[0];
  if (!best) return null;
  if (best.ok) {
    for (const r of done) {
      if (r.ok || r.score >= 0.25) continue;
      errors.push(`searxng ${hostname(r.base)}: off-topic results`);
      await cache.put(`breaker:searxng:${r.base}`, "off-topic", "text/plain", HOUR);
    }
  }
  return { results: best.results, provider: best.provider, ok: best.ok, score: best.score };
}

export async function searchWeb(
  ctx: ActionCtx,
  cfg: SearchConfig,
  query: string,
  opts: { limit?: number; recency?: Recency } = {}
): Promise<{ results: SearchResult[]; provider: string; errors: string[] }> {
  const cache = webCache(ctx);
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 10);
  const recency = opts.recency;
  const cacheKey = `search:v3:${cfg.provider}:${recency ?? ""}:${limit}:${query.toLowerCase().trim()}`;
  const hit = await cache.get(cacheKey);
  if (hit) {
    const parsed = JSON.parse(hit.content);
    return { results: parsed.results, provider: parsed.provider, errors: [] };
  }

  const errors: string[] = [];
  const failed: Judged[] = [];
  const finish = async (j: Judged) => {
    const results = j.results.slice(0, limit);
    if (j.ok && results.length) {
      await cache.put(
        cacheKey,
        JSON.stringify({ results, provider: j.provider }),
        "application/json",
        recency === "day" ? HOUR : 6 * HOUR
      );
    }
    return { results, provider: j.provider, errors };
  };

  const ownBreaker = `breaker:own:${cfg.provider}`;
  const hasOwn =
    cfg.provider === "searxng"
      ? !!cfg.url
      : cfg.provider !== "none" && cfg.provider !== "firecrawl" && !!cfg.key;
  if (hasOwn && !(await cache.get(ownBreaker))) {
    const r: SearchOutcome = await ctx.runAction(internal.web.access.search, {
      query,
      limit,
      recency,
      own: { provider: cfg.provider, key: cfg.key, url: cfg.url },
      chain: false,
    });
    errors.push(...r.errors);
    if (r.ownStatus) await cache.put(ownBreaker, String(r.ownStatus), "text/plain", HOUR);
    if (r.ok) return finish(r);
    failed.push(r);
  }

  // Firecrawl: the user's own key when Firecrawl is their provider, then the deployment's.
  for (const k of await firecrawlKeys(cache, cfg.provider === "firecrawl" ? cfg.key : undefined)) {
    try {
      const found = await firecrawlSearch(k.key, query, Math.min(limit + 4, 10), recency);
      const j: Judged = { ...judgeResults(query, found), provider: "firecrawl" };
      if (j.ok) return finish(j);
      errors.push("firecrawl: off-topic results");
      if (j.results.length) failed.push(j);
      break;
    } catch (err) {
      errors.push(errorMessage(err).slice(0, 160));
      await benchKey(cache, k, err);
    }
  }

  const r: SearchOutcome = await ctx.runAction(internal.web.access.search, {
    query,
    limit,
    recency,
    chain: true,
  });
  errors.push(...r.errors);
  if (r.ok) return finish(r);
  failed.push(r);

  const pool: string[] = [];
  for (const url of searxngPool()) {
    if (url === cfg.url?.replace(/\/+$/, "")) continue;
    if (!(await cache.get(`breaker:searxng:${url}`))) pool.push(url);
  }
  const pooled = pool.length ? await searchPool(cache, pool, query, recency, errors) : null;
  if (pooled?.ok) return finish(pooled);
  if (pooled) failed.push(pooled);

  // Nothing passed: the least off-topic set beats an empty answer (results sharing no query term
  // were already dropped).
  const best = failed.filter((f) => f.results.length).sort((a, b) => b.score - a.score)[0];
  return best ? finish(best) : { results: [], provider: "none", errors };
}
