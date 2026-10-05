# Anomaly

Personal generative-UI chat app (see `PRD_Generative_UI_Chatbot.md`). This is the **frontend only**, running on mock data — no backend, no API keys, no network calls.

## Run it

```bash
npm install
npm run web        # http://localhost:8081 — fastest way to test the UI
npm run ios        # needs a development build (Xcode 26) for native tabs + Liquid Glass
```

Web is a test harness: same components, with a blur fallback for glass. HeroUI Native doesn't officially support web, so judge final polish on device.

## What to try

A new chat is just the Anomaly orb, so type one of these (or anything else):

| Prompt                                                                                     | Shows                                                                                              |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| What movies are playing near me?                                                           | inline location request → `MovieShowtimes` + `MapCard` → pick a time (ui_event loop)               |
| Show my savings if I add $500 a month                                                      | draggable `Chart` that recomputes, scrub the plot                                                  |
| Compare Pixel 11 and iPhone 17 using sub-agents                                            | `SubagentPlan` approval → live `SubagentTimeline` → `Compare`                                      |
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
src/lib/engine/           DecisionProvider (heuristic; Jev later), mock scenarios, streaming player
src/lib/store.ts          zustand store — the seam the Convex backend replaces
```

## Swapping in the backend

`src/lib/store.ts` `runAssistant` streams a `Script` from `src/lib/engine/scenarios.ts` through `play()`. Replace that with the Convex action stream; parts keep the same shape (`text | component | image | sources | ui_event | thinking`), so the UI doesn't change.

## Notes

- Activity states use dot-sphere orbs (`src/components/orb`), ported from [thinking-orbs](https://thinkingorbs.com) (MIT) to Reanimated worklets: the frame is computed on the UI thread and drawn as 8 SVG paths, one per opacity band. Labels shimmer via per-character opacity (`ShimmerText`), so it works on web and native without masked views.
- Search steps are a `search` message part (queries + sources, streamed in), rendered by `SearchBlock`. Inline `[n]` citations in reply text become publisher pills that open the cited sources.

- Motion lives in `src/lib/motion.ts` (springs, page/section entrances, message entrances, pop-in controls). Everything respects Reduce Motion. On web, spring variants fall back to Reanimated’s plain presets, which is the only form its web layout animations support cleanly.

- `metro.config.js` patches a Uniwind web resolver bug (circular `InputAccessoryView` import).
- `src/global.css` pins HeroUI hover colors because `color-mix()` can't be parsed by HeroUI's colorKit on web.
- Fonts: Satoshi (Fontshare) and Moderniz (`assets/fonts`, free for personal and commercial use per its readme).
- MapCard is a stylised SVG for now; MapLibre + OSM tiles replace the drawing layer in the native build.
