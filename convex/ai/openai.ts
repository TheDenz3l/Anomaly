import { isCodex, responsesError, ResponsesParser, responsesUrl, toResponsesBody } from "./codex";
import {
  anthropicHost,
  MessagesParser,
  messagesUrl,
  prefersMessages,
  routeToMessages,
  streamErrorStatus,
  toMessagesBody,
  unrouteMessages,
  wantsMessages,
  flipThinking,
} from "./anthropic";

/**
 * Minimal OpenAI-compatible client (PRD §3.4): streaming /chat/completions with an adapter
 * layer for the dialects real endpoints speak — reasoning_content / reasoning / <think> tags,
 * url_citation annotations, usage with reasoning tokens, and plain-JSON (non-SSE) replies.
 */

export type Endpoint = {
  baseUrl: string;
  apiKey?: string;
  headers?: { key: string; value: string }[];
};

export type ContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** True when the endpoint reported a reasoning-token count at all (so 0 means "none used"). */
  reportsReasoning: boolean;
  costUsd?: number;
};

export type Citation = { url: string; title: string; snippet: string };

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string; tagged?: boolean }
  | { type: "tool_call"; index: number; id?: string; name?: string; args: string }
  | { type: "citations"; items: Citation[] }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: string };

export type ErrorKind =
  | "bad_param"
  | "rate_limit"
  | "auth"
  | "context_overflow"
  | "not_found"
  | "server"
  | "network"
  | "unknown";

export class LlmError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
    public kind: ErrorKind,
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** A URL fit for messages: scheme, host and path, never credentials or the query string. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "the provider";
  }
}

/** Runtime error messages can quote the URL they failed on, key in the query and all. */
const scrub = (msg: string) => msg.replace(/https?:\/\/[^\s"'<>)]+/g, (u) => displayUrl(u));

export function authHeaders(ep: Endpoint, json = true): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (ep.apiKey) {
    // Anthropic's own API takes its key in x-api-key; a bearer token there means OAuth.
    if (anthropicHost(ep.baseUrl)) {
      h["x-api-key"] = ep.apiKey;
      h["anthropic-version"] = "2023-06-01";
    } else h.Authorization = `Bearer ${ep.apiKey}`;
  }
  for (const { key, value } of ep.headers ?? []) if (key.trim()) h[key.trim()] = value;
  return h;
}

const MAX_REDIRECTS = 3;

/**
 * fetch for provider requests, which carry the key and custom headers: redirects are followed
 * only within the same origin, so those never reach another host.
 */
export async function providerFetch(url: string, init: RequestInit): Promise<Response> {
  let target = url;
  let req: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, req);
    if (res.type === "opaqueredirect") {
      throw new LlmError(
        `${displayUrl(url)} redirected the request elsewhere. Use the address it redirects to as the base URL.`,
        0,
        "",
        "unknown"
      );
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    void res.body?.cancel().catch(() => {});
    const next = new URL(location, target);
    if (next.origin !== new URL(target).origin) {
      throw new LlmError(
        `${displayUrl(target)} redirected to ${next.host}, and keys are only sent to the host you saved. If you trust it, use ${displayUrl(next.toString())} as the base URL.`,
        res.status,
        "",
        "unknown"
      );
    }
    if (hop >= MAX_REDIRECTS) {
      throw new LlmError(
        `${displayUrl(url)} redirected too many times.`,
        res.status,
        "",
        "unknown"
      );
    }
    if (res.status === 303) req = { ...req, method: "GET", body: undefined };
    target = next.toString();
  }
}

const OVERFLOW =
  /context.?length|maximum context|context window|too many tokens|prompt is too long|reduce the length|input is too long/;
/** Out of credit: OpenAI answers it with a 429, but waiting won't help. */
const OUT_OF_CREDIT =
  /insufficient_quota|exceeded your current quota|billing|insufficient (?:balance|credits?|funds)|credit balance is too low|payment required/;

export function classifyError(status: number, body: string): ErrorKind {
  const b = body.toLowerCase();
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  if (status === 402 || OUT_OF_CREDIT.test(b)) return "auth";
  if (status === 429) return "rate_limit";
  if (OVERFLOW.test(b)) return "context_overflow";
  if (/invalid api key|incorrect api key|unauthori[sz]ed/.test(b)) return "auth";
  if (/rate.?limit|too many requests|quota/.test(b)) return "rate_limit";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_param";
  return "unknown";
}

function providerMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail;
    if (typeof m === "string") return m;
    if (m) return JSON.stringify(m);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 300) || "no details";
}

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export async function requestJson(
  ep: Endpoint,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<any> {
  if (init.signal?.aborted) throw new LlmError("The request was cancelled.", 0, "", "network");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  const onAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let res: Response;
    let text: string;
    try {
      res = await providerFetch(joinUrl(ep.baseUrl, path), {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: authHeaders(ep, init.body !== undefined),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      // Read under the same timer: a provider can stall while sending its answer, error or not.
      text = await res.text();
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (controller.signal.aborted && !init.signal?.aborted)
        throw new LlmError(`${displayUrl(ep.baseUrl)} didn't respond in time.`, 0, "", "network");
      throw new LlmError(
        `Could not reach ${displayUrl(ep.baseUrl)}: ${scrub((e as Error).message)}`,
        0,
        "",
        "network"
      );
    }
    if (!res.ok) {
      throw new LlmError(
        `${res.status} from provider: ${providerMessage(text)}`,
        res.status,
        text,
        classifyError(res.status, text),
        retryAfter(res)
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new LlmError("Provider returned non-JSON", res.status, text.slice(0, 500), "unknown");
    }
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

function parseUsage(u: any): Usage {
  const details = u?.completion_tokens_details ?? u?.output_tokens_details;
  const r = details?.reasoning_tokens ?? u?.reasoning_tokens;
  return {
    promptTokens: Number(u?.prompt_tokens ?? u?.input_tokens ?? 0),
    completionTokens: Number(u?.completion_tokens ?? u?.output_tokens ?? 0),
    reasoningTokens: Number(r ?? 0),
    reportsReasoning: r !== undefined && r !== null,
    costUsd: typeof u?.cost === "number" ? u.cost : undefined,
  };
}

function parseCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  for (const a of raw) {
    const c = a?.url_citation ?? a;
    if (a?.type && a.type !== "url_citation") continue;
    if (typeof c?.url !== "string") continue;
    out.push({ url: c.url, title: String(c.title ?? c.url), snippet: String(c.content ?? "") });
  }
  return out;
}

/** Routes text inside <think>…</think> to reasoning, across arbitrary chunk boundaries. */
export class ThinkSplitter {
  private inThink = false;
  private pending = "";
  seen = false;

  *push(text: string): Generator<StreamEvent> {
    let s = this.pending + text;
    this.pending = "";
    while (s.length > 0) {
      const tag = this.inThink ? "</think>" : "<think>";
      const i = s.indexOf(tag);
      if (i >= 0) {
        if (i > 0) yield this.emit(s.slice(0, i));
        this.inThink = !this.inThink;
        if (this.inThink) this.seen = true;
        s = s.slice(i + tag.length);
        continue;
      }
      let keep = 0;
      for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
        if (tag.startsWith(s.slice(-k))) {
          keep = k;
          break;
        }
      }
      const out = s.slice(0, s.length - keep);
      if (out) yield this.emit(out);
      this.pending = s.slice(s.length - keep);
      break;
    }
  }

  *flush(): Generator<StreamEvent> {
    if (this.pending) yield this.emit(this.pending);
    this.pending = "";
  }

  private emit(t: string): StreamEvent {
    return this.inThink
      ? { type: "reasoning", delta: t, tagged: true }
      : { type: "text", delta: t };
  }
}

function* parseChunk(chunk: any, think: ThinkSplitter): Generator<StreamEvent> {
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta ?? choice?.message ?? {};
  const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
  if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", delta: reasoning };
  if (typeof delta.content === "string" && delta.content) yield* think.push(delta.content);
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      yield {
        type: "tool_call",
        index: typeof tc.index === "number" ? tc.index : 0,
        id: tc.id ?? undefined,
        name: tc.function?.name ?? undefined,
        args:
          typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : tc.function?.arguments
              ? JSON.stringify(tc.function.arguments)
              : "",
      };
    }
  }
  const cites = parseCitations(delta.annotations ?? choice?.message?.annotations);
  // Perplexity-style: a top-level list of cited URLs.
  if (Array.isArray(chunk?.citations)) {
    for (const url of chunk.citations)
      if (typeof url === "string") cites.push({ url, title: url, snippet: "" });
  }
  if (cites.length) yield { type: "citations", items: cites };
  if (choice?.finish_reason) yield { type: "finish", reason: String(choice.finish_reason) };
  if (chunk?.usage) yield { type: "usage", usage: parseUsage(chunk.usage) };
}

/** A 400 from the Messages API that is about the thinking settings, not the request as a whole. */
const THINKING_ERROR = /thinking|adaptive|budget_tokens|effort/i;

/**
 * Streams one chat completion. Throws LlmError before the first event on HTTP failure.
 * `rerouted` marks the one retry on the other API, so a route can't bounce back and forth.
 */
export async function* streamChat(
  ep: Endpoint,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  idleMs = 180_000,
  rerouted = false
): AsyncGenerator<StreamEvent> {
  if (signal?.aborted) return;
  // Abort if the provider goes silent (reasoning models may think quietly, so the window is generous).
  const local = new AbortController();
  let stalled = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const bump = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      stalled = true;
      local.abort();
    }, idleMs);
  };
  const onOuter = () => local.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  // A ChatGPT subscription is served over the Responses API. Some gateways serve certain models
  // only over the Anthropic Messages API, and Anthropic's own API is best spoken natively.
  const codex = isCodex(ep.baseUrl);
  const messages = !codex && (prefersMessages(ep.baseUrl, body.model) || anthropicHost(ep.baseUrl));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let again = false;
  try {
    bump();
    let res: Response;
    try {
      res = await providerFetch(
        codex
          ? responsesUrl(ep.baseUrl)
          : messages
            ? messagesUrl(ep.baseUrl)
            : joinUrl(ep.baseUrl, "/chat/completions"),
        {
          method: "POST",
          headers: messages
            ? {
                "anthropic-version": "2023-06-01",
                ...(ep.apiKey ? { "x-api-key": ep.apiKey } : {}),
                ...authHeaders(ep),
                Accept: "text/event-stream",
              }
            : { ...authHeaders(ep), Accept: "text/event-stream" },
          body: JSON.stringify(
            codex
              ? toResponsesBody(body)
              : messages
                ? toMessagesBody(body)
                : { ...body, stream: true }
          ),
          signal: local.signal,
        }
      );
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof LlmError) throw e;
      if (stalled) throw new LlmError("The provider didn't respond in time.", 0, "", "network");
      throw new LlmError(
        `Could not reach ${displayUrl(ep.baseUrl)}: ${scrub((e as Error).message)}`,
        0,
        "",
        "network"
      );
    }
    if (!res.ok) {
      // Still under the idle timer and the caller's signal: a provider can stall mid-error too.
      let text = "";
      try {
        text = await res.text();
      } catch {
        if (signal?.aborted) return;
        if (stalled) throw new LlmError("The provider didn't respond in time.", 0, "", "network");
      }
      // Claude models differ in which thinking style they accept; a rejected one gets the other.
      const thinks = "thinking" in body || "reasoning" in body || "reasoning_effort" in body;
      if (
        !messages &&
        (res.status === 400 || res.status === 404) &&
        wantsMessages(text) &&
        routeToMessages(ep.baseUrl, body.model)
      ) {
        again = true;
      } else if (messages && res.status === 404) {
        // The Messages endpoint isn't there after all: back to chat completions.
        unrouteMessages(ep.baseUrl, body.model);
        if (!rerouted) again = true;
      } else if (
        messages &&
        res.status === 400 &&
        thinks &&
        THINKING_ERROR.test(text) &&
        flipThinking(body.model)
      ) {
        again = true;
      }
      if (!again) {
        throw new LlmError(
          `${res.status} from provider: ${providerMessage(text)}`,
          res.status,
          text,
          classifyError(res.status, text),
          retryAfter(res)
        );
      }
    } else {
      const think = new ThinkSplitter();
      const parser = codex ? new ResponsesParser() : messages ? new MessagesParser() : null;
      const ctype = res.headers.get("content-type") ?? "";
      if (!res.body || ctype.includes("application/json")) {
        const json = await res.json();
        clearTimeout(idle);
        if (parser) yield* parser.replay(json);
        else yield* parseChunk(json, think);
        yield* think.flush();
      } else {
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let doneMarker = false;
        let finished = false;
        const handle = function* (raw: string): Generator<StreamEvent> {
          const line = raw.trim();
          if (!line.startsWith("data:")) return;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            doneMarker = true;
            return;
          }
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            return;
          }
          if (chunk?.error) {
            const msg =
              typeof chunk.error === "string"
                ? chunk.error
                : String(chunk.error.message ?? "Provider error");
            const status = streamErrorStatus(chunk.error);
            throw new LlmError(msg, status, data, classifyError(status, data));
          }
          if (codex) {
            const failed = responsesError(chunk);
            if (failed)
              throw new LlmError(
                failed.message,
                failed.status,
                data,
                classifyError(failed.status, data)
              );
          }
          if (parser) {
            if (
              chunk?.type === "message_stop" ||
              chunk?.type === "response.completed" ||
              chunk?.type === "response.incomplete"
            )
              finished = true;
            yield* parser.push(chunk);
          } else {
            for (const ev of parseChunk(chunk, think)) {
              if (ev.type === "finish") finished = true;
              yield ev;
            }
          }
        };
        read: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bump();
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            yield* handle(line);
            if (doneMarker) break read;
          }
        }
        // The last event may arrive without a newline after it.
        if (!doneMarker) {
          buf += decoder.decode();
          if (buf.trim()) yield* handle(buf);
        }
        if (!doneMarker && !finished)
          throw new LlmError("The provider stopped mid-reply.", 0, "", "network");
        if (parser) yield* parser.end();
        yield* think.flush();
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    if (e instanceof LlmError) throw e;
    if (stalled) throw new LlmError("The provider stopped responding mid-reply.", 0, "", "network");
    throw e;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener("abort", onOuter);
    // Releasing the lock leaves the connection open; cancel it on every way out. Aborting as well
    // would close the body a second time, which the runtime reports as an uncaught error.
    if (reader) reader.cancel().catch(() => {});
    else if (!local.signal.aborted) local.abort();
  }
  if (again) yield* streamChat(ep, body, signal, idleMs, true);
}

export type Completion = {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  citations: Citation[];
  usage: Usage | null;
  finish: string | null;
};

/** Accumulates tool-call deltas by index into complete calls. */
export class ToolCallAccumulator {
  private calls = new Map<number, { id: string; name: string; args: string; synthetic: boolean }>();

  push(ev: Extract<StreamEvent, { type: "tool_call" }>): { index: number; isNew: boolean } {
    const cur = this.calls.get(ev.index);
    if (!cur) {
      this.calls.set(ev.index, {
        id: ev.id ?? `call_${ev.index}_${Math.random().toString(36).slice(2, 8)}`,
        name: ev.name ?? "",
        args: ev.args,
        synthetic: !ev.id,
      });
      return { index: ev.index, isNew: true };
    }
    if (ev.id && cur.synthetic) {
      cur.id = ev.id;
      cur.synthetic = false;
    }
    if (ev.name) cur.name = cur.name && cur.name !== ev.name ? cur.name + ev.name : ev.name;
    cur.args += ev.args;
    return { index: ev.index, isNew: false };
  }

  get(index: number) {
    return this.calls.get(index);
  }

  entries(): { index: number; call: ToolCall }[] {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([index, c]) => ({
        index,
        call: {
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.args || "{}" },
        },
      }));
  }

  list(): ToolCall[] {
    return this.entries().map((e) => e.call);
  }
}

/** Non-interactive call: same wire format, collected into one result. */
export async function complete(
  ep: Endpoint,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Completion> {
  const out: Completion = {
    text: "",
    reasoning: "",
    toolCalls: [],
    citations: [],
    usage: null,
    finish: null,
  };
  const calls = new ToolCallAccumulator();
  for await (const ev of streamChat(ep, body, signal)) {
    if (ev.type === "text") out.text += ev.delta;
    else if (ev.type === "reasoning") out.reasoning += ev.delta;
    else if (ev.type === "tool_call") calls.push(ev);
    else if (ev.type === "citations") out.citations.push(...ev.items);
    else if (ev.type === "usage") out.usage = ev.usage;
    else if (ev.type === "finish") out.finish = ev.reason;
  }
  out.toolCalls = calls.list();
  return out;
}

export async function listModels(ep: Endpoint): Promise<any[]> {
  const json = await requestJson(ep, "/models", { timeoutMs: 20_000 });
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.models)) return json.models;
  return [];
}

export async function embed(
  ep: Endpoint,
  model: string,
  input: string[],
  dimensions?: number
): Promise<number[][]> {
  const body: Record<string, unknown> = { model, input };
  if (dimensions) body.dimensions = dimensions;
  let json: any;
  try {
    json = await requestJson(ep, "/embeddings", { body, timeoutMs: 30_000 });
  } catch (e) {
    if (dimensions && e instanceof LlmError && e.kind === "bad_param") {
      json = await requestJson(ep, "/embeddings", { body: { model, input }, timeoutMs: 30_000 });
    } else throw e;
  }
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  return data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding as number[]);
}
