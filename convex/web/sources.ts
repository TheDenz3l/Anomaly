import type { Source, SourceOrigin } from "../lib/validators";
import { truncate } from "../lib/util";

/** One citation shape for native search, app tools and sub-agents (PRD §3.2, §3.8). */

const TRACKING =
  /^(utm_|fbclid|gclid|gclsrc|dclid|msclkid|msockid|srsltid|yclid|mc_|mkt_tok|_hsenc|_hsmi|ref$|ref_src|igshid|si$|spm$|cvid$|ocid$)/i;

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.replace(/^www\./, "");
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function faviconFor(url: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname(url))}&sz=64`;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function makeSource(
  url: string,
  title: string,
  snippet: string,
  origin: SourceOrigin
): Source {
  const clean = normalizeUrl(url);
  return {
    id: `src_${hash(clean)}`,
    url,
    title: truncate((title || hostname(url)).replace(/\s+/g, " ").trim(), 160),
    favicon: faviconFor(url),
    snippet: truncate(snippet.replace(/\s+/g, " ").trim(), 320),
    origin,
  };
}

/** Numbered, de-duplicated source list for one reply. Numbers are 1-based and stable. */
export class SourceCollector {
  private list: Source[] = [];
  private index = new Map<string, number>();

  constructor(initial: Source[] = []) {
    for (const s of initial) this.add(s);
  }

  add(source: Source): number {
    const key = normalizeUrl(source.url);
    const existing = this.index.get(key);
    if (existing !== undefined) {
      const cur = this.list[existing];
      if (!cur.snippet && source.snippet) cur.snippet = source.snippet;
      if (cur.title === hostname(cur.url) && source.title) cur.title = source.title;
      return existing + 1;
    }
    this.list.push({ ...source });
    this.index.set(key, this.list.length - 1);
    return this.list.length;
  }

  get size(): number {
    return this.list.length;
  }

  all(): Source[] {
    return this.list.map((s) => ({ ...s }));
  }

  at(n: number): Source | undefined {
    return this.list[n - 1];
  }
}

/**
 * Drops [n] markers that don't point at a retrieved source (PRD §3.7 verify).
 * Handles [3], [3, 5], [3][5].
 */
export function verifyCitations(
  text: string,
  count: number
): { text: string; dropped: number; used: Set<number> } {
  let dropped = 0;
  const used = new Set<number>();
  const out = text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_m, inner: string) => {
    const keep = inner
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => {
        const ok = Number.isInteger(n) && n >= 1 && n <= count;
        if (ok) used.add(n);
        else dropped++;
        return ok;
      });
    return keep.length ? `[${keep.join(", ")}]` : "";
  });
  return { text: out.replace(/ +([.,;:])/g, "$1"), dropped, used };
}

/** Rewrites a worker's local [k] citations into the parent's numbering. */
export function renumberCitations(text: string, map: Map<number, number>): string {
  return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_m, inner: string) => {
    const nums = inner
      .split(",")
      .map((s) => map.get(Number(s.trim())))
      .filter((n): n is number => n !== undefined);
    return nums.length ? `[${[...new Set(nums)].join(", ")}]` : "";
  });
}
