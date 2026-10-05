import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { MODEL_COMPONENTS, promptedCatalog } from "../ai/catalog";
import { band, THRESHOLDS, type Decision } from "../ai/decisions";
import { geocode } from "../data/geo";
import { textOf } from "../lib/messages";
import { uid } from "../lib/util";
import type { GeoLocation, Part, ReplyMeta, Source } from "../lib/validators";
import { SourceCollector } from "../web/sources";
import { spawnTool, type SpawnEnv } from "./agents";
import { modelEngine, note, type Engine } from "./context";
import { failTurn, finishTurn } from "./finish";
import { lastInput, toChatMessages } from "./history";
import { runModelLoop, type LoopTool } from "./loop";
import { recallMemories } from "./memory";
import { systemPrompt } from "./prompt";
import { researchTurn } from "./research";
import {
  findPlacesTool,
  geocodeTool,
  proposeMemory,
  readUrlTool,
  rememberTool,
  requestLocationTool,
  showtimesTool,
  weatherTool,
  webSearchTool,
} from "./tools";
import { PartWriter } from "./writer";

const RESEARCH_OFFER = "cmp_resoffer";

/** No chips when the reply already waits on the user (a question card, plan, form or location). */
function wantsFollowUps(parts: Part[]): boolean {
  if (!parts.some((p) => p.type === "text" && p.text.trim())) return false;
  const waiting = ["ChoiceChips", "LocationRequest", "SubagentPlan", "ResearchPlan", "Form"];
  return !parts.some((p) => {
    if (p.type !== "component") return false;
    if (waiting.includes(p.name)) return true;
    // A memory card still asking "remember this?" is already a question.
    return (
      p.name === "MemoryConfirm" &&
      ((p.props as { confidence?: number }).confidence ?? 1) <= THRESHOLDS.act
    );
  });
}

/** Candidate next actions Jev ranks; drawn from what this reply did. */
function followUpCandidates(intent: string, cards: string[], tools: string[]): string[] {
  const out = new Set<string>();
  const add = (...xs: string[]) => xs.forEach((x) => out.add(x));
  if (cards.includes("Weather") || tools.includes("get_weather"))
    add("Hourly forecast for tomorrow", "What should I wear?", "Weekend outlook");
  if (cards.includes("MovieShowtimes") || tools.includes("find_showtimes"))
    add("Find dinner nearby", "Directions to the theatre", "Reviews of these movies");
  if (cards.includes("MapCard") || tools.includes("find_places"))
    add("Directions to the closest one", "Which are open now?");
  if (cards.includes("Compare")) add("Which is better value?", "Show a spec table");
  if (cards.includes("Chart")) add("Try a different rate", "Compare two scenarios");
  if (cards.includes("Checklist")) add("Add more items", "Make it shorter");
  if (cards.includes("ProductGrid")) add("Compare the top two", "Find cheaper options");
  if (cards.includes("Stepper")) add("Troubleshoot a step", "Explain step 1 in detail");
  if (cards.includes("Timeline")) add("Go deeper on one event", "What happened next?");
  if (intent === "search" || tools.includes("web_search"))
    add("Tell me more", "What are the latest updates?", "Summarize the sources");
  add("Explain in more detail", "Give me an example", "Summarize in 3 bullets");
  return [...out].slice(0, 10);
}

/**
 * One assistant turn (PRD §3.3 flow): message → decisions (Jev router) → memory recall →
 * LLM with catalog + app tools → streamed parts → write gate → sources bar last.
 */
export async function runTurn(
  ctx: ActionCtx,
  messageId: Id<"messages">,
  opts: { injected?: string; sources?: Source[] } = {}
): Promise<void> {
  const data = await ctx.runQuery(internal.engine.data.turnContext, { messageId });
  if (!data || data.message.status !== "streaming") return;
  const { thread, settings, history } = data;
  const sink = new PartWriter(ctx, messageId, data.message.parts).start();
  const signal = new AbortController();
  sink.onStop = () => signal.abort();
  const meta: ReplyMeta = {
    modelRef: thread.modelRef,
    levelRequested: thread.reasoningLevel,
    levelSent: "off",
    reasoningTokens: 0,
  };
  let engine: Engine | null = null;
  try {
    engine = await modelEngine(ctx, { userId: thread.userId, thread, settings }, thread.modelRef);
    const input = lastInput(history);

    let location: GeoLocation | undefined = thread.location;
    const setLocation = async (loc: GeoLocation) => {
      location = loc;
      engine!.thread = { ...engine!.thread, location: loc };
      await ctx.runMutation(internal.engine.data.setThreadLocation, {
        threadId: thread._id,
        location: loc,
      });
    };
    if (input.event?.component === "LocationRequest" && input.event.action === "city") {
      const city = String(
        (input.event.payload as { city?: string } | undefined)?.city ?? ""
      ).trim();
      const place = city ? await geocode(engine.cache, city) : null;
      if (place) await setLocation({ lat: place.lat, lng: place.lng, label: place.label });
    }

    // Deep Research offered by Jev's delegation decision and accepted by the user.
    const ev = input.event;
    if (
      ev?.component === "ChoiceChips" &&
      ev.componentId.startsWith(RESEARCH_OFFER) &&
      Array.isArray((ev.payload as { ids?: unknown })?.ids) &&
      (ev.payload as { ids: string[] }).ids.includes("start_research")
    ) {
      const question = [...history]
        .reverse()
        .find((m) => m.role === "user" && m.parts.some((x) => x.type === "text"));
      const q = question ? textOf(question.parts) : "";
      if (q) {
        await ctx.runMutation(internal.engine.data.setThreadMode, {
          threadId: thread._id,
          mode: "research",
        });
        engine.thread = { ...engine.thread, mode: "research" };
        if (await researchTurn(engine, sink, messageId, { text: q, event: null })) return;
      }
    }

    if (thread.mode === "research" && !opts.injected) {
      if (await researchTurn(engine, sink, messageId, input)) return;
    }

    const dp = engine.dp;
    const text = input.text;
    const previous = [...history].reverse().find((m) => m.role === "assistant");
    // Jev router (PRD §3.3/§4): one Decisions request answers every per-turn question; heuristics
    // stand in when Jev is unavailable or below the 0.5 confidence floor.
    const td = await dp.turn({
      text,
      hasImages: input.images > 0,
      researchMode: false,
      subagentMode: settings.subagentMode,
      recent: previous ? textOf(previous.parts) : undefined,
      components: MODEL_COMPONENTS,
    });
    engine.safety = td.safety.choice;
    const { intent, difficulty, search, delegation } = td;
    for (const [kind, d] of [
      ["intent", intent],
      ["components", td.components],
      ["difficulty", difficulty],
      ["search", search],
      ["delegation", delegation],
      ["memory_gate", td.memory],
      ["safety", td.safety],
    ] as const) {
      note(engine, kind, text, d as Decision<unknown>);
    }
    const act = (d: { confidence: number }) => band(d.confidence) === "act";

    const profile = engine.profile;
    const canTools = profile.features.tools;
    const memoryOn = settings.memoryEnabled && !thread.incognito;
    const memories = memoryOn && text ? await recallMemories(engine, text, thread._id) : [];
    const sources = new SourceCollector(opts.sources);

    // Search decision → auto web access: none skips web tools, quick/deep size the budget.
    const searchMode = search.choice.mode;
    const skipWeb = act(search) && searchMode === "none";
    const env: SpawnEnv = {
      engine,
      sink,
      sources,
      origin: "app",
      render: true,
      budget: {
        searches: 0,
        maxSearches: searchMode === "deep" ? 10 : searchMode === "quick" ? 4 : 6,
        reads: 0,
        maxReads: searchMode === "deep" ? 8 : 5,
      },
      location: () => location,
      setLocation,
      memory: memoryOn ? { threadId: thread._id, used: false } : undefined,
      stoppedRef: () => sink.stopped,
      // Jev leaned toward delegating but wasn't sure: show the plan card before any worker runs.
      forceApproval:
        !delegation.choice.explicit &&
        delegation.choice.mode !== "none" &&
        band(delegation.confidence) === "confirm",
    };

    // Intent routing → skip unneeded tools (only when Jev is confident).
    const it = act(intent) ? intent.choice : null;
    const wantsData = !it || it === "ui" || it === "search";
    const wantsCards =
      !it || it === "ui" || it === "search" || it === "research" || act(td.components);

    // Web: the model's own search when it has one, plus app tools (SearXNG by default) whenever the
    // model can call tools in Auto. A profile flag alone doesn't prove search runs through a chat
    // completions endpoint, and a model with no working search refuses current-events questions.
    const nativeAvailable = profile.features.webSearch && settings.webMode !== "app";
    const appWeb =
      (settings.webMode === "app" ||
        !nativeAvailable ||
        (settings.webMode === "auto" && canTools)) &&
      !skipWeb &&
      it !== "memory";
    const useNative = nativeAvailable && searchMode !== "none";

    // Sub-agent decision → delegation.
    const delegate = delegation.choice;
    // PRD §3.6: in Auto, workers are only on the table when the user asks or Jev decides to delegate.
    const spawnOffered =
      delegate.explicit ||
      (settings.subagentMode !== "off" &&
        (delegate.mode === "single" || delegate.mode === "parallel"));

    const tools: LoopTool[] = [];
    if (canTools) {
      if (appWeb) tools.push(webSearchTool(env), readUrlTool(env));
      if (wantsData)
        tools.push(weatherTool(env), findPlacesTool(env), geocodeTool(env), showtimesTool(env));
      if (wantsData && !location) tools.push(requestLocationTool(env));
      if (memoryOn) tools.push(rememberTool(env));
      if (spawnOffered) tools.push(spawnTool(env, sink));
    }

    // Component selection → probabilities shape the tool list and pre-load a skeleton.
    const probs = td.components.choice;
    const components =
      canTools && wantsCards
        ? MODEL_COMPONENTS.filter(
            (c) => (c !== "Weather" && c !== "MovieShowtimes") || probs[c] !== undefined
          )
        : [];
    const top = Object.entries(probs).sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0))[0];
    if (canTools && top && (top[1] ?? 0) > THRESHOLDS.act) sink.preload(top[0]);

    const extra: string[] = [];
    if (!canTools && appWeb && searchMode !== "none" && text) {
      const pre = await webSearchTool(env).run({ query: text.slice(0, 300) }, "pre");
      extra.push("# Search results gathered for this question (cite as [n])", pre.content);
    }
    if (search.choice.timeSensitive && searchMode !== "none") {
      extra.push(
        "This question depends on current information: search before answering and say how recent the sources are."
      );
    }
    if (searchMode === "deep")
      extra.push("Search several angles and cross-check sources before answering.");
    if (
      !delegate.explicit &&
      act(delegation) &&
      delegate.mode === "parallel" &&
      delegate.n >= 2 &&
      spawnOffered
    ) {
      extra.push(
        `This request splits into about ${Math.max(1, delegate.n)} independent task(s): call spawn_subagents with one task each, then answer from their results.`
      );
    }
    if (opts.injected) extra.push(opts.injected);

    const hist = await toChatMessages(ctx, history, {
      vision: profile.features.vision,
      maxChars: Math.max(16_000, Math.floor(engine.contextWindow * 2.5)),
    });
    if (hist.droppedImages && input.images) {
      sink.text(
        "_This model can't see images, so I'm answering from your text only. Pick a model tagged Vision to include the photo._\n\n"
      );
    }

    const system = systemPrompt({
      now: Date.now(),
      customInstructions: settings.customInstructions,
      memories,
      location,
      incognito: thread.incognito,
      components: components.length > 0,
      promptedCatalog: !canTools && wantsCards ? promptedCatalog() : undefined,
      web: !canTools
        ? extra.length && appWeb
          ? "app"
          : "none"
        : useNative
          ? appWeb
            ? "both"
            : "native"
          : appWeb
            ? "app"
            : "none",
      locationTool: canTools && wantsData && !location,
      subagents: !canTools || !spawnOffered ? "off" : delegate.explicit ? "requested" : "available",
      memoryTool: canTools && memoryOn,
      extra,
    });

    const result = await runModelLoop({
      engine,
      sink,
      messages: [{ role: "system", content: system }, ...hist.messages],
      tools,
      components,
      prompted: !canTools && wantsCards,
      level: thread.reasoningLevel,
      difficulty: difficulty.choice,
      maxSteps: 8,
      showThinking: thread.reasoningLevel !== "off",
      nativeSearch: useNative,
      sources,
      signal,
    });

    // Memory write gate: act → auto-save, confirm → inline chip, fallback → skip.
    if (
      memoryOn &&
      env.memory &&
      !env.memory.used &&
      text &&
      !input.event &&
      !sink.stopped &&
      td.memory.choice.remember
    ) {
      await proposeMemory(env, td.memory.choice, td.memory.confidence);
    }

    if (!sink.stopped) {
      // Sub-agent decision "research" → offer Deep Research instead of guessing.
      if (
        !delegate.explicit &&
        act(delegation) &&
        delegate.mode === "research" &&
        thread.mode === "chat"
      ) {
        sink.add({
          id: uid(RESEARCH_OFFER),
          type: "component",
          name: "ChoiceChips",
          props: {
            prompt: "This could use a deep dive. Run Deep Research?",
            choices: [
              { id: "start_research", label: "Run Deep Research" },
              { id: "skip_research", label: "This is enough" },
            ],
          },
          status: "ready",
          fallbackText: "This could use a deep dive. Want me to run Deep Research?",
        });
      } else if (wantsFollowUps(sink.parts)) {
        // Follow-up chips: Jev ranks next actions; shown only when it's confident they help.
        const candidates = followUpCandidates(
          intent.choice,
          result.componentsShown,
          result.usedTools
        );
        const f = await dp.followUps({ message: text, reply: textOf(sink.parts), candidates });
        note(engine, "follow_ups", text, f);
        if (act(f) && f.choice.length) {
          sink.add({
            id: uid("cmp"),
            type: "component",
            name: "ChoiceChips",
            props: { choices: f.choice.map((label, i) => ({ id: `next${i}`, label })) },
            status: "ready",
            fallbackText: `You could ask: ${f.choice.join("; ")}.`,
          });
        }
      }
    }
    await finishTurn(engine, sink, { messageId, sources, result, meta });
  } catch (e) {
    await failTurn(engine, sink, e, meta);
  }
}
