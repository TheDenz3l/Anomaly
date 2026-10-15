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
import { parseLooseJson, sleep, truncate, uid } from "../lib/util";
import { makeSource, type SourceCollector } from "../web/sources";
import { learn, note, type Engine } from "./context";
import type { Sink } from "./writer";
import { OPENUI_ANSWER_NOTE, OpenUICard } from "../ai/openui";
import type { PhotoFinder } from "../web/photos";
import { OPENUI_FENCE, type PhotoPick } from "../../src/genui/openui/library";
import { CARD_TOPICS, CardPlacer, type Placed } from "./placement";
import { plainNames } from "./profile";

/**
 * The agent loop: stream → render text/thinking/cards live → run tools → feed results back,
 * until the model answers without tools. Adapts to endpoint quirks on the fly (PRD §3.5 step 3).
 */

export type ToolOutcome = {
  content: string;
  final?: boolean;
  stop?: boolean;
  /** Web tools only: whether the call brought anything back (a round that found nothing doesn't count). */
  web?: "results" | "empty";
  /** Cards the tool drew, for the loop to place in the text that introduces them. */
  cards?: string[];
};
export type LoopTool = { def: ToolDef; run: (args: any, callId: string) => Promise<ToolOutcome> };

export type LoopOptions = {
  engine: Engine;
  sink: Sink;
  messages: ChatMessage[];
  tools: LoopTool[];
  /** No native tool calling: no tools are sent (cards still work, they're written in the text). */
  prompted?: boolean;
  /**
   * Cards are on offer this reply: the model writes them into its text as ```openui blocks, which
   * the app draws as they stream, so a card costs no extra round trip.
   */
  cards?: boolean;
  /** The last card in this chat, which an ```openui-edit block changes, and the photos it showed. */
  cardBase?: { source: string; photos?: PhotoPick[] };
  /** Finds photos for the phrases a card names. */
  findPhotos?: PhotoFinder;
  /** Photos the chat has already shown: a card picks others. */
  seenPhotos?: Set<string>;
  level: string;
  difficulty: Difficulty;
  maxSteps?: number;
  maxTokens?: number;
  showThinking?: boolean;
  nativeSearch?: boolean;
  sources: SourceCollector;
  signal?: AbortController;
  /**
   * Rounds of web tool calls that found something before web_search/read_url are withdrawn and the
   * model has to answer. Unset: no limit beyond the budget. Each round is a full model round trip.
   */
  webRounds?: number;
  /** Rounds already spent before the loop started (results passed in up front). */
  webRoundsDone?: number;
  /** Level for a first step that's expected to pick a search, not write the answer. */
  routeLevel?: string;
};

export type StepTiming = {
  level: string;
  /** From sending the request to the first streamed event. */
  firstMs?: number;
  /** From sending the request to the first answer text. */
  textMs?: number;
  /** Tools this step called, and how long they took together. */
  tools: number;
  toolsMs?: number;
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
  /** What the parser left out of cards (statements that didn't fit the library), for the log. */
  cardRepairs: string[];
  usedTools: string[];
  timings: StepTiming[];
  /** When the first answer text arrived. */
  firstTextAt?: number;
};

const TOOL_RESULT_MAX = 12_000;

/** How often a streaming card re-renders from its partial program. */
const PAINT_MS = 120;
/** How long a finished reply waits for its cards' last photos before it's saved without them. */
const PHOTO_WAIT_MS = 8000;

const WEB_TOOLS = new Set(["web_search", "read_url"]);

/** Data tools that render a card themselves: its skeleton shows from the moment the model calls them. */
const TOOL_CARDS: Record<string, string> = {
  find_showtimes: "MovieShowtimes",
  get_weather: "Weather",
};

/* ------------------------------------------------------------------ cards in the text stream */

type FenceEvent =
  | { type: "text"; text: string }
  | { type: "start" }
  | { type: "partial"; body: string }
  | { type: "end"; body: string };
const CLOSE = "```";

export class FenceParser {
  private buf = "";
  private block = "";
  private inBlock = false;

  /** `open` is the fence that starts a card. */
  constructor(private readonly open = OPENUI_FENCE) {}

  *push(delta: string): Generator<FenceEvent> {
    this.buf += delta;
    while (this.buf) {
      if (!this.inBlock) {
        const i = this.buf.indexOf(this.open);
        if (i >= 0) {
          if (i > 0) yield { type: "text", text: this.buf.slice(0, i) };
          this.buf = this.buf.slice(i + this.open.length);
          this.inBlock = true;
          yield { type: "start" };
          continue;
        }
        let keep = 0;
        for (let k = Math.min(this.open.length - 1, this.buf.length); k > 0; k--) {
          if (this.open.startsWith(this.buf.slice(-k))) {
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
      const grown = this.buf.slice(0, this.buf.length - keep);
      this.block += grown;
      this.buf = this.buf.slice(this.buf.length - keep);
      if (grown) yield { type: "partial", body: this.block };
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
  // A guess is only remembered when it costs little. Losing tools for good takes away search and
  // every card, so an error that never names them drops them for this request only.
  if (mentioned || (key !== "tools" && key !== "tool_choice"))
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

/** Appended to the results of the last search round a reply gets. */
const LAST_ROUND_NOTE =
  "That was the last search for this reply. Write the complete answer now from everything found so far. Where the results lack a detail, give what they do say and name the gap in a few words; never answer with a plan to search or check more.";

export async function runModelLoop(o: LoopOptions): Promise<LoopResult> {
  const { engine, sink, sources } = o;
  const signal = o.signal ?? new AbortController();
  const maxSteps = o.maxSteps ?? 8;
  const toolsOk = engine.profile.features.tools && !o.prompted;
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
    cardRepairs: [],
    usedTools: [],
    timings: [],
  };
  let webDone = o.webRoundsDone ?? 0;
  let finalNext = false;
  let nativeSearch = Boolean(o.nativeSearch);
  /** Cards whose photos are still being found; the reply waits for them before it's saved. */
  const photosPending: Promise<void>[] = [];
  /** Photos shown so far, shared by the reply's cards so none repeats another's. */
  const shownPhotos = o.seenPhotos ?? new Set<string>();
  /** Cards tools drew, waiting for their place in the text the model writes next. */
  const placer = new CardPlacer();
  const place = (out: Placed[]) => {
    for (const x of out) {
      if (x.type === "text") sink.text(x.text);
      else sink.release?.(x.id);
    }
  };

  for (let step = 0; step < maxSteps; step++) {
    result.steps = step + 1;
    const lastStep = finalNext || step === maxSteps - 1;
    // Once the web rounds are spent, app tools leave the list so the model answers from what it
    // found instead of paying another round trip. Data tools go too: denied a search, models reach
    // for whatever is left (a location request or a weather card on a news question).
    const webOpen = o.webRounds === undefined || webDone < o.webRounds;
    const offered = webOpen ? o.tools : [];
    const defs = toolsOk && !lastStep ? offered.map((t) => t.def) : [];
    const offeredNames = new Set(defs.map((d) => d.function.name));
    // A first step that's only going to write a search query doesn't need the full thinking budget.
    const routing =
      step === 0 &&
      o.routeLevel !== undefined &&
      webDone === 0 &&
      offered.some((t) => WEB_TOOLS.has(t.def.function.name));
    const extra: Record<string, unknown> = {};
    if (nativeSearch && step === 0) {
      if (engine.profile.params?.nativeSearch === "openrouter")
        extra.plugins = [{ id: "web", max_results: 5 }];
      if (engine.profile.params?.nativeSearch === "openai_options") extra.web_search_options = {};
    }
    const built = buildRequest({
      model: engine.modelId,
      profile: engine.profile,
      level: routing ? o.routeLevel! : o.level,
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
    const painted = new Map<string, number>();
    const fence = new FenceParser();
    let open: { id: string; card: OpenUICard } | null = null;
    let stepText = "";
    const timing: StepTiming = { level: built.levelSent, tools: 0 };
    result.timings.push(timing);
    const sentAt = Date.now();

    /**
     * An OpenUI block: the program so far goes to the app, which draws it as it grows, with photos
     * for the phrases it names arriving as they're found.
     */
    const handleCard = (ev: Exclude<FenceEvent, { type: "text" }>) => {
      if (ev.type === "start") {
        const id = uid("cmp");
        const card: OpenUICard = new OpenUICard({
          base: o.cardBase,
          findPhotos: o.findPhotos,
          seen: shownPhotos,
          onPhotos: () => setProps(id, { photos: card.photos() }),
        });
        open = { id, card };
        sink.add({
          id,
          type: "component",
          name: "OpenUI",
          props: {},
          status: "streaming",
          fallbackText: "",
        });
        return;
      }
      if (!open) return;
      const { id, card } = open;
      if (ev.type === "partial") {
        const now = Date.now();
        if (now - (painted.get(id) ?? 0) < PAINT_MS) return;
        painted.set(id, now);
        // Names are marked in prose, not in cards; one slipped into a card shows as its name.
        setProps(id, { source: card.update(plainNames(ev.body)) });
        return;
      }
      open = null;
      const read = card.finish(plainNames(ev.body));
      sink.update(id, (p) =>
        p.type !== "component"
          ? p
          : read.ok
            ? {
                ...p,
                props: { source: read.source, photos: card.photos() },
                status: "ready",
                fallbackText: read.fallbackText,
              }
            : { ...p, status: "invalid", error: read.error, fallbackText: "" }
      );
      if (read.ok) {
        result.componentsShown.push("OpenUI");
        result.cardRepairs.push(...read.issues);
        photosPending.push(
          card.settled().then(() => setProps(id, { photos: card.photos(), photosDone: true }))
        );
      } else console.log(`[cards] openui invalid: ${read.error.slice(0, 200)}`);
      stepText += "[card OpenUI]";
    };

    const handleFence = (ev: FenceEvent) => {
      if (ev.type === "text") {
        place(placer.push(ev.text));
        stepText += ev.text;
        return;
      }
      if (ev.type === "start") place(placer.beforeBlock());
      handleCard(ev);
    };

    const consume = async (body: Record<string, unknown>, onFirst: () => void) => {
      for await (const ev of streamChat(
        engine.endpoint,
        body,
        signal.signal
      ) as AsyncGenerator<StreamEvent>) {
        onFirst();
        timing.firstMs ??= Date.now() - sentAt;
        switch (ev.type) {
          case "text":
            if (timing.textMs === undefined && ev.delta.trim()) {
              timing.textMs = Date.now() - sentAt;
              result.firstTextAt ??= Date.now();
            }
            for (const fe of fence.push(ev.delta)) handleFence(fe);
            break;
          case "reasoning":
            result.reasoningSeen = true;
            if (o.showThinking) sink.thinking(ev.delta);
            break;
          case "tool_call": {
            const { index } = calls.push(ev);
            const name = calls.get(index)?.name;
            const card = name ? TOOL_CARDS[name] : undefined;
            if (card) sink.preload?.(card);
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
      for (const fe of fence.flush()) handleFence(fe);
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
    let foundOnWeb = false;
    /** Cards each call drew, in call order. */
    const drawn: string[][] = [];
    const toolsAt = Date.now();
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
        const tool = byName.get(name);
        try {
          if (!tool) return `Unknown tool ${name}.`;
          if (!offeredNames.has(name))
            return `${name} isn't available for the rest of this reply. Answer from what you have.`;
          if (args === null)
            return "Your arguments weren't valid JSON. Call the tool again with a JSON object.";
          const out = await tool.run(args, call.id);
          drawn[i] = out.cards ?? [];
          if (out.final) finalNext = true;
          if (out.stop) stopAfter = true;
          if (out.web === "results") foundOnWeb = true;
          return truncate(out.content, TOOL_RESULT_MAX);
        } catch (err) {
          return `Tool failed: ${(err as Error).message}`;
        } finally {
          const card = TOOL_CARDS[name];
          if (card) sink.dropPreload?.(card);
        }
      })
    );
    timing.tools = toolCalls.length;
    timing.toolsMs = Date.now() - toolsAt;
    toolCalls.forEach((call, i) => {
      for (const id of drawn[i] ?? [])
        if (sink.isHeld?.(id)) placer.hold(id, CARD_TOPICS[call.function.name] ?? /$^/);
    });
    if (foundOnWeb) webDone++;
    // The last round: say so, or models answer with what they'd search next and stop there.
    const lastRound = foundOnWeb && o.webRounds !== undefined && webDone >= o.webRounds;
    toolCalls.forEach((call, i) =>
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: [
          outputs[i],
          lastRound && WEB_TOOLS.has(call.function.name) ? LAST_ROUND_NOTE : "",
          // Cards aren't in the tool list to remind the model of them after a search.
          o.cards && WEB_TOOLS.has(call.function.name) ? OPENUI_ANSWER_NOTE : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      })
    );
    if (stopAfter || sink.stopped) {
      result.stopped = sink.stopped;
      break;
    }
  }
  place(placer.finish());
  // Photos still on their way: the saved reply should carry them.
  if (photosPending.length && !sink.stopped)
    await Promise.race([Promise.allSettled(photosPending), sleep(PHOTO_WAIT_MS)]);
  return result;

  function setProps(id: string, patch: Record<string, unknown>) {
    sink.update(id, (p) =>
      p.type === "component" ? { ...p, props: { ...(p.props as object), ...patch } } : p
    );
  }
}
