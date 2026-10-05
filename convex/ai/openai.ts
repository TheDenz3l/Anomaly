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

export function authHeaders(ep: Endpoint, json = true): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (ep.apiKey) h.Authorization = `Bearer ${ep.apiKey}`;
  for (const { key, value } of ep.headers ?? []) if (key.trim()) h[key.trim()] = value;
  return h;
}

export function classifyError(status: number, body: string): ErrorKind {
  const b = body.toLowerCase();
  if (
    /context.?length|maximum context|context window|too many tokens|prompt is too long|reduce the length|input is too long/.test(
      b
    )
  )
    return "context_overflow";
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|incorrect api key|unauthori[sz]ed/.test(b)
  )
    return "auth";
  if (status === 429 || /rate.?limit|too many requests|quota/.test(b)) return "rate_limit";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_param";
  if (status >= 500) return "server";
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  init.signal?.addEventListener("abort", () => controller.abort());
  try {
    let res: Response;
    try {
      res = await fetch(joinUrl(ep.baseUrl, path), {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: authHeaders(ep, init.body !== undefined),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new LlmError(
        `Could not reach ${ep.baseUrl}: ${(e as Error).message}`,
        0,
        "",
        "network"
      );
    }
    const text = await res.text();
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

/** Streams one chat completion. Throws LlmError before the first event on HTTP failure. */
export async function* streamChat(
  ep: Endpoint,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  idleMs = 180_000
): AsyncGenerator<StreamEvent> {
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
  signal?.addEventListener("abort", onOuter);
  bump();
  let res: Response;
  try {
    res = await fetch(joinUrl(ep.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: { ...authHeaders(ep), Accept: "text/event-stream" },
      body: JSON.stringify({ ...body, stream: true }),
      signal: local.signal,
    });
  } catch (e) {
    clearTimeout(idle);
    signal?.removeEventListener("abort", onOuter);
    if (signal?.aborted) return;
    if (stalled) throw new LlmError("The provider didn't respond in time.", 0, "", "network");
    throw new LlmError(`Could not reach ${ep.baseUrl}: ${(e as Error).message}`, 0, "", "network");
  }
  if (!res.ok) {
    clearTimeout(idle);
    signal?.removeEventListener("abort", onOuter);
    const text = await res.text().catch(() => "");
    throw new LlmError(
      `${res.status} from provider: ${providerMessage(text)}`,
      res.status,
      text,
      classifyError(res.status, text),
      retryAfter(res)
    );
  }
  const think = new ThinkSplitter();
  const ctype = res.headers.get("content-type") ?? "";
  if (!res.body || ctype.includes("application/json")) {
    const json = await res.json().finally(() => {
      clearTimeout(idle);
      signal?.removeEventListener("abort", onOuter);
    });
    yield* parseChunk(json, think);
    yield* think.flush();
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield* think.flush();
          return;
        }
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk?.error) {
          const msg =
            typeof chunk.error === "string"
              ? chunk.error
              : (chunk.error.message ?? "Provider error");
          const status = Number(chunk.error.code) || 500;
          throw new LlmError(msg, status, data, classifyError(status, data));
        }
        yield* parseChunk(chunk, think);
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    if (stalled) throw new LlmError("The provider stopped responding mid-reply.", 0, "", "network");
    throw e;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener("abort", onOuter);
    reader.releaseLock?.();
  }
  yield* think.flush();
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
