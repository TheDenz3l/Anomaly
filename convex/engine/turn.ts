import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { MODEL_COMPONENTS, promptedCatalog, type ModelComponent } from "../ai/catalog";
import {
  askedToRemember,
  band,
  heuristicDecisions,
  searchQueryFrom,
  THRESHOLDS,
  wantsPhotos,
  type Decision,
} from "../ai/decisions";
import { routingLevel } from "../ai/reasoning";
import { geocode } from "../data/geo";
import { textOf } from "../lib/messages";
import { uid } from "../lib/util";
import type { GeoLocation, Part, ReplyMeta, Source } from "../lib/validators";
import { SourceCollector } from "../web/sources";
import { spawnTool, type SpawnEnv } from "./agents";
import { modelEngine, note, type Engine } from "./context";
import { failTurn, finishTurn } from "./finish";
import { conversationContext, lastInput, shownImages, toChatMessages } from "./history";
import { runModelLoop, type LoopTool } from "./loop";
import { recallMemories } from "./memory";
import { systemPrompt, COMPOSE_DIRECTIVE } from "./prompt";
import { researchTurn } from "./research";
import {
  findPlacesTool,
  geocodeTool,
  proposeMemory,
  readUrlTool,
  rememberTool,
  requestLocationTool,
  showSearch,
  showtimeData,
  showtimesTool,
  startSearch,
  weatherTool,
  webSearchTool,
} from "./tools";
import { PartWriter } from "./writer";
import { type ChatMessage } from "../ai/openai";

const RESEARCH_OFFER = "cmp_resoffer";

/** No chips when the reply already waits on the user (a question card, plan, form or location). */
/** Chance of a composed answer (visual + tool) at which Blocks is offered, and at which it's asked for. */
const COMPOSE_OFFER = 0.3;
const COMPOSE_ASK = 0.5;

/** Cards that present one shape better than a composed answer could: options side by side, a series. */
const EXACT_CARDS = new Set(["Compare", "Chart"]);

/** Adds an app note to the latest user message, for this request only (never stored). */
function withTurnNote(messages: ChatMessage[], note: string): ChatMessage[] {
  const tag = `[App note: ${note}]`;
  const at = messages.map((m) => m.role).lastIndexOf("user");
  if (at < 0) return [...messages, { role: "user", content: tag }];
  const m = messages[at] as Extract<ChatMessage, { role: "user" }>;
  const content =
    typeof m.content === "string"
      ? `${m.content}\n\n${tag}`
      : [...m.content, { type: "text" as const, text: tag }];
  return [...messages.slice(0, at), { role: "user", content }, ...messages.slice(at + 1)];
}

function wantsFollowUps(parts: Part[]): boolean {
  const answered = parts.some(
    (p) =>
      (p.type === "text" && p.text.trim()) ||
      (p.type === "component" && p.name === "Blocks" && p.status === "ready")
  );
  if (!answered) return false;
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
  opts: { injected?: string; sources?: Source[]; kind?: ReplyMeta["kind"] } = {}
): Promise<void> {
  const startedAt = Date.now();
  const data = await ctx.runQuery(internal.engine.data.turnContext, { messageId });
  if (!data || data.message.status !== "streaming") return;
  const { thread, settings, history } = data;
  const sink = new PartWriter(ctx, messageId, data.message.parts, data.message.runId).start();
  const signal = new AbortController();
  sink.onStop = () => signal.abort();
  const meta: ReplyMeta = {
    modelRef: thread.modelRef,
    levelRequested: thread.reasoningLevel,
    levelSent: "off",
    reasoningTokens: 0,
    ...(opts.kind ? { kind: opts.kind } : {}),
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
        const context = conversationContext(history);
        if (await researchTurn(engine, sink, messageId, { text: q, event: null, context })) return;
      }
    }

    if (thread.mode === "research" && !opts.injected) {
      const context = conversationContext(history);
      if (await researchTurn(engine, sink, messageId, { ...input, context })) return;
    }

    const dp = engine.dp;
    const text = input.text;
    const previous = [...history].reverse().find((m) => m.role === "assistant");
    const memoryOn = settings.memoryEnabled && !thread.incognito;
    const t0 = Date.now();
    // Memory recall (an embedding call and a search) doesn't depend on the router's answers, so it
    // runs alongside them instead of after.
    const recalled =
      memoryOn && text
        ? recallMemories(engine, text, thread._id).catch((err) => {
            console.warn("memory recall failed", (err as Error).message);
            return [];
          })
        : Promise.resolve([]);
    const profile = engine.profile;
    const canTools = profile.features.tools;
    const nativeAvailable = profile.features.webSearch && settings.webMode !== "app";
    const photos = Boolean(text) && !input.event && wantsPhotos(text);
    // Pre-search: a chat's first question that reads as current events is searched while the router
    // decides, so the first model call already has results and answers in one round trip instead of
    // two (pick a search, then answer). Follow-ups lean on context a raw-text query wouldn't carry.
    let pre: { at: number; query: string; run: ReturnType<typeof startSearch> } | null = null;
    if (
      canTools &&
      !nativeAvailable &&
      !previous &&
      !input.event &&
      !input.images &&
      // A question about an attached file is answered from the file, not a search on its wording.
      !input.files &&
      !opts.injected &&
      text.trim().length >= 8 &&
      !/https?:\/\//i.test(text)
    ) {
      const [hi, hs] = await Promise.all([
        heuristicDecisions.intent({ text, hasImages: false, researchMode: false }),
        heuristicDecisions.search(text),
      ]);
      // Photos come from pages on the web, so asking for them is a search whatever the wording.
      if (photos || (hi.choice === "search" && hs.choice.timeSensitive)) {
        const query = searchQueryFrom(text);
        // One search has to cover the question, so it asks for the most results a search returns.
        pre = {
          at: Date.now(),
          query,
          run: startSearch(engine, query, { deadline: true, photos, limit: 10 }),
        };
      }
    }
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
    const pres = td.presentation;
    for (const [kind, d] of [
      ["intent", intent],
      ["components", td.components],
      ["presentation", pres],
      ["difficulty", difficulty],
      ["search", search],
      ["delegation", delegation],
      ["memory_gate", td.memory],
      ["safety", td.safety],
    ] as const) {
      note(engine, kind, text, d as Decision<unknown>);
    }
    const act = (d: { confidence: number }) => band(d.confidence) === "act";

    const decidedAt = Date.now();
    const memories = await recalled;
    const recalledAt = Date.now();
    const sources = new SourceCollector(opts.sources);

    // Search decision → auto web access: none skips web tools, quick/deep size the budget.
    // Photos only come from the web, so a photo request searches even when the router says no.
    const searchMode = photos && search.choice.mode === "none" ? "quick" : search.choice.mode;
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
      memory: memoryOn
        ? { threadId: thread._id, used: false, requested: askedToRemember(text) }
        : undefined,
      stoppedRef: () => sink.stopped,
      photos,
      seenImages: shownImages(history),
      // Jev leaned toward delegating but wasn't sure: show the plan card before any worker runs.
      forceApproval:
        !delegation.choice.explicit &&
        delegation.choice.mode !== "none" &&
        band(delegation.confidence) === "confirm",
    };

    // Intent routing → skip unneeded tools (only when Jev is confident).
    const it = act(intent) ? intent.choice : null;
    const wantsData = !it || it === "ui" || it === "search";
    // How the answer should look: a composed answer (Blocks) stays on the table whenever it's a real
    // possibility, even for a question routed as plain chat, and is asked for when it's likely.
    const compose = pres.choice.visual + pres.choice.tool;
    const wantsCards =
      !it ||
      it === "ui" ||
      it === "search" ||
      it === "research" ||
      act(td.components) ||
      compose >= COMPOSE_OFFER;

    // Web: the model's own search when it has one, plus app tools (SearXNG by default) whenever the
    // model can call tools in Auto. A profile flag alone doesn't prove search runs through a chat
    // completions endpoint, and a model with no working search refuses current-events questions.
    const appWebAllowed =
      (settings.webMode === "app" ||
        !nativeAvailable ||
        (settings.webMode === "auto" && canTools)) &&
      it !== "memory";
    const appWeb = appWebAllowed && !skipWeb;
    // "Don't search" isn't "don't open the link I gave you".
    const readLink = !appWeb && appWebAllowed && /https?:\/\/\S/i.test(text);
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
      else if (readLink) tools.push(readUrlTool(env));
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
    // Showtimes are likely: look up movies and cinemas while the model thinks, so the tool call
    // finds them ready.
    if (canTools && wantsData && location && (probs.MovieShowtimes ?? 0) > THRESHOLDS.act)
      showtimeData(env, location);

    // Every round of searching is another full model round trip before the answer starts. A question
    // with several parts (a list plus figures, hits and artwork) rarely fits one round; with a
    // second on offer the model fills the gaps instead of answering with a plan to search.
    const webRounds = searchMode === "deep" ? 3 : difficulty.choice === "easy" ? 1 : 2;
    let webRoundsDone = 0;
    let preLog = pre ? "dropped" : "no";
    const extra: string[] = [];
    // The router agrees it's a plain search: the pre-search stands in for the model's first round.
    if (
      pre &&
      appWeb &&
      (intent.choice === "search" || photos) &&
      searchMode !== "none" &&
      !spawnOffered
    ) {
      const waitFrom = Date.now();
      env.photoSearches = photos ? 1 : 0;
      const found = await showSearch(env, pre.query, pre.run, pre.at);
      preLog = `${Date.now() - pre.at}ms(waited ${Date.now() - waitFrom}ms,${found.web})`;
      if (found.web === "results") {
        extra.push("# Search results for this message (cite as [n])", found.content);
        webRoundsDone = 1;
      }
    } else if (!canTools && appWeb && searchMode !== "none" && text) {
      const found = await webSearchTool(env).run({ query: text.slice(0, 300) }, "pre");
      extra.push("# Search results gathered for this question (cite as [n])", found.content);
    }
    // With the rounds already spent the first call has no app tools: it answers.
    const toolsAtStart = webRoundsDone < webRounds;
    if (search.choice.timeSensitive && searchMode !== "none") {
      extra.push(
        webRoundsDone
          ? "This question depends on current information: say how recent the sources are."
          : "This question depends on current information: search before answering and say how recent the sources are."
      );
    }
    if (searchMode === "deep")
      extra.push("Search several angles and cross-check sources before answering.");
    if (canTools && readLink)
      extra.push(
        "The user's message links to a page: read it with read_url before answering. No web search for this one."
      );
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
    // Asked for next to the user's message rather than at the end of a long system prompt, where
    // models (especially mid-conversation, with earlier cards in the history) tend to miss it.
    let presentAs: string | undefined;
    if (canTools && compose >= COMPOSE_ASK) {
      // A card built for this exact shape beats a composed one when the router is sure of it.
      const [card, p] = Object.entries(td.components.choice).sort((x, y) => y[1] - x[1])[0] ?? [];
      if (
        card &&
        p >= COMPOSE_ASK &&
        EXACT_CARDS.has(card) &&
        components.includes(card as ModelComponent)
      )
        presentAs = `Present this answer with the ui_${card} card, then add at most a sentence or two.`;
      else if (components.includes("Blocks"))
        presentAs = COMPOSE_DIRECTIVE[pres.choice.tool > pres.choice.visual ? "tool" : "visual"];
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
            ? toolsAtStart
              ? "app"
              : "provided"
            : "none",
      locationTool: canTools && toolsAtStart && wantsData && !location,
      subagents:
        !canTools || !toolsAtStart || !spawnOffered
          ? "off"
          : delegate.explicit
            ? "requested"
            : "available",
      memoryTool: canTools && toolsAtStart && memoryOn,
      extra,
    });

    const result = await runModelLoop({
      engine,
      sink,
      messages: [
        { role: "system", content: system },
        ...(presentAs ? withTurnNote(hist.messages, presentAs) : hist.messages),
      ],
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
      webRounds,
      webRoundsDone,
      // After searching, only cards that lay out what was found; photos answer for themselves.
      answerCards: photos
        ? []
        : ["Table", "Timeline", "Compare", "ProductGrid", "MapCard", "Blocks"],
      // Only when a search is near certain: if the model answers from what it knows instead, that
      // first step is the answer, and it must be written at the level the user picked.
      routeLevel:
        appWeb && searchMode !== "none" && (search.choice.timeSensitive || act(search) || photos)
          ? routingLevel(profile, thread.reasoningLevel)
          : undefined,
    });
    const loopDoneAt = Date.now();
    // Cards still filling in (showtimes read from theatre sites) finish before the reply does.
    if (env.background?.length && !sink.stopped) await Promise.allSettled(env.background);
    const stepLog = result.timings
      .map(
        (s) =>
          `${s.level}:${s.textMs !== undefined ? `text@${s.textMs}` : `first@${s.firstMs ?? "-"}`}ms` +
          (s.tools ? `+${s.tools}tool/${s.toolsMs}ms` : "")
      )
      .join(" | ");
    console.log(
      `[turn] ${messageId} firstText=${result.firstTextAt ? `${result.firstTextAt - startedAt}ms` : "none"} setup=${t0 - startedAt}ms pre=${preLog} decide=${decidedAt - t0}ms recallWait=${recalledAt - decidedAt}ms model+tools=${loopDoneAt - recalledAt}ms cards=${Date.now() - loopDoneAt}ms steps=${result.steps} [${stepLog}] tools=${result.usedTools.join(",") || "none"}`
    );

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
