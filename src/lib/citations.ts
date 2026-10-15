import { domainOf } from "@/lib/links";

/**
 * Citation markers in reply text. The server writes [3] and, for several sources, [3, 5]
 * (verifyCitations); models also chain [3][5] or write ranges like [2–4]. A run of them, with
 * the space before it, becomes one source pill.
 */
const GROUP = String.raw`\[\d{1,3}(?:\s*[-–]\s*\d{1,3})?(?:\s*[,;]\s*\d{1,3}(?:\s*[-–]\s*\d{1,3})?)*\]`;
export const CITATION_RUN = String.raw`(?:[ \t]?${GROUP})+`;

const RUN_ONLY = new RegExp(`^${CITATION_RUN}$`);
const RUN_ALL = new RegExp(CITATION_RUN, "g");
/** A run sitting just before the sentence's punctuation: "New Jersey [1, 7]." */
const BEFORE_PUNCTUATION = new RegExp(`(${CITATION_RUN})([.,;:!?]+)(?=\\s|$)`, "g");

export function isCitationRun(seg: string): boolean {
  return RUN_ONLY.test(seg);
}

/** The source numbers a run cites, in order, each once: "[3, 5][5]" → [3, 5]. */
export function citationNumbers(run: string): number[] {
  const out: number[] = [];
  for (const group of run.matchAll(/\[([^\]]+)\]/g)) {
    for (const item of group[1].split(/[,;]/)) {
      const [from, to = from] = item.split(/[-–]/).map((s) => Number(s.trim()));
      for (let n = from; n <= Math.min(to, from + 20); n++) if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** The pill reads after the sentence, not wedged before its full stop: "New Jersey. (pill)". */
export function citationsAfterPunctuation(text: string): string {
  return text.replace(BEFORE_PUNCTUATION, (_, run: string, mark: string) => mark + run.trim());
}

/** Text without its citation markers, for previews, copy, share and speech. */
export function stripCitations(text: string): string {
  return text.replace(RUN_ALL, "");
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The publisher's name as it styles itself, for source pills: "YouTube", "SoundCloud",
 * "Investing.com". A page title usually carries it ("… | Genius Lyrics"), so the words of the title
 * that spell the site's domain win. Otherwise the domain's own name: "BBC", "Soundcloud".
 */
export function publisherName(url: string, title = ""): string {
  const domain = domainOf(url);
  const labels = domain.split(".");
  // The label before the suffix, stepping past short second-level suffixes like "co" or "gc".
  let i = labels.length - 2;
  if (i > 0 && labels[i].length <= 3) i -= 1;
  const name = labels[Math.max(0, i)] ?? domain;
  const wanted = new Set([key(name), key(domain)]);

  const words = title.split(/\s+/).filter(Boolean);
  // The site's name usually closes the title, so the search runs from the end.
  for (let start = words.length - 1; start >= 0; start--) {
    for (let len = 1; len <= 4 && start + len <= words.length; len++) {
      const run = words.slice(start, start + len);
      if (run.some((w) => !key(w))) break;
      if (wanted.has(key(run.join("")))) {
        const label = run.join(" ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        if (label) return label;
      }
    }
  }
  if (name.length <= 3) return name.toUpperCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}
