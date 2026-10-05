# PRD: Personal Generative-UI Chatbot (working title: "Atlas")

**Version:** 1.0 (locked for build) | **Date:** Oct 4, 2026 | **Owner:** Bmar
**Platform:** iOS (Expo / React Native) | **Theme:** Dark mode only (v1)

---

## 1. Vision

A personal AI chat app where the assistant answers in text _and_ builds interactive UI inline (maps, showtimes, charts, forms) based on context. Users bring their own OpenAI-compatible models, control reasoning depth, delegate to sub-agents, run deep research, and keep optional cross-thread memory. Decisions are routed through **Jev** (TypeSafe System One model) wherever a fast, typed, probabilistic decision beats an LLM call.

### Goals

1. Streaming chat with inline, interactive, schema-validated UI components.
2. Bring-your-own model (endpoint, API key, provider ID) with per-model capability detection.
3. Adjustable reasoning levels, auto-adapted per model/endpoint.
4. Sub-agents (auto or user-requested) and a Deep Research mode sharing one engine.
5. Internet access via native provider tools or a free app-side fallback.
6. Memory (per-thread and cross-thread) with global and per-thread toggles; custom instructions.
7. Images, voice input and voice output.
8. Native iOS Liquid Glass navigation.

### Non-goals (v1)

Light mode, Android polish, web app, paid infrastructure, multi-user/team features, marketplace of third-party components.

---

## 2. Design System

### 2.1 Libraries

- **UI:** HeroUI Native (React Native, Tailwind v4 via Uniwind). Scaffold with `create-heroui-native-app`.
- **Navigation:** Expo Router **native tabs** (system iOS 26 Liquid Glass tab bar).
- **Glass surfaces:** `expo-glass-effect` (`GlassView`, `GlassContainer`) for composer, floating controls, sheets.
- **Requirements:** development build (not Expo Go), Xcode 26. Below iOS 26: blur/solid fallback.

### 2.2 Theme (dark only, `userInterfaceStyle: "dark"`)

Hex values are estimates from the reference screenshot; tune by eye.

| Token             | Value                 | Use                                          |
| ----------------- | --------------------- | -------------------------------------------- |
| background        | `#000000`             | Canvas                                       |
| surface           | `#18181B`             | Cards, component shells                      |
| surface-raised    | `#27272A`             | Chips, inputs, secondary buttons             |
| border            | `#27272A` @ 60%       | Hairlines                                    |
| primary           | `#3B82F6`             | Send, active tab, links, interactive handles |
| primary-soft      | `#3B82F6` @ 15%       | Tinted buttons, selected chips               |
| text              | `#FAFAFA`             | Primary text                                 |
| text-muted        | `#A1A1AA`             | Secondary text                               |
| danger            | `#DC4A44`             | Errors, destructive                          |
| success / warning | `#17C964` / `#F5A524` | Status                                       |

### 2.3 Typography

- **Moderniz:** app title, thread titles, component titles (sparingly).
- **Satoshi:** all chat text. **Bold** for emphasis, labels, key values (times, prices); **Regular** for body and secondary text.
- Verify Moderniz license before shipping. Load fonts with `expo-font` before hiding splash.

### 2.4 Rules

- Glass only on nav, composer, floating controls, sheets. **Never on message bubbles** (performance, legibility).
- Native tab bar is OS-styled: use `PlatformColor` / `DynamicColorIOS` for icons; do not rely on tab bar background props on iOS 26.
- Test the known dark-mode header-button flicker on tab switch early.
- User message: solid primary blue. Assistant: no bubble, text on black. Inline components: `surface` cards, ~24px radius, blue for interactive parts only.

### 2.5 Navigation

Tabs: **Chat**, **History**, **Memory**, **Settings**.

---

## 3. Core Features

### 3.1 Streaming chat

- Token streaming via streaming-capable fetch (`expo/fetch`) and message "parts": `text | component | image | sources | ui_event | thinking`.
- Persisted to Convex; buffered writes (flush ~200 ms) to control write volume.
- Reply order: streamed text and components, then **sources bar** at the end.

### 3.2 Sources bar (always last)

Stacked favicons + "N sources" pill + action row (share, save, regenerate, copy), tap to expand a list. Sources merged and de-duplicated across native search, app tools, and sub-agents. Source shape: `{url, title, favicon, snippet, origin}`.

### 3.3 Generative UI engine

The model never emits code. It calls **typed tools** from a component catalog (Zod schemas). Client renders HeroUI components, with skeletons while arguments stream.

**Flow:** message -> Jev router -> LLM with catalog tools -> streamed tool-call args -> `ComponentRenderer` validates and hydrates -> user interacts -> structured `ui_event` returned to the model.

**Rules:** validate every payload; no model-generated HTML/JS; every component has `fallbackText` (used by voice and older clients); props persisted so threads replay exactly.

**v1 catalog:** `MovieShowtimes`, `MapCard`, `Chart` (draggable, recomputes), `Table`, `Compare`, `Timeline`, `Form`, `Stepper`, `Checklist`, `ChoiceChips`, `Weather`, `ProductGrid`, `SubagentPlan`, `SubagentTimeline`, `ResearchPlan`, `ResearchProgress`.

**Hero scenario:** "What movies are playing near me?" -> geolocation permission inline -> TMDB now-playing + posters; theatres from OpenStreetMap/Overpass; times extracted from theatre sites (labelled "from theatre website") -> short text + `MovieShowtimes` + `MapCard` (pins and list synced) -> sources bar.

### 3.4 Bring-your-own models

- Settings: `providerId`, `baseUrl`, `apiKey`, optional headers.
- Fetch `GET {baseUrl}/models`; model picker in composer, grouped by provider, with capability tags.
- Calls via `/chat/completions` (`stream: true`); optional Responses API where supported.
- Keys encrypted at rest (AES-GCM, key in Convex env); never returned to client; all calls proxied through Convex actions.
- No tool-calling support -> prompted-JSON fallback for generative UI.

### 3.5 Capability profiles and adaptive reasoning

Per model, a versioned `capabilityProfile`:

```
reasoning: { style: effort|budget|toggle|none, field, levels[], budgets?, noop, defaultLevel }
features:  { vision, tools, streaming, reasoningText, audio, webSearch }
confidence, source: registry|probe|learned|manual, lastVerified
```

**Detection pipeline:** (1) fingerprint host + `/models` metadata + remotely updatable registry JSON; (2) lazy, user-confirmed probes with tiny `max_tokens` (accept `reasoning_effort`? nested `reasoning.effort`? `extra_body.thinking`? parse allowed values from error on invalid input; compare usage low vs high to detect no-ops; detect reasoning fields/`<think>` tags; native web search); (3) learn from live traffic (400 -> retry without param and downgrade; zero reasoning tokens -> mark no-op; success streak raises confidence); (4) manual override is final and never overwritten.

**Request builder:** `buildRequest(profile, level, messages)` picks field name, maps levels to budgets, ensures `budget < max_tokens`.

**UI:** "Thinking" control in composer with **Auto / Off / supported levels**; hidden if unsupported. Thinking block (collapsible) when the endpoint returns reasoning text. Per-reply chip: level used and reasoning tokens. Per-thread level, per-model default. Spend caps on probes.

### 3.6 Sub-agents

Orchestrator-worker: main agent is the only one that talks to the user; spawns workers via `spawn_subagents` tool.

- **Triggers:** Auto (Jev decision: `none | single | parallel(2-5) | research`), or user command ("use sub-agents", `/agents`, "research with 4 agents"). Explicit request always overrides.
- **Setting:** Off / Auto (default) / Always offer.
- **Contract per task:** goal, scope, inputs, allowed tools, output schema, evidence requirement, budget.
- **Isolation:** own context; return distilled result; long outputs stay in run logs.
- **Limits:** max depth 1 (workers cannot spawn workers); max 5 parallel; token/search/time caps; large plans show `SubagentPlan` approval card (tasks, model per task, cost estimate).
- **Roles with tool allowlists:** search, reader, maps, code, vision, memory-read, verifier. Only the parent can propose memory writes.
- **Failure:** partial failure continues and notes the gap; over-budget stops and returns partial results with a "continue?" chip.
- **UI:** `SubagentTimeline` (status per worker, sources read, expandable result, cancel one/all).

### 3.7 Deep Research mode

A preset on the sub-agent engine. Toggle beside the model picker.

1. **Clarify** (ChoiceChips) -> 2. **Plan** (editable `ResearchPlan`) -> 3. **Parallel search/read workers** -> 4. **Reflect/loop** (depth limit and budget) -> 5. **Synthesize** (strongest model, high reasoning) -> 6. **Verify** (every citation must exist in retrieved set; drop others) -> 7. **Deliver** (streamed report, sources bar, export to PDF/Markdown).

Role-to-model tiers are configurable: planner (strong, medium-high), search/reader (small, low), verifier (mid), synthesizer (strongest, high). Optional separate "research model" setting. Runs in background with push notification; pre-run cost cap shown.

### 3.8 Internet access

**Provider interface:** `WebProvider { search(), read() }`.

- **Native first:** if the model's profile has `webSearch` (OpenAI Responses `web_search`, Anthropic server tool, OpenRouter server tool), use it. Cost falls on the user's own key.
- **App tools fallback (free):** Convex actions with `fetch` + Readability (Node runtime) for `read_url`; search via user-supplied key/URL (Brave, Tavily, public SearXNG instance) or free keyless sources (Wikipedia, HN) where appropriate.
- **Setting:** Auto / Native only / App tools only.
- **Phase 2 (optional, free):** self-hosted gateway (SearXNG + Crawl4AI, optional Playwright MCP) on Oracle Always Free VM or own machine via Cloudflare Tunnel, as an alternate `WebProvider` with no agent/UI change.
- **Known Convex limits:** no containers or browsers; weak on JS-rendered sites; shared IPs may be blocked; actions have time/memory ceilings.
- **Security:** fetched content is untrusted data (delimited, no instructions followed); search workers have no write/memory permissions; any action with side effects needs parent approval and user confirmation; respect robots.txt; cache by URL with content-type TTLs; per-run caps.
- Citations normalized to the single `sources` shape.

### 3.9 Memory and custom instructions

- **Custom instructions:** always prepended to system prompt; separate from memory.
- **Memory:** per-thread and cross-thread; global toggle and per-thread "incognito".
- **Write gate (Jev):** `shouldRemember`, category, scope (thread/global), confidence. High: auto-save; mid: inline confirm chip; low: skip.
- **Retrieval:** Convex vector search, then Jev relevance check; inject top few.
- **Memory tab:** view, edit, delete, export all memories.
- Embeddings via user's provider or a configured embedding model.

### 3.10 Images

Attach via picker, paste, or camera; upload to Convex storage; downscale client-side; send as `image_url` parts to vision-capable models; warn when the selected model lacks vision.

### 3.11 Voice

- **Input:** hold-to-talk, live waveform, streaming partial transcript into composer. On-device iOS speech recognition by default; optional `/audio/transcriptions` on the user's endpoint.
- **Output:** `expo-speech` by default; optional `/audio/speech`. Reads text sentence by sentence; components are summarized via `fallbackText`.
- Jev supports end-of-turn/interrupt decisions in hands-free mode.

---

## 4. Jev Integration

Jev (TypeSafe System One) returns typed, probabilistic decisions over a fixed choice set (cardinality up to 255); it does not generate text. It is in early access, so everything sits behind a `DecisionProvider` interface with a heuristic / small-LLM constrained-JSON fallback. All LLMs still write all prose.

| Decision             | Output                                               | Effect                                     |
| -------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Intent routing       | chat / search / UI-build / image / memory / research | Skip unneeded tools                        |
| Component selection  | probability per catalog component                    | Pre-load skeleton instantly                |
| Memory write gate    | remember?, category, scope, confidence               | Durable facts only                         |
| Memory retrieval     | relevance per candidate                              | Minimal context injection                  |
| Reasoning level      | difficulty class                                     | Map to nearest supported level (Auto mode) |
| Sub-agent decision   | none / single / parallel(n) / research               | Delegation                                 |
| Search decision      | none / quick / deep; time-sensitive flag             | Auto web access                            |
| Error classification | bad param / rate limit / auth / context overflow     | Adapt, retry, or surface                   |
| Probe triage         | which probes to run                                  | Cheaper endpoint detection                 |
| Follow-up chips      | ranked next actions                                  | `ChoiceChips`                              |
| Moderation/PII flags | typed flags                                          | Mask before logging                        |
| Voice turn-taking    | continue / end / interrupt                           | Hands-free flow                            |

**Thresholds:** >0.85 act; 0.5-0.85 lightweight confirm; <0.5 ask or fall back. Log every decision and user override (`decisions` table) as an evaluation set. Treat Jev availability and pricing as unverified until tested.

---

## 5. Architecture

- **Client:** Expo Router, HeroUI Native, Uniwind, `expo-glass-effect`, MapLibre (OSM tiles), Reanimated, `expo-speech`, `expo-image-picker`.
- **Backend:** Convex (queries/mutations/actions, Workflow + Workpool for durable parallel runs, vector search, file storage, scheduled functions).
- **AI layer:** Vercel AI SDK or custom OpenAI-compatible client with adapter layer (reasoning, web search, tools).
- **Data:** TMDB (free, non-commercial, attribution required; ~6-month cache cap), OpenStreetMap/Overpass/Nominatim (light use), theatre sites via `read_url`.

### Convex schema (core)

```ts
users, settings { customInstructions, memoryEnabled, voiceId, subagentMode, webMode }
providers { userId, providerId, baseUrl, keyCipher, models[] }
capabilityProfiles { providerId, modelId, reasoning, features, confidence, source, lastVerified, version }
probeLogs { providerId, modelId, probe, request, status, result, ts }
threads { userId, title, modelRef, mode: chat|research, reasoningLevel, memoryScope }
messages { threadId, role, parts[] }          // text|component|image|sources|ui_event|thinking
attachments { messageId, storageId, mime }
memories { userId, threadId?, text, category, embedding, confidence, createdAt }
decisions { userId, kind, input, output, overridden, ts }
reasoningEvents { threadId, messageId, levelRequested, levelSent, reasoningTokens, outcome }
agentRuns { threadId, parentRunId?, role, brief, model, status, budget, result, error }
agentSteps { runId, kind, input, output, tokens, ts }
researchRuns { threadId, status, plan, depth, budget, startedAt }
sources { runId?, messageId, url, title, favicon, snippet, origin }
webCache { url, content, contentType, fetchedAt, ttl }
```

---

## 6. Cost and Free-Tier Constraints

- No paid services required by the app. Model and native-search costs fall on the user's own keys.
- Convex free plan: watch function calls, action compute, and egress. Buffer token writes; cap fetches per research run; cache aggressively.
- Probe spend capped and shown to the user.

## 7. Security and Privacy

- API keys encrypted server-side; never sent back to client; probes and model calls run in Convex actions only.
- Probe requests contain no user data.
- Prompt-injection defenses (Section 3.8); side-effect actions require confirmation.
- Memory fully user-controllable; incognito per thread; PII masking before logs.
- Location permission requested inline and only when needed.

## 8. Roadmap

| Phase                  | Scope                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| 0 - Foundation         | Scaffold, dark theme tokens, fonts, native tabs, `GlassView` composer, Convex + auth        |
| 1 - Chat core          | Threads, streaming, BYO provider and model picker, sources bar                              |
| 2 - Generative UI      | Registry, renderer, `Chart`, `MapCard`, `MovieShowtimes`, `ChoiceChips`, ui_event loop      |
| 3 - Intelligence layer | Capability profiles, probes, reasoning controls, native web search + `WebProvider` fallback |
| 4 - Memory             | Custom instructions, memory write/retrieve, Memory tab, toggles                             |
| 5 - Agents             | Sub-agent engine, timeline, plan approval, Deep Research                                    |
| 6 - Multimodal         | Images, voice in/out                                                                        |
| 7 - Jev                | `DecisionProvider`, Jev integration across decisions, decision log                          |
| 8 - Hardening          | Accessibility, reduced motion/transparency, performance, TestFlight                         |

Jev is wired through `DecisionProvider` from Phase 1 (heuristic first), so Phase 7 swaps implementations rather than re-architecting.

## 9. Success Metrics

- Time-to-first-token < 1.5 s on a typical endpoint; stable 60 fps while streaming with glass UI.
- > 95% of component payloads pass schema validation first try (with repair fallback).
- Capability detection correct on >90% of tested endpoints without manual override.
- Zero API-key leaks to client; zero unverified citations in research reports.

## 10. Risks and Open Items

| Risk                                          | Mitigation                                                 |
| --------------------------------------------- | ---------------------------------------------------------- |
| Jev early access / pricing unknown            | `DecisionProvider` fallback; test before committing        |
| Convex-only web access weak on JS-heavy sites | Phase 2 gateway (SearXNG + Crawl4AI) as alternate provider |
| No free reliable showtimes API                | Extract from theatre sites, label source; revisit later    |
| Liquid Glass perf/flicker bugs                | Glass on chrome only; early device testing                 |
| Moderniz license                              | Verify before shipping                                     |
| Provider quirks in "OpenAI-compatible" APIs   | Probes, learning loop, manual overrides                    |
| Free-tier overruns                            | Buffered writes, caching, per-run caps                     |
| TMDB non-commercial terms                     | Attribution; renegotiate if commercialized                 |

**Open decisions (to settle during build):** final app name; separate "research model" setting vs shared; Phase 2 gateway host (Oracle free VM vs own machine); auth provider for Convex.
