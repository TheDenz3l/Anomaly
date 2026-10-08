# Anomaly

Personal generative-UI chat app (see `PRD_Generative_UI_Chatbot.md`). Expo app on a Convex backend: every reply comes from a real model, with live web, weather, places and movie data. No mock data.

## Run it

```bash
npm install
npm run convex     # push backend functions (writes EXPO_PUBLIC_CONVEX_URL to .env.local)
npm run web        # http://localhost:8081 — fastest way to test the UI
npm run ios        # needs a development build (Xcode 26) for native tabs, Liquid Glass and on-device speech
```

Each device signs in anonymously on first launch. Add your model provider (endpoint + key) in Settings → Providers; chat only ever uses providers you add. Web is a test harness: same components, with a blur fallback for glass. HeroUI Native doesn't officially support web, so judge final polish on device.

## What to try

A new chat is just the Anomaly orb. Some prompts that exercise the cards and tools:

| Prompt                                                                                     | Shows                                                                                              |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| What movies are playing near me?                                                           | inline location request → `MovieShowtimes` + `MapCard` → pick a time (ui_event loop)               |
| Show my savings if I add $500 a month                                                      | draggable `Chart` that recomputes, scrub the plot                                                  |
| Compare two phones using sub-agents                                                        | `SubagentTimeline` (or a `SubagentPlan` approval for big plans) → `Compare`                        |
| Research toggle + any question                                                             | Deep Research: `ChoiceChips` clarify → editable `ResearchPlan` → `ResearchProgress` → cited report |
| weather / packing list / book a table / headphones / history of the web / set up WireGuard | `Weather`, `Checklist`, `Form`, `ProductGrid`, `Timeline`, `Stepper`                               |
| Remember that I'm vegetarian                                                               | memory write gate (auto-save with undo; "I'm …" without "remember" asks first)                     |
| attach a photo with a non-vision model                                                     | vision warning                                                                                     |

Navigation: the menu button (top left) or a swipe from the left edge opens the side drawer: Artifacts, Memory, recent chats (View all opens full history and search), Settings (bottom left) and New chat. Tap the chat title for chat options (incognito, rename, delete).

Artifacts: everything Anomaly made in your chats (calculators, checklists, guides, maps, showtimes, shopping picks, tables, comparisons, timelines and Deep Research reports) in one gallery with live previews. Filter by Apps, Reports or Data; pin favourites (long-press a card, or the pin in the viewer); open one full size, still interactive, with a link back to its chat. Anything sent from an artifact continues that chat. Incognito chats are left out.

Also: model picker (capability tags), Thinking control (Auto/Off/levels per model), stop/regenerate/copy/share/save/read-aloud, sources sheet, History (search, open, delete), Memory (edit, filter, export JSON), Settings (providers, capability profiles, probes, manual overrides, sub-agent/web/voice settings).

## Layout

```
src/app/                  index (Chat), artifacts, artifact/[id], history, memory, settings — a Stack; the drawer lives on Chat
src/components/chat/      composer, messages, markdown, sources bar, pickers
src/components/navigation SideDrawer (push-style drawer, edge swipe) + NavPanel (drawer contents)
src/components/ui/        Glass (GlassView → blur fallback), Sheet, Slider, Segmented, …
src/genui/schemas.ts      Zod catalog — every tool call is validated before render
src/genui/components/     the 16 catalog components + LocationRequest, MemoryConfirm
src/genui/ComponentRenderer.tsx  skeleton → validate → hydrate, ui_event emit
src/lib/convex.ts         Convex client + generated api
src/lib/sync.tsx          anonymous sign-in + Convex subscriptions mirrored into the store
src/lib/store.ts          zustand store: server data from Convex, actions call Convex with optimistic parts
convex/                   backend (see below)
```

## Backend (Convex)

`convex/` is the full backend from the PRD. Dev deployment: `vibrant-platypus-358`.

```bash
npm run convex                     # convex dev: push functions, watch, codegen
npm run setup:convex               # once per deployment: auth keys, ENCRYPTION_KEY, JEV/TMDB keys from APIkeys.rtf, SEARXNG_URLS
npm run setup:convex -- --prod     # same for production
```

Env on the deployment: `JEV_API_KEY` (an OpenRouter key used only for Jev decisions, never for chat), `TMDB_API_KEY` (TMDB read access token), `SEARXNG_URLS` (comma-separated SearXNG instances; the default web search). Optional: `JEV_MODEL` (default `typesafe/jev-1.13`), `JEV_DISABLED=1`, `FIRECRAWL_API_KEY` (off for now), `APP_CONTACT`, `REGISTRY_URL`. Never change `ENCRYPTION_KEY` after keys are stored.

Jev (PRD §4) is a decision model, not a chat model: it returns typed answers with probabilities through OpenRouter's Decisions API (~0.15–0.25 s). `convex/ai/decisions.ts` implements every row of the PRD table behind `DecisionProvider`, with heuristics as the fallback:

| Decision                                                                                                                           | Where it acts                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent routing, search decision, sub-agent decision, component selection, reasoning level, memory write gate, moderation/PII flags | one batched request per turn (`engine/turn.ts`): skips unneeded tools, sizes web search, prompts or offers delegation (research → "Run Deep Research?" chips), pre-loads the likely card's skeleton, maps difficulty to the model's reasoning level in Auto, auto-saves / asks / skips memories, masks decision logs |
| Memory retrieval                                                                                                                   | relevance per recalled memory before injection (`engine/memory.ts`)                                                                                                                                                                                                                                                  |
| Error classification                                                                                                               | bad param / rate limit / auth / overflow → retry or surface (`engine/loop.ts`)                                                                                                                                                                                                                                       |
| Probe triage                                                                                                                       | which capability probes to run (`probes.run`)                                                                                                                                                                                                                                                                        |
| Follow-up chips                                                                                                                    | ranked next actions after a reply, shown only when confident                                                                                                                                                                                                                                                         |
| Voice turn-taking                                                                                                                  | continue / end / interrupt (`voice.turnTaking`)                                                                                                                                                                                                                                                                      |

Thresholds: > 0.85 act, 0.5–0.85 lightweight confirm, < 0.5 heuristic fallback. Every decision is logged in `decisions`.

| Area             | Where                                                                | Client API                                                                                                  |
| ---------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Auth             | `auth.ts` (Anonymous + Password, `@convex-dev/auth`)                 | `signIn("anonymous")`, `users.viewer`                                                                       |
| Chat             | `messages.ts`, `threads.ts`, engine in `engine/`                     | `messages.send/list/emitUiEvent/stop/regenerate/toggleSaved/saved`, `threads.list/get/update/remove/search` |
| Models           | `providers.ts`, `models.ts`, `probes.ts`, `ai/registry.ts`           | `providers.save/list/refresh/remove`, `models.list/setOverride/clearOverride`, `probes.plan/run/logs`       |
| Settings         | `settings.ts`                                                        | `settings.get/update/setSearchKey/registerPushToken`                                                        |
| Memory           | `memories.ts`, `engine/memory.ts`                                    | `memories.list/create/update/remove/removeAll/exportAll`                                                    |
| Agents, research | `engine/agents.ts`, `engine/research.ts`, `agents.ts`, `research.ts` | `agents.forThread`, `research.forThread`                                                                    |
| Media            | `attachments.ts`, `voice.ts`                                         | `attachments.generateUploadUrl/register`, `voice.turnTaking`                                                |

How a reply runs: `messages.send` inserts the user message and an empty `streaming` assistant message, then schedules `chat.run`. The engine (`engine/turn.ts`) runs heuristic/Jev decisions, recalls memories, and loops the model with the component catalog (`src/genui/schemas.ts`, shared with the client) plus app tools (web search/read, weather, places, showtimes, location, memory, sub-agents). Parts stream into the message with buffered writes (~200 ms), so `messages.list` is the live stream. Parts match `src/lib/types.ts`; ids are Convex ids, `createdAt` is `_creationTime`.

Web access: models with their own search (Perplexity, OpenAI search-preview, `:online`) use it; everything else uses app tools: the user's own Brave/Tavily/SearXNG key or URL, then the server SearXNG pool (instances that rate-limit are skipped for 10 minutes), then keyless Wikipedia + Hacker News. Public SearXNG instances that allow JSON are rare and flaky; for reliability self-host one (PRD Phase 2) and put its URL in `SEARXNG_URLS`. Pages are fetched with robots.txt checks, cached in `webCache`, and wrapped as untrusted content. Free data: Open-Meteo (weather), OpenStreetMap Overpass/Nominatim (places), TMDB (movies, needs a key).

Model calls run in Convex's cloud, so local servers (LM Studio, Ollama) need a public tunnel URL.

## Notes

- Activity states use dot-sphere orbs (`src/components/orb`), ported from [thinking-orbs](https://thinkingorbs.com) (MIT) to Reanimated worklets: the frame is computed on the UI thread and drawn as 8 SVG paths, one per opacity band. Labels shimmer via per-character opacity (`ShimmerText`), so it works on web and native without masked views.
- Search steps are a `search` message part (queries + sources, streamed in), rendered by `SearchBlock`. Inline `[n]` citations in reply text become publisher pills that open the cited sources.

- Motion lives in `src/lib/motion.ts` (springs, page/section entrances, message entrances, pop-in controls). Everything respects Reduce Motion. On web, spring variants fall back to Reanimated’s plain presets, which is the only form its web layout animations support cleanly.

- `metro.config.js` patches a Uniwind web resolver bug (circular `InputAccessoryView` import).
- `src/global.css` pins HeroUI hover colors because `color-mix()` can't be parsed by HeroUI's colorKit on web.
- Fonts: Satoshi (Fontshare) and Moderniz (`assets/fonts`, free for personal and commercial use per its readme).
- MapCard is a stylised SVG for now; MapLibre + OSM tiles replace the drawing layer in the native build.
