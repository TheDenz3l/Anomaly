import type { Citation, StreamEvent } from "./openai";

/**
 * The ChatGPT subscription backend (the one Codex uses) speaks OpenAI's Responses API, not chat
 * completions. streamChat stays in chat-completions shape everywhere else; this turns its request
 * into a Responses request and the Responses event stream back into StreamEvents.
 */

export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";

export function isCodex(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.hostname === "chatgpt.com" && u.pathname.startsWith("/backend-api/codex");
  } catch {
    return false;
  }
}

export function responsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

type Item = Record<string, unknown>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

function userContent(content: unknown): Item[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [{ type: "input_text", text: "" }];
  const out: Item[] = [];
  for (const p of content) {
    if (p?.type === "text") out.push({ type: "input_text", text: String(p.text ?? "") });
    else if (p?.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (typeof url === "string") out.push({ type: "input_image", image_url: url });
    }
  }
  return out.length ? out : [{ type: "input_text", text: "" }];
}

/** Chat-completions fields the Responses backend rejects or names differently. */
const NOT_SENT = new Set([
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "n",
  "stop",
  "response_format",
  "service_tier",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "web_search_options",
  "plugins",
  "verbosity",
]);

export function toResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const instructions: string[] = [];
  const input: Item[] = [];
  for (const m of (body.messages as Item[] | undefined) ?? []) {
    const role = m.role;
    if (role === "system") {
      // The first system message is the instructions; later ones are notes from the developer.
      if (!input.length) instructions.push(textOf(m.content));
      else
        input.push({
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: textOf(m.content) }],
        });
    } else if (role === "user") {
      input.push({ type: "message", role: "user", content: userContent(m.content) });
    } else if (role === "assistant") {
      const text = textOf(m.content);
      if (text)
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      for (const tc of (m.tool_calls as Item[] | undefined) ?? []) {
        const fn = (tc.function ?? {}) as { name?: string; arguments?: string };
        input.push({
          type: "function_call",
          call_id: String(tc.id ?? ""),
          name: String(fn.name ?? ""),
          arguments: fn.arguments || "{}",
        });
      }
    } else if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: String(m.tool_call_id ?? ""),
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
    }
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (!NOT_SENT.has(k)) out[k] = v;
  out.instructions = instructions.filter(Boolean).join("\n\n") || "You are a helpful assistant.";
  out.input = input;
  out.store = false;
  out.stream = true;

  const tools = ((body.tools as Item[] | undefined) ?? [])
    .filter((t) => t?.type === "function")
    .map((t) => {
      const fn = t.function as { name: string; description?: string; parameters?: unknown };
      return {
        type: "function",
        name: fn.name,
        description: fn.description ?? "",
        parameters: fn.parameters ?? { type: "object", properties: {} },
        strict: false,
      };
    });
  if (tools.length) {
    out.tools = tools;
    const choice = body.tool_choice as string | { function?: { name?: string } } | undefined;
    out.tool_choice =
      typeof choice === "string"
        ? choice
        : choice?.function?.name
          ? { type: "function", name: choice.function.name }
          : "auto";
    out.parallel_tool_calls = true;
  }

  const effort =
    (body.reasoning as { effort?: unknown } | undefined)?.effort ?? body.reasoning_effort;
  if (typeof effort === "string" && effort !== "off" && effort !== "none") {
    out.reasoning = { effort, summary: "auto" };
    out.include = ["reasoning.encrypted_content"];
  }
  return out;
}

/** The failure an event reports, if it is one (an error event, or the response itself failing). */
export function responsesError(ev: any): { message: string; status: number } | null {
  if (ev?.type === "error") {
    const message = String(ev.message ?? ev.error?.message ?? "The provider ended the reply.");
    return { message, status: /rate|limit|usage/i.test(message) ? 429 : 500 };
  }
  if (ev?.type === "response.failed") {
    const err = ev.response?.error ?? {};
    const message = String(err.message ?? "The provider couldn't finish the reply.");
    const code = String(err.code ?? "");
    return {
      message,
      status: /rate_limit|usage_limit|quota/.test(code) || /limit/i.test(message) ? 429 : 500,
    };
  }
  return null;
}

/** Turns Responses stream events into the StreamEvents the loop consumes. */
export class ResponsesParser {
  private calls = new Map<number, { streamed: boolean }>();
  private nextIndex = 0;
  private usage: StreamEvent | null = null;
  private finish: string | null = null;

  private indexOf(ev: any): number {
    return typeof ev?.output_index === "number" ? ev.output_index : this.nextIndex;
  }

  *push(ev: any): Generator<StreamEvent> {
    switch (ev?.type) {
      case "response.output_text.delta":
        if (ev.delta) yield { type: "text", delta: String(ev.delta) };
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (ev.delta) yield { type: "reasoning", delta: String(ev.delta) };
        break;
      case "response.reasoning_summary_part.done":
        yield { type: "reasoning", delta: "\n\n" };
        break;
      case "response.output_item.added":
        if (ev.item?.type === "function_call") {
          const index = this.indexOf(ev);
          this.nextIndex = Math.max(this.nextIndex, index + 1);
          this.calls.set(index, { streamed: false });
          yield {
            type: "tool_call",
            index,
            id: ev.item.call_id,
            name: ev.item.name,
            args: "",
          };
        }
        break;
      case "response.function_call_arguments.delta": {
        const index = this.indexOf(ev);
        const call = this.calls.get(index);
        if (call) call.streamed = true;
        if (ev.delta) yield { type: "tool_call", index, args: String(ev.delta) };
        break;
      }
      case "response.output_item.done":
        if (ev.item?.type === "function_call") {
          const index = this.indexOf(ev);
          const call = this.calls.get(index);
          const args = typeof ev.item.arguments === "string" ? ev.item.arguments : "";
          if (!call) {
            this.calls.set(index, { streamed: true });
            this.nextIndex = Math.max(this.nextIndex, index + 1);
            yield { type: "tool_call", index, id: ev.item.call_id, name: ev.item.name, args };
          } else if (!call.streamed && args) {
            call.streamed = true;
            yield { type: "tool_call", index, args };
          }
        }
        break;
      case "response.output_text.annotation.added": {
        const a = ev.annotation;
        if (a?.type === "url_citation" && typeof a.url === "string") {
          const item: Citation = { url: a.url, title: String(a.title ?? a.url), snippet: "" };
          yield { type: "citations", items: [item] };
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const u = ev.response?.usage;
        if (u) {
          const r = u.output_tokens_details?.reasoning_tokens;
          this.usage = {
            type: "usage",
            usage: {
              promptTokens: Number(u.input_tokens ?? 0),
              completionTokens: Number(u.output_tokens ?? 0),
              reasoningTokens: Number(r ?? 0),
              reportsReasoning: r !== undefined && r !== null,
            },
          };
        }
        this.finish =
          ev.type === "response.incomplete" ? "length" : this.calls.size ? "tool_calls" : "stop";
        break;
      }
    }
  }

  *end(): Generator<StreamEvent> {
    if (this.usage) yield this.usage;
    if (this.finish) yield { type: "finish", reason: this.finish };
  }

  /** A whole (non-streamed) response, read as if it had streamed. */
  *replay(json: any): Generator<StreamEvent> {
    const output: any[] = Array.isArray(json?.output) ? json.output : [];
    output.forEach((item, index) => {
      if (item?.type === "function_call") this.calls.set(index, { streamed: true });
    });
    for (const [index, item] of output.entries()) {
      if (item?.type === "message") {
        for (const c of item.content ?? [])
          if (c?.type === "output_text" && c.text) yield { type: "text", delta: String(c.text) };
      } else if (item?.type === "reasoning") {
        for (const s of item.summary ?? [])
          if (s?.text) yield { type: "reasoning", delta: String(s.text) };
      } else if (item?.type === "function_call") {
        yield {
          type: "tool_call",
          index,
          id: item.call_id,
          name: item.name,
          args: typeof item.arguments === "string" ? item.arguments : "",
        };
      }
    }
    yield* this.push({ type: "response.completed", response: json });
    yield* this.end();
  }
}
