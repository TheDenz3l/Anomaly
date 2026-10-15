import type { Entity, EntityCard } from "../lib/validators";
import { HOUR, type WebCache } from "./cache";
import { articleFits, type PhotoFinder } from "./photos";

/**
 * The top of a profile sheet, for a name tapped in a reply: its Wikipedia article (short
 * description, opening sentences, lead photo) and more photos of the same subject. Found while the
 * profile's model starts writing, so the sheet has a face and an overview within a second or two
 * whatever the model's speed. Cached for a week (a miss for six hours).
 */

const HEADERS = {
  "User-Agent": "Anomaly/1.0 (iOS chat app; profile sheets)",
  "Api-User-Agent": "Anomaly/1.0 (iOS chat app; profile sheets)",
};
const TIMEOUT_MS = 3500;
const MAX_IMAGES = 6;

type Page = {
  index: number;
  title: string;
  description?: string;
  extract?: string;
  fullurl?: string;
  thumbnail?: { source: string };
  pageprops?: { disambiguation?: string };
};

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s: string) =>
  fold(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/** The name, kind and hint folded into one key: the same name tapped again opens the same profile. */
export function entityKey(e: Pick<Entity, "name" | "kind" | "hint">): string {
  return [e.kind, words(e.name).join(" "), words(e.hint).slice(0, 8).join(" ")].join("|");
}

/** Articles about a part of someone's work or life rather than about them. */
const ASPECT =
  /^(filmography|discography|bibliography|videography|list|awards|accolades|nominations|songs|albums|career|tour|tours|concerts|controversies|records|family|life)$/;

/**
 * Whether an article is about the name: every word of its title (less a "(film)" qualifier) is in
 * the name, or the title is the name with a word or two more ("Lakers" → "Los Angeles Lakers").
 * "Matt Damon" doesn't fit "Matt Damon filmography" or "Damon Albarn".
 */
export function titleFits(title: string, name: string): boolean {
  const t = words(title.replace(/\s*\([^)]*\)/g, ""));
  const n = words(name);
  if (!t.length || !n.length) return false;
  if (t.every((w) => n.includes(w))) return true;
  const extra = t.filter((w) => !n.includes(w));
  return (
    n.every((w) => t.includes(w)) &&
    extra.length <= 2 &&
    !extra.some((w) => ASPECT.test(w)) &&
    articleFits(title, name.split(/\s+/).length === 1 ? title : name)
  );
}

async function search(query: string): Promise<Page[]> {
  const q = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "4",
    prop: "pageimages|description|extracts|info|pageprops",
    inprop: "url",
    piprop: "thumbnail",
    pithumbsize: "1280",
    ppprop: "disambiguation",
    exintro: "1",
    explaintext: "1",
    exsentences: "3",
    exlimit: "4",
    redirects: "1",
  });
  const r = await fetch(`https://en.wikipedia.org/w/api.php?${q}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { query?: { pages?: Page[] } };
  return [...(j.query?.pages ?? [])].sort((a, b) => a.index - b.index);
}

/** The article for the name: searched with its hint first ("Mercury planet"), then on its own. */
async function article(e: Entity): Promise<Page | null> {
  const hint = e.hint.split(/\s+/).slice(0, 6).join(" ");
  for (const query of hint ? [`${e.name} ${hint}`, e.name] : [e.name]) {
    const pages = await search(query).catch(() => []);
    const page = pages.find(
      (p) =>
        p.pageprops?.disambiguation === undefined &&
        titleFits(p.title, e.name) &&
        Boolean(p.extract?.trim())
    );
    if (page) return page;
  }
  return null;
}

/**
 * Article prose without what's left of its pronunciation guides: the plain-text export drops the
 * IPA but keeps the respelling, so "( DAY-mən; born October 8, 1970)" becomes "(born October 8, 1970)".
 */
export function cleanExtract(text: string): string {
  return text
    .replace(/\(\s[^();]*;\s*/g, "(")
    .replace(/\(\s*;\s*/g, "(")
    .replace(/\s*\([^()]*(?:listen|pronounced|\/[^/]+\/)[^()]*\)/gi, "")
    .replace(/\(\s*[;,]?\s*\)/g, "")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

/** A Wikimedia file under any of its addresses: its thumbnails and the original. */
const WIKIMEDIA_FILE = /\/wikipedia\/[a-z]+\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/i;

/** Photos with repeats dropped, the same file at another size included. */
export function distinct(urls: string[]): string[] {
  const seen = new Set<string>();
  return urls.filter((url) => {
    const key = url.match(WIKIMEDIA_FILE)?.[1]?.toLowerCase() ?? url.split("?")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function entityCard(
  cache: WebCache,
  findPhotos: PhotoFinder,
  e: Entity,
  /** Gets the article (title, description, overview) as soon as it's found, before the photos. */
  onArticle?: (card: EntityCard) => void
): Promise<EntityCard> {
  const key = `entity:v2:${entityKey(e)}`;
  const hit = await cache.get(key);
  if (hit) return JSON.parse(hit.content) as EntityCard;
  const page = await article(e);
  const text: EntityCard = {
    title: page?.title.replace(/\s*\([^)]*\)$/, "") ?? e.name,
    ...(page?.description ? { description: page.description } : {}),
    ...(page?.extract ? { extract: cleanExtract(page.extract) } : {}),
    ...(page?.fullurl ? { url: page.fullurl } : {}),
    images: [],
  };
  onArticle?.(text);
  // The article's title names the subject precisely ("Mercury (planet)"), which finds its photos.
  const phrase = page?.title ?? `${e.name} ${e.hint.split(/\s+/).slice(0, 3).join(" ")}`;
  const more = await findPhotos(phrase).catch(() => []);
  const lead = page?.thumbnail?.source;
  const images = distinct([...(lead && !/\.svg|logo/i.test(lead) ? [lead] : []), ...more]).slice(
    0,
    MAX_IMAGES
  );
  const card: EntityCard = { ...text, images };
  await cache.put(key, JSON.stringify(card), "application/json", (page ? 168 : 6) * HOUR);
  return card;
}
