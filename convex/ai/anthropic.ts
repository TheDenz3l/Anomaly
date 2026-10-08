/**
 * Anthropic Messages adapter for streamChat. Some gateways serve certain models only through
 * /v1/messages; this translates the OpenAI-shaped request into a Messages request and the
 * Messages SSE stream back into StreamEvents, so the loop never sees the difference.
 */
import type { ChatMessage, Citation, ContentPart, StreamEvent, ToolDef } from "./openai";

type Block = Record<string, unknown>;

const routed = new Set<string>();
const routeKey = (baseUrl: string, model: unknown) => `${baseUrl}|${String(model)}`;

/** True when a provider error says the model is only served over the Messages API. */
export function wantsMessages(err: string): boolean {
  return /\/v1\/messages|anthropic[\s-]+(api[\s-]+|messages[\s-]+)?format/i.test(err);
}

export function prefersMessages(baseUrl: string, model: unknown): boolean {
  return routed.has(routeKey(baseUrl, model));
}

export function routeToMessages(baseUrl: string, model: unknown): void {
  routed.add(routeKey(baseUrl, model));
}

export function messagesUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(b) ? `${b}/messages` : `${b}/v1/messages`;
}

/**
 * Thinking blocks (with signatures) from replies that called tools, keyed by the first tool_use id.
 * Anthropic requires them echoed back when thinking stays on through a tool loop, and the
 * OpenAI-shaped history has no slot for them.
 */
const thoughts = new Map<string, Block[]>();

function rememberThoughts(id: string, blocks: Block[]) {
  thoughts.set(id, blocks);
  if (thoughts.size > 500) thoughts.delete(thoughts.keys().next().value as string);
}

const EFFORT_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 24576,
  xhigh: 32000,
  max: 48000,
  on: 8192,
};

function imageBlock(url: string): Block {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m
    ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }
    : { type: "image", source: { type: "url", url } };
}

function userBlocks(content: string | ContentPart[]): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content.flatMap((p): Block[] =>
    p.type === "text"
      ? p.text
        ? [{ type: "text", text: p.text }]
        : []
      : [imageBlock(p.image_url.url)]
  );
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function toolChoice(c: unknown): Block | undefined {
  if (c === "auto") return { type: "auto" };
  if (c === "none") return { type: "none" };
  if (c === "required") return { type: "any" };
  const name = (c as { function?: { name?: string } } | undefined)?.function?.name;
  return name ? { type: "tool", name } : undefined;
}

function thinkingFor(
  body: Record<string, unknown>
): { budget: number; effort: string } | undefined {
  const t = body.thinking as Block | undefined;
  const r = body.reasoning as { max_tokens?: number; effort?: string } | undefined;
  let budget: number | undefined;
  if (t && typeof t === "object") {
    if (t.type !== "enabled") return undefined;
    budget = Number(t.budget_tokens) || 8192;
  } else if (typeof r?.max_tokens === "number") {
    budget = r.max_tokens;
  } else {
    const effort = body.reasoning_effort ?? r?.effort;
    budget = typeof effort === "string" ? EFFORT_BUDGETS[effort] : undefined;
  }
  if (!budget) return undefined;
  budget = Math.max(1024, budget);
  return { budget, effort: budget <= 2048 ? "low" : budget <= 8192 ? "medium" : "high" };
}

/**
 * Claude 5 and later take adaptive thinking with an effort level and reject fixed budgets; older
 * models only know budgets. Guessed from the name, corrected by a rejected request (see flipThinking).
 */
const adaptiveByModel = new Map<string, boolean>();
const flipped = new Set<string>();

function adaptiveFor(model: unknown): boolean {
  const id = String(model);
  return adaptiveByModel.get(id) ?? /claude-(?:[a-z]+-)?(?:[5-9]|\d{2})(?:\b|-)/.test(id);
}

/** After a 400 to a thinking request, tries the other thinking style once per model. */
export function flipThinking(model: unknown): boolean {
  const id = String(model);
  if (flipped.has(id)) return false;
  flipped.add(id);
  adaptiveByModel.set(id, !adaptiveFor(id));
  return true;
}

/** Translates an OpenAI chat/completions body into a streaming Messages request. */
export function toMessagesBody(body: Record<string, unknown>): Record<string, unknown> {
  const tools = Array.isArray(body.tools) ? (body.tools as ToolDef[]) : [];
  const native = tools.length > 0;
  const system: string[] = [];
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of (body.messages as ChatMessage[] | undefined) ?? []) {
    if (m.role === "system") {
      if (m.content) system.push(m.content);
    } else if (m.role === "user") {
      push("user", userBlocks(m.content));
    } else if (m.role === "tool") {
      push(
        "user",
        native
          ? [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content || "(empty)" }]
          : [{ type: "text", text: `Tool result:\n${m.content || "(empty)"}` }]
      );
    } else {
      const calls = m.tool_calls ?? [];
      const blocks: Block[] = native && calls.length ? [...(thoughts.get(calls[0].id) ?? [])] : [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of calls) {
        blocks.push(
          native
            ? {
                type: "tool_use",
                id: c.id,
                name: c.function.name,
                input: parseArgs(c.function.arguments),
              }
            : { type: "text", text: `[called ${c.function.name}(${c.function.arguments || "{}"})]` }
        );
      }
      push("assistant", blocks);
    }
  }
  if (out[0]?.role === "assistant")
    out.unshift({ role: "user", content: [{ type: "text", text: "Continue." }] });

  let thinking = thinkingFor(body);
  // With thinking on, an assistant turn that called tools must open with its thinking block.
  const lastAssistant = [...out].reverse().find((m) => m.role === "assistant");
  if (
    thinking &&
    lastAssistant?.content.some((b) => b.type === "tool_use") &&
    !/thinking/.test(String(lastAssistant.content[0]?.type))
  )
    thinking = undefined;
  const adaptive = Boolean(thinking) && adaptiveFor(body.model);

  let maxTokens = Number(body.max_tokens ?? body.max_completion_tokens) || 8192;
  const budget = thinking && !adaptive ? thinking.budget : 0;
  if (budget && maxTokens <= budget) maxTokens = budget + 4096;

  const req: Record<string, unknown> = {
    model: body.model,
    max_tokens: maxTokens,
    messages: out,
    stream: true,
  };
  if (system.length) req.system = system.join("\n\n");
  if (native) {
    req.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
    let choice = toolChoice(body.tool_choice);
    if (body.parallel_tool_calls === false)
      choice = { ...(choice ?? { type: "auto" }), disable_parallel_tool_use: true };
    if (choice) req.tool_choice = choice;
  }
  if (thinking && adaptive) {
    req.thinking = { type: "adaptive" };
    req.output_config = { effort: thinking.effort };
  } else if (thinking) {
    req.thinking = { type: "enabled", budget_tokens: budget };
  }
  if (!thinking) {
    for (const k of ["temperature", "top_p", "top_k"])
      if (typeof body[k] === "number") req[k] = body[k];
  }
  if (body.stop) req.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return req;
}

const STOP_REASONS: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "content_filter",
};

function citation(c: any): Citation | null {
  const url = c?.url;
  if (typeof url !== "string") return null;
  return { url, title: String(c.title ?? url), snippet: String(c.cited_text ?? "") };
}

/** Turns Messages SSE events (or a whole non-streamed message) into StreamEvents. */
export class MessagesParser {
  private blocks = new Map<
    number,
    { kind: string; tool?: number; text: string; sig: string; data?: string }
  >();
  private tools = 0;
  private toolIds: string[] = [];
  private thinking: Block[] = [];
  private input = 0;
  private output = 0;
  private stop: string | null = null;
  private done = false;

  *push(ev: any): Generator<StreamEvent> {
    switch (ev?.type) {
      case "message_start":
        this.addUsage(ev.message?.usage);
        break;
      case "content_block_start": {
        const b = ev.content_block ?? {};
        const i = Number(ev.index ?? 0);
        if (b.type === "tool_use") {
          const tool = this.tools++;
          this.blocks.set(i, { kind: "tool_use", tool, text: "", sig: "" });
          this.toolIds.push(String(b.id));
          const args = b.input && Object.keys(b.input).length ? JSON.stringify(b.input) : "";
          yield { type: "tool_call", index: tool, id: b.id, name: b.name, args };
        } else if (b.type === "thinking") {
          this.blocks.set(i, { kind: "thinking", text: b.thinking ?? "", sig: b.signature ?? "" });
          if (b.thinking) yield { type: "reasoning", delta: b.thinking };
        } else if (b.type === "redacted_thinking") {
          this.blocks.set(i, { kind: "redacted", text: "", sig: "", data: b.data });
        } else if (b.type === "text") {
          this.blocks.set(i, { kind: "text", text: "", sig: "" });
          if (b.text) yield { type: "text", delta: b.text };
          const items = (Array.isArray(b.citations) ? b.citations : [])
            .map(citation)
            .filter((c: Citation | null): c is Citation => !!c);
          if (items.length) yield { type: "citations", items };
        }
        break;
      }
      case "content_block_delta": {
        const d = ev.delta ?? {};
        const blk = this.blocks.get(Number(ev.index ?? 0));
        if (d.type === "text_delta" && d.text) yield { type: "text", delta: d.text };
        else if (d.type === "thinking_delta" && d.thinking) {
          if (blk) blk.text += d.thinking;
          yield { type: "reasoning", delta: d.thinking };
        } else if (d.type === "signature_delta" && blk) blk.sig += d.signature ?? "";
        else if (d.type === "input_json_delta" && blk?.tool !== undefined)
          yield { type: "tool_call", index: blk.tool, args: d.partial_json ?? "" };
        else if (d.type === "citations_delta") {
          const c = citation(d.citation);
          if (c) yield { type: "citations", items: [c] };
        }
        break;
      }
      case "content_block_stop": {
        const blk = this.blocks.get(Number(ev.index ?? 0));
        if (blk?.kind === "thinking")
          this.thinking.push({ type: "thinking", thinking: blk.text, signature: blk.sig });
        else if (blk?.kind === "redacted")
          this.thinking.push({ type: "redacted_thinking", data: blk.data });
        break;
      }
      case "message_delta":
        this.addUsage(ev.usage);
        if (ev.delta?.stop_reason) this.stop = String(ev.delta.stop_reason);
        break;
      case "message_stop":
        yield* this.end();
        break;
    }
  }

  /** Replays a non-streamed Messages response through the same path. */
  *replay(msg: any): Generator<StreamEvent> {
    yield* this.push({ type: "message_start", message: { usage: msg?.usage } });
    const content: any[] = Array.isArray(msg?.content) ? msg.content : [];
    for (const [index, block] of content.entries()) {
      yield* this.push({ type: "content_block_start", index, content_block: block });
      yield* this.push({ type: "content_block_stop", index });
    }
    yield* this.push({ type: "message_delta", delta: { stop_reason: msg?.stop_reason } });
    yield* this.end();
  }

  *end(): Generator<StreamEvent> {
    if (this.done) return;
    this.done = true;
    if (this.thinking.length && this.toolIds.length)
      rememberThoughts(this.toolIds[0], this.thinking);
    yield {
      type: "usage",
      usage: {
        promptTokens: this.input,
        completionTokens: this.output,
        reasoningTokens: 0,
        reportsReasoning: false,
      },
    };
    if (this.stop) yield { type: "finish", reason: STOP_REASONS[this.stop] ?? this.stop };
  }

  private addUsage(u: any) {
    if (!u) return;
    if (typeof u.input_tokens === "number") {
      const total =
        u.input_tokens +
        Number(u.cache_read_input_tokens ?? 0) +
        Number(u.cache_creation_input_tokens ?? 0);
      this.input = Math.max(this.input, total);
    }
    if (typeof u.output_tokens === "number") this.output = Math.max(this.output, u.output_tokens);
  }
}
