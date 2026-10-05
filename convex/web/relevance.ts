import { truncate } from "../lib/util";

/**
 * Lexical relevance for search results and long pages. A SearXNG instance whose upstream engines
 * are blocked still answers 200 with ten results — the same unrelated pages for every query — so
 * "got results" can't mean "search worked". The same terms also let read_url hand the model the
 * passages that answer the question instead of the first screens of site navigation.
 */

const STOP = new Set(
  "a an and are as at be by can do does for from how i in is it me much my of on or the to vs was what when where which who why will with".split(
    " "
  )
);
const WORD_SPLIT = /[^\p{L}\p{N}]+/gu;
const SPACED = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]+$/u;
const PRICE_INTENT =
  /\b(price|prices|pricing|cost|costs|cheap|cheapest|fee|fees|how much)\b|[$€£¥]/i;
const MONEY = /[$€£¥]\s?\d|\b\d[\d,.]*\s?(usd|eur|gbp|chf|dollars?|euros?)\b/i;

/**
 * Distinctive lowercase terms of a query: operators, punctuation and stop words removed. Unspaced
 * scripts (CJK, Thai) come as one run, so long runs are cut into two-character pieces.
 */
export function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/\b(site|inurl|intitle|filetype):\S+/g, " ")
    .split(WORD_SPLIT)
    .flatMap((t) => (SPACED.test(t) || t.length <= 3 ? [t] : (t.match(/.{1,2}/gu) ?? [t])))
    .filter((t) => (t.length > 1 || /\d/.test(t)) && !STOP.has(t));
  return [...new Set(words)];
}

function words(text: string): string {
  return ` ${text.toLowerCase().split(WORD_SPLIT).join(" ")} `;
}

/** Share of terms present in text. Space-delimited scripts match on word prefixes ("price" ⊂ "prices"). */
export function coverage(terms: string[], text: string): number {
  if (!terms.length) return 1;
  const hay = words(text);
  const hit = terms.filter((t) => (SPACED.test(t) ? hay.includes(` ${t}`) : hay.includes(t)));
  return hit.length / terms.length;
}

/**
 * Judges one backend's result set. A result is on topic when it carries every "quoted phrase" and
 * most of the query's terms; the set passes when at least a third of it is on topic. Results
 * sharing no term are dropped. `score` is the on-topic share.
 */
export function judgeResults<T extends { url: string; title: string; snippet: string }>(
  query: string,
  results: T[]
): { results: T[]; score: number; ok: boolean } {
  const terms = queryTerms(query);
  if (!results.length) return { results, score: 0, ok: false };
  if (!terms.length) return { results, score: 1, ok: true };
  const phrases = [...query.matchAll(/"([^"]+)"/g)]
    .map((m) => words(m[1]).trim())
    .filter((p) => p.includes(" "));
  const need = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.6);
  const scored = results.map((r) => {
    const text = `${r.title} ${r.snippet} ${r.url}`;
    const hay = words(text);
    return {
      r,
      hits: Math.round(coverage(terms, text) * terms.length),
      phrased: phrases.every((p) => hay.includes(` ${p} `)),
    };
  });
  const onTopic = scored.filter((s) => s.phrased && s.hits >= need).length;
  return {
    results: scored.filter((s) => s.hits > 0).map((s) => s.r),
    score: onTopic / results.length,
    ok: onTopic >= Math.max(1, Math.ceil(results.length / 3)),
  };
}

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[[^\]]*\]\([^)]*\)/g;
const HEADING_ONLY = /^#{1,6}\s[^\n]*$/;

/** Navigation out: images, bulleted link-only lines, lines that are nothing but several links. */
function isNavLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^([*+-]|\d+\.)(\s|$)/.test(t))
    return !t
      .replace(/^([*+-]|\d+\.)\s*/, "")
      .replace(LINK, "")
      .trim();
  const links = t.match(LINK)?.length ?? 0;
  return links > 1 && !t.replace(LINK, "").replace(/[|·•,\s]/g, "");
}

/** Paragraph-sized blocks of the page's real content. */
export function contentBlocks(markdown: string): string[] {
  const blocks = markdown
    .replace(IMAGE, "")
    .split("\n")
    .filter((l) => !isNavLine(l))
    .join("\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  // A heading whose section was all navigation leaves an orphan: drop it.
  return blocks
    .filter(
      (b, i) =>
        !(HEADING_ONLY.test(b) && (i === blocks.length - 1 || HEADING_ONLY.test(blocks[i + 1])))
    )
    .map((b) => truncate(b, 2000));
}

/**
 * Fits a page into `budget` characters for the model: navigation stripped, then the opening plus
 * the passages that mention the focus terms (and prices, when the focus asks about cost), in page
 * order with […] marking skipped stretches.
 */
export function focusPage(
  markdown: string,
  focus: string,
  budget: number
): { text: string; trimmed: boolean } {
  const blocks = contentBlocks(markdown);
  const full = blocks.join("\n\n");
  if (full.length <= budget) return { text: full, trimmed: false };
  const terms = queryTerms(focus);
  if (!terms.length) return { text: truncate(full, budget), trimmed: true };
  const money = PRICE_INTENT.test(focus);
  const score = blocks.map((b) => {
    const c = coverage(terms, b);
    return c + (money && MONEY.test(b) ? 1 : 0) + (c > 0 && /\d/.test(b) ? 0.1 : 0);
  });

  const keep = new Set<number>();
  let used = 0;
  const take = (i: number) => {
    keep.add(i);
    used += blocks[i].length + 2;
  };
  for (let i = 0; i < blocks.length && used + blocks[i].length <= budget / 6; i++) take(i);
  const ranked = blocks
    .map((_, i) => i)
    .filter((i) => score[i] > 0 && !keep.has(i))
    .sort((a, b) => score[b] - score[a] || a - b);
  for (const i of ranked) {
    // A short block right above a hit is usually its label ("iPhone Duo" over "From $1999").
    const add = [i - 1, i].filter(
      (j) => j >= 0 && !keep.has(j) && (j === i || blocks[j].length < 200)
    );
    const cost = add.reduce((s, j) => s + blocks[j].length + 2, 0);
    if (used + cost > budget) continue;
    add.forEach(take);
  }

  let text = "";
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    text += text ? (i === prev + 1 ? "\n\n" : "\n\n[…]\n\n") : "";
    text += blocks[i];
    prev = i;
  }
  return { text, trimmed: true };
}
