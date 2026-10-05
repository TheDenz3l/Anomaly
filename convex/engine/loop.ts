import {
  componentFromTool,
  componentTools,
  validateToolArgs,
  type ModelComponent,
} from "../ai/catalog";
import {
  LlmError,
  streamChat,
  ToolCallAccumulator,
  type ChatMessage,
  type StreamEvent,
  type ToolCall,
  type ToolDef,
} from "../ai/openai";
import { buildRequest, type Difficulty } from "../ai/reasoning";
import { parseLooseJson, sanitizeValue, sleep, truncate, uid } from "../lib/util";
import type { Part } from "../lib/validators";
import { makeSource, type SourceCollector } from "../web/sources";
import { learn, note, type Engine } from "./context";
import type { Sink } from "./writer";

/**
 * The agent loop: stream → render text/thinking/cards live → run tools → feed results back,
 * until the model answers without tools. Adapts to endpoint quirks on the fly (PRD §3.5 step 3).
 */

export type ToolOutcome = { content: string; final?: boolean; stop?: boolean };
export type LoopTool = { def: ToolDef; run: (args: any, callId: string) => Promise<ToolOutcome> };

export type LoopOptions = {
  engine: Engine;
  sink: Sink;
  messages: ChatMessage[];
  tools: LoopTool[];
  components: readonly ModelComponent[];
  /** No native tool calling: components arrive as ```component fences in text. */
  prompted?: boolean;
  level: string;
  difficulty: Difficulty;
  maxSteps?: number;
  maxTokens?: number;
  showThinking?: boolean;
  nativeSearch?: boolean;
  sources: SourceCollector;
  signal?: AbortController;
};

export type LoopResult = {
  text: string;
  levelSent: string;
  steps: number;
  stopped: boolean;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  reasoningReported: boolean;
  costUsd?: number;
  reasoningSeen: boolean;
  componentsShown: string[];
  usedTools: string[];
};

const TOOL_RESULT_MAX = 12_000;

/* ------------------------------------------------------------------ prompted-JSON fallback */

type FenceEvent =
  { type: "text"; text: string } | { type: "start" } | { type: "end"; body: string };
const OPEN = "```component";
const CLOSE = "```";

export class FenceParser {
  private buf = "";
  private block = "";
  private inBlock = false;

  *push(delta: string): Generator<FenceEvent> {
    this.buf += delta;
    while (this.buf) {
      if (!this.inBlock) {
        const i = this.buf.indexOf(OPEN);
        if (i >= 0) {
          if (i > 0) yield { type: "text", text: this.buf.slice(0, i) };
          this.buf = this.buf.slice(i + OPEN.length);
          this.inBlock = true;
          yield { type: "start" };
          continue;
        }
        let keep = 0;
        for (let k = Math.min(OPEN.length - 1, this.buf.length); k > 0; k--) {
          if (OPEN.startsWith(this.buf.slice(-k))) {
            keep = k;
            break;
          }
        }
        const out = this.buf.slice(0, this.buf.length - keep);
        if (out) yield { type: "text", text: out };
        this.buf = this.buf.slice(this.buf.length - keep);
        return;
      }
      const j = this.buf.indexOf(CLOSE);
      if (j >= 0) {
        this.block += this.buf.slice(0, j);
        this.buf = this.buf.slice(j + CLOSE.length);
        this.inBlock = false;
        const body = this.block;
        this.block = "";
        yield { type: "end", body };
        continue;
      }
      const keep = this.buf.endsWith("``") ? 2 : this.buf.endsWith("`") ? 1 : 0;
      this.block += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return;
    }
  }

  *flush(): Generator<FenceEvent> {
    if (this.inBlock) {
      yield { type: "end", body: this.block + this.buf };
    } else if (this.buf) {
      yield { type: "text", text: this.buf };
    }
    this.buf = "";
    this.block = "";
    this.inBlock = false;
  }
}

/* ------------------------------------------------------------------ param repair */

const PARAM_ALIASES: [RegExp, string][] = [
  [/stream_options|include_usage/i, "stream_options"],
  [/reasoning_effort/i, "reasoning_effort"],
  [/budget_tokens|\bthinking\b/i, "thinking"],
  [/chat_template_kwargs|enable_thinking/i, "chat_template_kwargs"],
  [/\breasoning\b/i, "reasoning"],
  [/plugins?/i, "plugins"],
  [/web_search_options/i, "web_search_options"],
  [/tool_choice/i, "tool_choice"],
  [/parallel_tool_calls/i, "parallel_tool_calls"],
  [/\btools?\b|function.?call/i, "tools"],
];

function stripImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    const text = m.content
      .map((c) => (c.type === "text" ? c.text : "[image omitted: this model can't read images]"))
      .join("\n");
    return { role: "user", content: text };
  });
}

/** Drops (or renames) the parameter an endpoint rejected. Returns the learned param name, or null. */
function repairBody(
  body: Record<string, unknown>,
  err: string,
  reasoningKeys: string[],
  engine: Engine
): string | null {
  if (/max_tokens/.test(err) && /max_completion_tokens/.test(err) && "max_tokens" in body) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    learn(engine, { kind: "max_tokens_field", field: "max_completion_tokens" });
    return "max_tokens";
  }
  if (
    /image|vision|multimodal|image_url/i.test(err) &&
    /not support|invalid|unsupported|does not/i.test(err)
  ) {
    body.messages = stripImages(body.messages as ChatMessage[]);
    learn(engine, { kind: "param_rejected", param: "image_url" });
    return "image_url";
  }
  const mentioned = PARAM_ALIASES.find(([re, key]) => re.test(err) && key in body)?.[1];
  const fallbackOrder = [
    ...reasoningKeys,
    "stream_options",
    "plugins",
    "web_search_options",
    "parallel_tool_calls",
    "tool_choice",
    "tools",
  ];
  const key = mentioned ?? fallbackOrder.find((k) => k in body);
  if (!key) return null;
  delete body[key];
  if (key === "tools") delete body.tool_choice;
  learn(engine, { kind: "param_rejected", param: key });
  return key;
}

function trimForOverflow(messages: ChatMessage[]): ChatMessage[] | null {
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  const rest = messages.slice(system.length);
  if (rest.length <= 2) return null;
  const keep = rest.slice(Math.floor(rest.length / 2));
  while (keep.length && keep[0].role !== "user") keep.shift();
  return keep.length ? [...system, ...keep] : null;
}

/* ------------------------------------------------------------------ loop */

export async function runModelLoop(o: LoopOptions): Promise<LoopResult> {
  const { engine, sink, sources } = o;
  const signal = o.signal ?? new AbortController();
  const maxSteps = o.maxSteps ?? 8;
  const toolsOk = engine.profile.features.tools && !o.prompted;
  const componentDefs = toolsOk ? componentTools(o.components) : [];
  const byName = new Map(o.tools.map((t) => [t.def.function.name, t]));
  const messages = [...o.messages];
  const result: LoopResult = {
    text: "",
    levelSent: "off",
    steps: 0,
    stopped: false,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    reasoningReported: false,
    reasoningSeen: false,
    componentsShown: [],
    usedTools: [],
  };
  const repairs = new Map<string, number>();
  const invalidPartByName = new Map<string, string>();
  let finalNext = false;
  let nativeSearch = Boolean(o.nativeSearch);

  for (let step = 0; step < maxSteps; step++) {
    result.steps = step + 1;
    const lastStep = finalNext || step === maxSteps - 1;
    const defs = toolsOk && !lastStep ? [...componentDefs, ...o.tools.map((t) => t.def)] : [];
    const extra: Record<string, unknown> = {};
    if (nativeSearch && step === 0) {
      if (engine.profile.params?.nativeSearch === "openrouter")
        extra.plugins = [{ id: "web", max_results: 5 }];
      if (engine.profile.params?.nativeSearch === "openai_options") extra.web_search_options = {};
    }
    const built = buildRequest({
      model: engine.modelId,
      profile: engine.profile,
      level: o.level,
      difficulty: o.difficulty,
      messages,
      tools: defs,
      maxTokens: o.maxTokens,
      extra,
    });
    result.levelSent = built.levelSent;
    if (built.systemSuffix && messages[0]?.role === "system") {
      built.body.messages = [
        { role: "system", content: `${messages[0].content}\n\n${built.systemSuffix}` },
        ...messages.slice(1),
      ];
    }

    const calls = new ToolCallAccumulator();
    const partByIndex = new Map<number, string>();
    const fence = o.prompted ? new FenceParser() : null;
    let fencePart: string | null = null;
    let stepText = "";

    const handleFence = (ev: FenceEvent) => {
      if (ev.type === "text") {
        sink.text(ev.text);
        stepText += ev.text;
      } else if (ev.type === "start") {
        fencePart = sink.add({
          id: uid("cmp"),
          type: "component",
          name: "",
          props: {},
          status: "streaming",
          fallbackText: "",
        });
      } else if (fencePart) {
        const id = fencePart;
        fencePart = null;
        let parsed: any = null;
        try {
          parsed = parseLooseJson(ev.body);
        } catch {
          parsed = null;
        }
        const name = typeof parsed?.name === "string" ? parsed.name : "";
        const v = validateToolArgs(name, {
          ...(parsed?.props ?? {}),
          fallbackText: parsed?.fallbackText,
        });
        sink.update(id, (p) =>
          v.ok
            ? {
                ...(p as Extract<Part, { type: "component" }>),
                name,
                props: sanitizeValue(v.props),
                status: "ready",
                fallbackText: v.fallbackText,
              }
            : {
                ...(p as Extract<Part, { type: "component" }>),
                name: name || "Unknown",
                status: "invalid",
                error: v.error,
                fallbackText: v.fallbackText,
              }
        );
        if (v.ok) result.componentsShown.push(name);
        stepText += `[card ${name}]`;
      }
    };

    const consume = async (body: Record<string, unknown>, onFirst: () => void) => {
      for await (const ev of streamChat(
        engine.endpoint,
        body,
        signal.signal
      ) as AsyncGenerator<StreamEvent>) {
        onFirst();
        switch (ev.type) {
          case "text":
            if (fence) for (const fe of fence.push(ev.delta)) handleFence(fe);
            else {
              sink.text(ev.delta);
              stepText += ev.delta;
            }
            break;
          case "reasoning":
            result.reasoningSeen = true;
            if (o.showThinking) sink.thinking(ev.delta);
            break;
          case "tool_call": {
            const { index, isNew } = calls.push(ev);
            const call = calls.get(index);
            const comp = call?.name ? componentFromTool(call.name) : null;
            if (comp && !partByIndex.has(index)) {
              const reuse = invalidPartByName.get(comp);
              if (reuse && sink.get(reuse)) {
                sink.update(reuse, (p) => ({
                  ...(p as Extract<Part, { type: "component" }>),
                  status: "streaming",
                  error: undefined,
                }));
                partByIndex.set(index, reuse);
              } else {
                partByIndex.set(
                  index,
                  sink.add({
                    id: uid("cmp"),
                    type: "component",
                    name: comp,
                    props: {},
                    status: "streaming",
                    fallbackText: "",
                  })
                );
              }
            }
            void isNew;
            break;
          }
          case "citations":
            for (const c of ev.items) sources.add(makeSource(c.url, c.title, c.snippet, "native"));
            break;
          case "usage":
            result.promptTokens += ev.usage.promptTokens;
            result.completionTokens += ev.usage.completionTokens;
            result.reasoningTokens += ev.usage.reasoningTokens;
            result.reasoningReported ||= ev.usage.reportsReasoning;
            if (ev.usage.costUsd !== undefined)
              result.costUsd = (result.costUsd ?? 0) + ev.usage.costUsd;
            break;
          case "finish":
            break;
        }
        if (await sink.tick()) {
          signal.abort();
          result.stopped = true;
          break;
        }
      }
      if (fence) for (const fe of fence.flush()) handleFence(fe);
    };

    let attempt = 0;
    while (true) {
      let produced = false;
      try {
        await consume(built.body, () => {
          produced = true;
        });
        break;
      } catch (e) {
        if (signal.signal.aborted) {
          result.stopped = true;
          break;
        }
        if (!(e instanceof LlmError) || produced || attempt >= 4) throw e;
        attempt++;
        const kind = note(
          engine,
          "error_kind",
          { status: e.status, body: e.body.slice(0, 300) },
          await engine.dp.errorKind(e.status, e.body, e.kind)
        );
        if (kind === "bad_param") {
          const fixed = repairBody(built.body, e.body || e.message, built.reasoningKeys, engine);
          if (fixed === "plugins" || fixed === "web_search_options") nativeSearch = false;
          if (fixed === "reasoning" || fixed === "reasoning_effort" || fixed === "thinking")
            result.levelSent = "off";
          if (fixed) continue;
        } else if (kind === "rate_limit" && attempt <= 2) {
          await sleep(Math.min(e.retryAfterMs ?? 2000 * 2 ** attempt, 20_000));
          continue;
        } else if (kind === "context_overflow") {
          const trimmed = trimForOverflow(built.body.messages as ChatMessage[]);
          if (trimmed) {
            built.body.messages = trimmed;
            messages.splice(0, messages.length, ...trimmed);
            continue;
          }
        } else if ((kind === "server" || kind === "network") && attempt <= 1) {
          await sleep(1200);
          continue;
        }
        throw e;
      }
    }
    result.text += stepText;
    if (result.stopped) break;

    const entries = calls.entries();
    const toolCalls: ToolCall[] = entries.map((x) => x.call);
    messages.push({
      role: "assistant",
      content: stepText || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    // Tools weren't offered this step (final step): ignore stray calls instead of looping.
    if (!toolCalls.length || defs.length === 0) break;

    let stopAfter = false;
    const outputs = await Promise.all(
      toolCalls.map(async (call, i): Promise<string> => {
        const name = call.function.name;
        result.usedTools.push(name);
        let args: any;
        try {
          args = parseLooseJson(call.function.arguments || "{}");
        } catch {
          args = null;
        }
        const comp = componentFromTool(name);
        if (comp) {
          const partId =
            partByIndex.get(entries[i].index) ??
            sink.add({
              id: uid("cmp"),
              type: "component",
              name: comp,
              props: {},
              status: "streaming",
              fallbackText: "",
            });
          const v = validateToolArgs(comp, args);
          if (v.ok) {
            sink.update(partId, (p) => ({
              ...(p as Extract<Part, { type: "component" }>),
              props: sanitizeValue(v.props),
              status: "ready",
              fallbackText: v.fallbackText,
              error: undefined,
            }));
            invalidPartByName.delete(comp);
            result.componentsShown.push(comp);
            return `Shown to the user as card ${partId}. Don't repeat its contents as text; add at most a sentence or two.`;
          }
          const used = repairs.get(comp) ?? 0;
          repairs.set(comp, used + 1);
          sink.update(partId, (p) => ({
            ...(p as Extract<Part, { type: "component" }>),
            status: "invalid",
            error: v.error,
            fallbackText: v.fallbackText,
          }));
          invalidPartByName.set(comp, partId);
          return used < 2
            ? `Invalid ${comp} props: ${v.error}. Call ${name} again with corrected arguments.`
            : `Invalid ${comp} props again (${v.error}). Don't retry; answer in text instead.`;
        }
        const tool = byName.get(name);
        if (!tool) return `Unknown tool ${name}.`;
        if (args === null)
          return "Your arguments weren't valid JSON. Call the tool again with a JSON object.";
        try {
          const out = await tool.run(args, call.id);
          if (out.final) finalNext = true;
          if (out.stop) stopAfter = true;
          return truncate(out.content, TOOL_RESULT_MAX);
        } catch (err) {
          return `Tool failed: ${(err as Error).message}`;
        }
      })
    );
    toolCalls.forEach((call, i) =>
      messages.push({ role: "tool", tool_call_id: call.id, content: outputs[i] })
    );
    if (stopAfter || sink.stopped) {
      result.stopped = sink.stopped;
      break;
    }
  }
  return result;
}
