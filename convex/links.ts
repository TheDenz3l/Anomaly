import { v } from "convex/values";
import { action } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { HOUR, webCache } from "./web/cache";
import { fetchPublic, publicUrl } from "./web/guard";

/** Titles for links pasted into the composer, shown beside the site's icon in the input and the bubble. */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 AtlasLinkPreview/1.0";
const MAX_BYTES = 256_000;
const MAX_TITLE = 90;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function cleanTitle(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return t || null;
}

function clip(t: string): string {
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1).trimEnd()}…` : t;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const SEPARATOR = /\s*(?:[:|·•]|\s[-–—]\s)\s*/g;

/** "MacRumors: Apple News and Rumors" → "Apple News and Rumors"; "Video - YouTube" → "Video". */
function withoutBrand(title: string, brands: string[]): string {
  const seps = [...title.matchAll(SEPARATOR)];
  const first = seps[0];
  const last = seps[seps.length - 1];
  if (first?.index && brands.includes(normalize(title.slice(0, first.index)))) {
    const rest = title.slice(first.index + first[0].length);
    if (rest.length >= 3) return rest;
  }
  if (last?.index && brands.includes(normalize(title.slice(last.index + last[0].length)))) {
    const rest = title.slice(0, last.index);
    if (rest.length >= 3) return rest;
  }
  return title;
}

/** og:title, then twitter:title, then <title>. */
/** og:title, then twitter:title, then <title>, without the site's name tacked on either end. */
export function titleFromHtml(html: string, host: string): string | null {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const a of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
    }
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const content = attrs.get("content");
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const full =
    cleanTitle(meta.get("og:title")) ?? cleanTitle(meta.get("twitter:title")) ?? cleanTitle(title);
  if (!full) return null;
  const brands = [meta.get("og:site_name"), meta.get("application-name"), ...host.split(".")]
    .map((b) => normalize(decodeEntities(b ?? "")))
    .filter((b) => b.length >= 3);
  return clip(withoutBrand(full, brands));
}

/** The page's HTML up to </head>, or null when it isn't an HTML page that answered. */
async function headOf(url: URL): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetchPublic(url.toString(), {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
    });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let html = "";
    while (html.length < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    void reader.cancel().catch(() => undefined);
    return html;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** YouTube answers bots with a consent page; its oEmbed endpoint has the video title. */
async function youtubeTitle(url: URL): Promise<string | null> {
  if (!/(^|\.)(youtube\.com|youtu\.be)$/.test(url.hostname)) return null;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url.toString())}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string };
    return cleanTitle(data.title);
  } catch {
    return null;
  }
}

export const preview = action({
  args: { url: v.string() },
  handler: async (ctx, args): Promise<{ title: string | null }> => {
    await requireUser(ctx);
    let url: URL;
    try {
      url = publicUrl(args.url);
    } catch {
      return { title: null };
    }
    const cache = webCache(ctx);
    const key = `title:v2:${url.toString()}`;
    const hit = await cache.get(key);
    if (hit) return { title: hit.content || null };
    let title = await youtubeTitle(url);
    if (!title) {
      const html = await headOf(url);
      title = html ? titleFromHtml(html, url.hostname) : null;
    }
    await cache.put(key, title ?? "", "text/plain", title ? 24 * HOUR : HOUR);
    return { title };
  },
});
