import { errorMessage } from "../lib/util";
import { HOUR, type WebCache } from "./cache";
import type { Recency, SearchResult } from "./providers";
import { normalizeUrl } from "./sources";

/**
 * Firecrawl (api.firecrawl.dev, v2) called straight from the default runtime: the first backend
 * for web_search and read_url. Search returns ranked results with page-derived snippets; scrape
 * returns the page's main content as Markdown, so read_url no longer starts with site navigation.
 * The deployment key (FIRECRAWL_API_KEY) serves everyone; a user's own Firecrawl key goes first
 * for their requests. A key answering 401/402/403 (402 = out of credits) is benched for an hour, a
 * rate-limited one (429) for a minute.
 */

const BASE = "https://api.firecrawl.dev/v2";
const TBS: Record<Recency, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
/** Firecrawl's own page cache may answer when its copy is younger than this. */
const SCRAPE_MAX_AGE = 2 * HOUR;

export class FirecrawlError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export type FirecrawlKey = { key: string; breaker: string };

/** Keys to try in order: the user's own (provider "firecrawl"), then the deployment's. */
export async function firecrawlKeys(
  cache: WebCache,
  own: string | undefined
): Promise<FirecrawlKey[]> {
  const out: FirecrawlKey[] = [];
  const server = process.env.FIRECRAWL_API_KEY?.trim();
  if (own) out.push({ key: own, breaker: "breaker:own:firecrawl" });
  if (server && server !== own) out.push({ key: server, breaker: "breaker:server:firecrawl" });
  const benched = await Promise.all(out.map((k) => cache.get(k.breaker)));
  return out.filter((_, i) => !benched[i]);
}

/** Benches a key after an auth, billing or rate-limit failure; other errors just fall through. */
export async function benchKey(cache: WebCache, k: FirecrawlKey, e: unknown): Promise<void> {
  if (!(e instanceof FirecrawlError)) return;
  const ttl = e.status === 429 ? 60_000 : [401, 402, 403].includes(e.status) ? HOUR : 0;
  if (ttl) await cache.put(k.breaker, String(e.status), "text/plain", ttl);
}

async function call<T>(
  key: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: { success?: boolean; error?: unknown } | null = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || data?.success === false) {
      const reason =
        (typeof data?.error === "string" && data.error) ||
        text.slice(0, 200) ||
        `HTTP ${res.status}`;
      throw new FirecrawlError(
        `Firecrawl ${path} ${res.status}: ${reason.replaceAll(key, "<key>").slice(0, 200)}`,
        res.status
      );
    }
    return data as T;
  } catch (e) {
    if (e instanceof FirecrawlError) throw e;
    const why = controller.signal.aborted ? "timed out" : errorMessage(e);
    throw new FirecrawlError(`Firecrawl ${path}: ${why}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Search snippets arrive as page Markdown: flatten to one line of prose. */
function plain(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type WebItem = { url?: string; title?: string; description?: string; snippet?: string };

export async function firecrawlSearch(
  key: string,
  query: string,
  limit: number,
  recency?: Recency
): Promise<SearchResult[]> {
  const r = await call<{ data?: WebItem[] | { web?: WebItem[] } }>(
    key,
    "search",
    { query, limit, sources: ["web"], ...(recency ? { tbs: TBS[recency] } : {}) },
    20_000
  );
  const web = Array.isArray(r.data) ? r.data : (r.data?.web ?? []);
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of web) {
    if (!item.url || !/^https?:\/\//.test(item.url)) continue;
    const k = normalizeUrl(item.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      url: item.url,
      title: plain(item.title || "") || item.url,
      snippet: plain(item.description || item.snippet || "").slice(0, 500),
      provider: "firecrawl",
    });
  }
  return out;
}

export type Scraped = { url: string; title: string; markdown: string; contentType: string };

/** Main content of one page. A missing page throws a plain Error (no fallback will do better). */
export async function firecrawlScrape(key: string, url: string): Promise<Scraped> {
  const r = await call<{
    data?: {
      markdown?: string;
      metadata?: {
        title?: string | string[];
        url?: string;
        sourceURL?: string;
        statusCode?: number;
        contentType?: string;
      };
    };
  }>(
    key,
    "scrape",
    { url, formats: ["markdown"], onlyMainContent: true, maxAge: SCRAPE_MAX_AGE },
    45_000
  );
  const meta = r.data?.metadata ?? {};
  if (meta.statusCode === 404 || meta.statusCode === 410) {
    throw new Error(`The page doesn't exist (HTTP ${meta.statusCode}).`);
  }
  const markdown = r.data?.markdown ?? "";
  if (!markdown.trim()) throw new FirecrawlError("Firecrawl scrape returned no content", 0);
  return {
    url: meta.url || meta.sourceURL || url,
    title: (Array.isArray(meta.title) ? meta.title[0] : meta.title) ?? "",
    markdown,
    contentType: meta.contentType?.split(";")[0] || "text/html",
  };
}
