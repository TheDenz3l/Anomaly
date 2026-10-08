import { errorMessage } from "../lib/util";
import { HOUR, type WebCache } from "./cache";
import type { Recency, SearchResult } from "./providers";
import { normalizeUrl } from "./sources";

/**
 * Exa (api.exa.ai) in `fast` mode: the first backend for web_search, Firecrawl behind it. Fast
 * mode answers in about half a second where `auto` swings between 0.1 and 6 s. The deployment's
 * EXA_API_KEY serves everyone. A key answering 401/402/403 is benched for an hour, a rate-limited
 * one (429) for a minute.
 */

const URL_ = "https://api.exa.ai/search";
const BREAKER = "breaker:server:exa";
const DAY_MS = 86_400_000;
const WINDOW: Record<Recency, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

export class ExaError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The deployment key, unless it's benched. */
export async function exaKey(cache: WebCache): Promise<string | null> {
  const key = process.env.EXA_API_KEY?.trim();
  if (!key || (await cache.get(BREAKER))) return null;
  return key;
}

export async function benchExa(cache: WebCache, e: unknown): Promise<void> {
  if (!(e instanceof ExaError)) return;
  const ttl = e.status === 429 ? 60_000 : [401, 402, 403].includes(e.status) ? HOUR : 0;
  if (ttl) await cache.put(BREAKER, String(e.status), "text/plain", ttl);
}

type Item = { url?: string; title?: string | null; highlights?: string[]; text?: string };

export async function exaSearch(
  key: string,
  query: string,
  limit: number,
  recency?: Recency
): Promise<SearchResult[]> {
  const controller = new AbortController();
  // Usually ~0.5 s; past 6 s the next backend is a better bet than waiting.
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        type: "fast",
        numResults: limit,
        contents: { highlights: { maxCharacters: 500 } },
        ...(recency
          ? { startPublishedDate: new Date(Date.now() - WINDOW[recency]).toISOString() }
          : {}),
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ExaError(
        `Exa search ${res.status}: ${text.replaceAll(key, "<key>").slice(0, 200)}`,
        res.status
      );
    }
    const data = JSON.parse(text) as { results?: Item[] };
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const item of data.results ?? []) {
      if (!item.url || !/^https?:\/\//.test(item.url)) continue;
      const k = normalizeUrl(item.url);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        url: item.url,
        title: item.title?.trim() || item.url,
        snippet: (item.highlights?.join(" ") ?? item.text ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500),
        provider: "exa",
      });
    }
    return out;
  } catch (e) {
    if (e instanceof ExaError) throw e;
    const why = controller.signal.aborted ? "timed out" : errorMessage(e);
    throw new ExaError(`Exa search: ${why}`, 0);
  } finally {
    clearTimeout(timer);
  }
}
