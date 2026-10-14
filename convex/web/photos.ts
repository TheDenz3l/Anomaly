import type { ActionCtx } from "../_generated/server";
import { HOUR, webCache } from "./cache";
import { benchKey, firecrawlKeys, firecrawlScreenshot } from "./firecrawl";
import { publicUrl } from "./guard";
import { searchImages, type SearchConfig } from "./providers";

/**
 * Photos for a phrase the model wrote in a card ("Great Pyramid of Giza", "Fushimi Inari torii
 * gates"). The lead image of the best-matching Wikipedia article comes first: free, licensed for
 * reuse, and right for the named things (places, landmarks, species, artworks) cards mostly show.
 * Wikimedia Commons photos found for the same phrase follow, so a card that names one subject twice
 * gets a second photo of that subject rather than the lead image of some neighbouring article (the
 * castle beside a shrine). Firecrawl's web image search runs alongside both for scenes and things
 * encyclopedias don't picture (a canal at dusk, a restaurant, a product), within a per-answer budget
 * since it's rate limited; products put its shop photos first. A screenshot is a page captured by
 * Firecrawl, copied into this deployment's storage because Firecrawl only keeps it for a day.
 */

export type PhotoKind = "photo" | "product" | "screenshot";
export type PhotoFinder = (phrase: string, opts?: { kind?: PhotoKind }) => Promise<string[]>;

const HEADERS = {
  // Wikimedia asks API clients to identify themselves.
  "User-Agent": "Anomaly/1.0 (iOS chat app; card photos)",
  "Api-User-Agent": "Anomaly/1.0 (iOS chat app; card photos)",
};
const TIMEOUT_MS = 4000;
/** Firecrawl image searches one answer may spend, and screenshots it may take. */
const WEB_SEARCHES = 8;
const SCREENSHOTS = 4;
const CANDIDATES = 4;

/** Maps, flags and diagrams come as SVG renders, brands lead with a logo; a photo reads better. */
const isPhoto = (url: unknown): url is string =>
  typeof url === "string" && /^https:\/\//i.test(url) && !/\.svg|logo/i.test(url);

type Page = {
  index: number;
  title?: string;
  thumbnail?: { source: string };
  imageinfo?: { thumburl?: string }[];
};

/** Folds case and accents, so "Arcángel" and "arcangel" compare equal. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const MINOR = new Set(["the", "a", "an", "of", "and", "de", "la", "le", "el", "los", "las"]);

/**
 * Whether an article is about what the phrase names: the first word of its title is in the
 * phrase. Search ranks near-misses first for loose phrases (the Lincoln Memorial Reflecting Pool
 * for the 9/11 memorial's pools, the artist Cory Arcangel for the singer Arcángel); those go to
 * the web image search instead.
 */
export function articleFits(title: string, phrase: string): boolean {
  const words = fold(phrase).split(/[^a-z0-9]+/);
  const first = fold(title.replace(/\s*\([^)]*\)/g, ""))
    .split(/[^a-z0-9]+/)
    .find((w) => w && !MINOR.has(w));
  return !first || words.includes(first);
}

async function wikimedia(host: string, params: Record<string, string>): Promise<Page[]> {
  const q = new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params });
  const r = await fetch(`https://${host}/w/api.php?${q}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { query?: { pages?: Page[] } };
  return [...(j.query?.pages ?? [])].sort((a, b) => a.index - b.index);
}

/** The lead image of the best-matching article. */
async function wikipedia(phrase: string): Promise<string[]> {
  const pages = await wikimedia("en.wikipedia.org", {
    generator: "search",
    gsrsearch: phrase,
    gsrlimit: "1",
    prop: "pageimages",
    piprop: "thumbnail",
    pithumbsize: "1280",
  });
  return pages
    .filter((p) => !p.title || articleFits(p.title, phrase))
    .map((p) => p.thumbnail?.source)
    .filter(isPhoto);
}

async function commons(phrase: string): Promise<string[]> {
  const pages = await wikimedia("commons.wikimedia.org", {
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: `${phrase} filetype:bitmap`,
    gsrlimit: "4",
    prop: "imageinfo",
    iiprop: "url",
    iiurlwidth: "1280",
  });
  return pages.map((p) => p.imageinfo?.[0]?.thumburl).filter(isPhoto);
}

/**
 * Finds photo candidates for phrases, cached for a week (a miss for six hours), and screenshots of
 * pages, cached for a day. `search` is the user's web search setup; with none, only Wikimedia is
 * asked and no screenshots are taken.
 */
export function photoFinder(ctx: ActionCtx, search: SearchConfig | null): PhotoFinder {
  const cache = webCache(ctx);
  let searches = 0;
  let shots = 0;
  const fromWeb = async (phrase: string): Promise<string[] | null> => {
    if (!search || searches >= WEB_SEARCHES) return null;
    searches++;
    const found = await searchImages(ctx, search, phrase, CANDIDATES).catch(() => null);
    return found ? found.map((i) => i.imageUrl).filter(isPhoto) : null;
  };

  const screenshot = async (page: string): Promise<string[]> => {
    let url: string;
    try {
      url = publicUrl(page).toString();
    } catch {
      return [];
    }
    const key = `shot:v1:${url}`;
    const hit = await cache.get(key);
    if (hit) return [hit.content];
    if (!search || shots >= SCREENSHOTS) return [];
    shots++;
    for (const k of await firecrawlKeys(
      cache,
      search.provider === "firecrawl" ? search.key : undefined
    )) {
      try {
        const shot = await firecrawlScreenshot(k.key, url);
        const image = await fetch(shot, { signal: AbortSignal.timeout(15_000) });
        if (!image.ok) return [];
        const stored = await ctx.storage.getUrl(await ctx.storage.store(await image.blob()));
        if (!stored) return [];
        await cache.put(key, stored, "text/plain", 24 * HOUR);
        return [stored];
      } catch (err) {
        await benchKey(cache, k, err);
      }
    }
    return [];
  };

  return async (phrase, opts = {}) => {
    const kind = opts.kind ?? "photo";
    if (kind === "screenshot") return screenshot(phrase.trim());
    const key = `photo:v5:${kind === "product" ? "product:" : ""}${phrase.toLowerCase().trim()}`;
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit.content) as string[];
    const [lead, more, web] = await Promise.all([
      wikipedia(phrase).catch(() => []),
      commons(phrase).catch(() => []),
      fromWeb(phrase),
    ]);
    // A named thing is best shown by its article's photo; a product by its shop photos.
    const urls = [
      ...new Set(
        kind === "product" ? [...(web ?? []), ...lead, ...more] : [...lead, ...(web ?? []), ...more]
      ),
    ].slice(0, CANDIDATES);
    // Out of web budget (or rate limited), a phrase may find more next time: remember it briefly.
    const complete = web !== null || !search;
    await cache.put(
      key,
      JSON.stringify(urls),
      "application/json",
      (urls.length && complete ? 168 : urls.length ? 24 : 6) * HOUR
    );
    return urls;
  };
}
