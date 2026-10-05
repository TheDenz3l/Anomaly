/// <reference types="node" />
"use node";

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { vSearchProvider } from "../lib/validators";
import type { SearchOutcome, SearchResult, Recency } from "./providers";
import type { ReadOutcome } from "./read";

/**
 * Web access engine: pi-web-access (github.com/nicobailon/pi-web-access) in a Node action.
 * Search runs the user's own provider, then the server SearXNG instance, then pi's auto chain
 * (Exa — keyless over MCP unless EXA_API_KEY is set — then Brave/Tavily/Firecrawl/Jina when keyed
 * in the deployment env), then keyless DuckDuckGo and Keenable. Reads go through Readability/Defuddle
 * to Markdown (PDFs via unpdf), with Firecrawl and the keyless Jina Reader behind blocked or
 * JS-rendered pages.
 *
 * pi reads its settings from a JSON file once per process and its keys from process.env on every
 * call, so the static config is written to /tmp before the first import and per-user keys are
 * swapped into process.env for one serialized call at a time.
 */

const DIR = join(tmpdir(), "pi-web-access");
const CONFIG = {
  webSearch: {
    allowedProviders: [
      "searxng",
      "exa",
      "brave",
      "tavily",
      "firecrawl",
      "jina",
      "duckduckgo",
      "keenable",
    ],
  },
  fetchRouting: { providers: ["http", "firecrawl", "jina"], allowRemoteHostedProviders: true },
  githubClone: { enabled: false },
  githubPrIssue: { enabled: false },
  youtube: { enabled: false },
};
const KEY_ENV = {
  brave: "BRAVE_API_KEY",
  tavily: "TAVILY_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
} as const;
const KEYLESS = ["duckduckgo", "keenable"] as const;
const MAX_TEXT = 150_000;
const PDF_SAVED = /^PDF extracted and saved to: (.+)$/m;

/** The slice of pi-web-access this file uses (gemini-search.ts `search`, extract.ts `extractContent`). */
type Pi = {
  search(
    query: string,
    options: { numResults?: number; recencyFilter?: Recency; provider?: string }
  ): Promise<{
    provider?: string;
    answer?: string;
    results: { title: string; url: string; snippet: string }[];
    inlineContent?: { url: string; content: string }[];
  }>;
  extract(
    url: string,
    signal?: AbortSignal,
    options?: { rejectDirectImages?: string }
  ): Promise<{
    url: string;
    title: string;
    content: string;
    error: string | null;
    mimeType?: string;
  }>;
};

type Step = {
  id: string;
  role: "own" | "pool" | "chain";
  env: Record<string, string | undefined>;
};

let loaded: Promise<Pi> | null = null;

function pi(): Promise<Pi> {
  loaded ??= (async () => {
    process.env.PI_CODING_AGENT_DIR = DIR;
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "web-search.json"), JSON.stringify(CONFIG));
    // The package ships TypeScript sources that only typecheck inside a Pi install. The `as string`
    // keeps tsc out of them (typed by Pi above); esbuild drops the cast and still bundles both.
    const [s, x] = await Promise.all([
      import("pi-web-access/gemini-search.ts" as string),
      import("pi-web-access/extract.ts" as string),
    ]);
    return { search: s.search, extract: x.extractContent };
  })().catch((e) => {
    loaded = null;
    throw e;
  });
  return loaded;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs fn with env overrides applied; calls are serialized so overrides never leak across users. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const prev = Object.keys(vars).map((k) => [k, process.env[k]] as const);
    const set = (k: string, val: string | undefined) => {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    };
    for (const [k, val] of Object.entries(vars)) set(k, val);
    try {
      return await fn();
    } finally {
      for (const [k, val] of prev) set(k, val);
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const firstLine = (s: string) =>
  s
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? s;
const authStatus = (s: string) =>
  /\b40[123]\b|unauthori[sz]ed|invalid[^.]{0,30}(key|token)|TOKEN_INVALID/i.test(s)
    ? Number(s.match(/\b(40[123])\b/)?.[1] ?? 401)
    : 0;

/** Exa's keyless MCP returns bare results and puts the excerpts in the answer as "…\nSource: T (url)". */
function excerpts(answer: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of answer.matchAll(
    /([\s\S]*?)\nSource: [^\n]*\((https?:\/\/[^)\s]+)\)(?:\n\n|$)/g
  )) {
    out.set(m[2], m[1].replace(/\s+/g, " ").trim());
  }
  return out;
}

function normalize(
  r: Awaited<ReturnType<Pi["search"]>>,
  provider: string,
  limit: number
): SearchResult[] {
  const fromAnswer = excerpts(r.answer ?? "");
  const inline = new Map((r.inlineContent ?? []).map((c) => [c.url, c.content]));
  const seen = new Set<string>();
  return r.results
    .filter((x) => /^https?:\/\//.test(x.url) && !seen.has(x.url) && seen.add(x.url))
    .slice(0, limit)
    .map((x) => ({
      url: x.url,
      title: x.title || x.url,
      snippet: (x.snippet || fromAnswer.get(x.url) || inline.get(x.url) || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500),
      provider,
    }));
}

export const search = internalAction({
  args: {
    query: v.string(),
    limit: v.number(),
    recency: v.optional(
      v.union(v.literal("day"), v.literal("week"), v.literal("month"), v.literal("year"))
    ),
    own: v.optional(
      v.object({
        provider: vSearchProvider,
        key: v.optional(v.string()),
        url: v.optional(v.string()),
      })
    ),
    searxng: v.optional(v.string()),
  },
  handler: async (_ctx, { query, limit, recency, own, searxng }): Promise<SearchOutcome> => {
    const engine = await pi();
    const opts = { numResults: limit, ...(recency ? { recencyFilter: recency } : {}) };
    const errors: string[] = [];
    let ownStatus = 0;
    let searxngFailed = false;

    const steps: Step[] = [];
    if (own?.provider === "searxng" && own.url) {
      steps.push({ id: "searxng", role: "own", env: { SEARXNG_BASE_URL: own.url } });
    } else if (own && own.provider !== "none" && own.provider !== "searxng" && own.key) {
      steps.push({ id: own.provider, role: "own", env: { [KEY_ENV[own.provider]]: own.key } });
    }
    if (searxng) steps.push({ id: "searxng", role: "pool", env: { SEARXNG_BASE_URL: searxng } });
    steps.push({ id: "auto", role: "chain", env: { SEARXNG_BASE_URL: undefined } });
    for (const id of KEYLESS) steps.push({ id, role: "chain", env: {} });

    for (const step of steps) {
      try {
        const r = await withEnv(step.env, () =>
          engine.search(query, { ...opts, provider: step.id })
        );
        const provider = r.provider ?? step.id;
        const results = normalize(r, provider, limit);
        if (results.length) return { results, provider, errors, ownStatus, searxngFailed };
        if (step.role === "pool") searxngFailed = true;
      } catch (e) {
        errors.push(`${step.id}: ${firstLine(message(e)).slice(0, 160)}`);
        if (step.role === "own") ownStatus = authStatus(message(e));
        if (step.role === "pool") searxngFailed = true;
      }
    }
    return { results: [], provider: "none", errors, ownStatus, searxngFailed };
  },
});

export const read = internalAction({
  args: { url: v.string(), firecrawlKey: v.optional(v.string()) },
  handler: async (_ctx, { url, firecrawlKey }): Promise<ReadOutcome> => {
    const engine = await pi();
    const r = await withEnv(firecrawlKey ? { FIRECRAWL_API_KEY: firecrawlKey } : {}, () =>
      engine.extract(url, AbortSignal.timeout(45_000), {
        rejectDirectImages: "Images can't be read as text.",
      })
    );
    if (r.error) return { ok: false, error: firstLine(r.error).slice(0, 300) };
    let text = r.content;
    let contentType = r.mimeType ?? "text/html";
    const saved = text.match(PDF_SAVED);
    if (saved) {
      text = readFileSync(saved[1], "utf8");
      rmSync(saved[1], { force: true });
      contentType = "application/pdf";
    }
    return {
      ok: true,
      url: r.url || url,
      title: r.title,
      text: text.slice(0, MAX_TEXT),
      contentType,
    };
  },
});
