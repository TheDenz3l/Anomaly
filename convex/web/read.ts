import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { HOUR, webCache, type WebCache } from "./cache";
import { publicUrl } from "./guard";
import type { SearchConfig } from "./providers";
import { benchKey, FirecrawlError, firecrawlKeys, firecrawlScrape } from "./firecrawl";

/**
 * read_url (PRD §3.8): robots.txt respected, cached by URL with content-type TTLs. Firecrawl's
 * main-content scrape goes first (./firecrawl.ts: JS rendering, no site chrome, PDFs); without a
 * usable key, or when it fails, pi-web-access (./access.ts) extracts instead: Readability/Defuddle →
 * Markdown, PDFs via unpdf, the keyless Jina Reader behind blocked or JS-rendered pages.
 */

const UA = "Mozilla/5.0 (compatible; AtlasBot/1.0; personal assistant)";
const BOT = "atlasbot";
const MAX_TEXT = 150_000;

export type PageContent = {
  url: string;
  title: string;
  description: string;
  text: string;
  contentType: string;
  via: string;
};

export type ReadOutcome =
  | { ok: true; url: string; title: string; text: string; contentType: string }
  | { ok: false; error: string };

function ttlFor(contentType: string): number {
  if (contentType.includes("json")) return HOUR;
  if (contentType.includes("pdf")) return 7 * 24 * HOUR;
  if (contentType.includes("html")) return 6 * HOUR;
  return 12 * HOUR;
}

/** First prose paragraph of the Markdown, for source cards. */
function describe(markdown: string): string {
  for (const block of markdown.split(/\n{2,}/)) {
    const line = block.trim();
    if (/^(#|>|\||[-*+] |\d+\. |!\[|```|<)/.test(line)) continue;
    const text = line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length >= 80) return text.length > 280 ? `${text.slice(0, 279)}…` : text;
  }
  return "";
}

async function fetchRobots(origin: string): Promise<string> {
  const controller = new AbortController();
  // Fetched before the page on a site's first read; a slow answer counts as no robots.txt.
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: controller.signal,
    });
    return res.ok ? (await res.text()).slice(0, 100_000) : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal robots.txt check for "*" and our own agent: longest matching rule wins. */
export async function robotsAllowed(cache: WebCache, url: URL): Promise<boolean> {
  const key = `robots:${url.origin}`;
  let body = (await cache.get(key))?.content;
  if (body === undefined) {
    body = await fetchRobots(url.origin);
    await cache.put(key, body, "text/plain", 24 * HOUR);
  }
  if (!body) return true;
  const rules: { allow: boolean; path: string }[] = [];
  let applies = false;
  let lastWasAgent = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const f = field.trim().toLowerCase();
    if (f === "user-agent") {
      const agent = value.toLowerCase();
      const match = agent === "*" || agent.includes(BOT);
      applies = lastWasAgent ? applies || match : match;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!applies) continue;
    if ((f === "allow" || f === "disallow") && value)
      rules.push({ allow: f === "allow", path: value });
  }
  const path = url.pathname + url.search;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const pattern = new RegExp(
      `^${r.path
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\\\$$/, "$")}`
    );
    if (pattern.test(path) && (!best || r.path.length > best.len))
      best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

/** Firecrawl's main-content scrape; null when no key is usable or it failed for a reason a plain fetch might not hit. */
async function viaFirecrawl(
  cache: WebCache,
  cfg: SearchConfig,
  url: URL
): Promise<PageContent | null> {
  for (const k of await firecrawlKeys(cache, cfg.provider === "firecrawl" ? cfg.key : undefined)) {
    try {
      const s = await firecrawlScrape(k.key, url.toString());
      return {
        url: s.url,
        title: s.title || url.hostname,
        description: describe(s.markdown),
        text: s.markdown.slice(0, MAX_TEXT),
        contentType: s.contentType,
        via: "firecrawl",
      };
    } catch (e) {
      if (!(e instanceof FirecrawlError)) throw e;
      await benchKey(cache, k, e);
      if (![401, 402, 403, 429].includes(e.status)) return null;
    }
  }
  return null;
}

export async function readPage(
  ctx: ActionCtx,
  cfg: SearchConfig,
  rawUrl: string
): Promise<PageContent> {
  const url = publicUrl(rawUrl);
  const cache = webCache(ctx);
  const key = `read:v2:${url.toString()}`;
  const hit = await cache.get(key);
  if (hit) return JSON.parse(hit.content) as PageContent;

  if (!(await robotsAllowed(cache, url))) {
    throw new Error("This site's robots.txt asks automated readers not to fetch this page.");
  }

  let page = await viaFirecrawl(cache, cfg, url);
  if (!page) {
    const r: ReadOutcome = await ctx.runAction(internal.web.access.read, { url: url.toString() });
    if (!r.ok) throw new Error(r.error);
    if (!r.text.trim()) throw new Error("The page had no readable text.");
    page = {
      url: r.url,
      title: r.title || url.hostname,
      description: describe(r.text),
      text: r.text,
      contentType: r.contentType,
      via: "pi-web-access",
    };
  }
  await cache.put(key, JSON.stringify(page), page.contentType, ttlFor(page.contentType));
  return page;
}
