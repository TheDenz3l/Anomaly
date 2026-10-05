import { useEffect, useSyncExternalStore } from "react";
import { api, convex } from "@/lib/convex";

/**
 * Links in message text. The composer writes them as Markdown, `[Page title](url)`, so the model
 * sees both; older or typed text may hold bare http(s) URLs, which render the same way.
 */

export type LinkSegment =
  { type: "text"; text: string } | { type: "link"; title: string; url: string; raw: string };

const TOKEN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"'`]+/g;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function domainOf(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
}

/** Drops punctuation that ends the sentence rather than the URL: "see https://x.com." or "(https://x.com)". */
export function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    let next = url.replace(/[.,!?;:'"*_]+$/, "");
    if (next.endsWith(")") && next.split(")").length > next.split("(").length)
      next = next.slice(0, -1);
    if (next === url) return url;
    url = next;
  }
}

/** Splits text into plain runs and links. `bare` also treats loose URLs as links. */
export function parseLinks(text: string, bare = true): LinkSegment[] {
  const out: LinkSegment[] = [];
  let last = 0;
  const pushText = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev?.type === "text") out[out.length - 1] = { type: "text", text: prev.text + t };
    else out.push({ type: "text", text: t });
  };
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (m[1] !== undefined) {
      pushText(text.slice(last, at));
      out.push({ type: "link", title: m[1], url: m[2], raw: m[0] });
      last = at + m[0].length;
    } else if (bare) {
      const url = trimUrl(m[0]);
      if (!/^https?:\/\/[^/\s]+\.[^/\s]/.test(url)) continue;
      pushText(text.slice(last, at));
      out.push({ type: "link", title: "", url, raw: url });
      last = at + url.length;
    }
  }
  pushText(text.slice(last));
  return out;
}

/** Markdown for one link. Brackets in the title or parentheses in the URL would end it early. */
export function linkMarkup(title: string, url: string): string {
  const t = title.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || domainOf(url);
  return `[${t}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
}

/** Text with each Markdown link replaced by its URL, for copying. */
export function withLinkUrls(text: string): string {
  return text.replace(MARKDOWN_LINK, "$2");
}

/** Text with each Markdown link reduced to its title, for chat titles and other plain-text spots. */
export function withoutLinkMarkup(text: string): string {
  return text.replace(MARKDOWN_LINK, "$1");
}

const titles = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The page's title, fetched once per session through the server. Null when the page has none. */
export function fetchLinkTitle(url: string): Promise<string | null> {
  if (titles.has(url)) return Promise.resolve(titles.get(url) ?? null);
  const inflight = pending.get(url);
  if (inflight) return inflight;
  const request = convex
    .action(api.links.preview, { url })
    .then(({ title }) => {
      titles.set(url, title);
      listeners.forEach((l) => l());
      return title;
    })
    .catch(() => null)
    .finally(() => pending.delete(url));
  pending.set(url, request);
  return request;
}

/** Title for a bare URL: undefined while loading, null when the page has none. */
export function useLinkTitle(url: string): string | null | undefined {
  const title = useSyncExternalStore(
    subscribe,
    () => titles.get(url),
    () => titles.get(url)
  );
  useEffect(() => {
    void fetchLinkTitle(url);
  }, [url]);
  return title;
}
