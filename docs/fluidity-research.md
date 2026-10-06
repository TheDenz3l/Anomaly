# Fluidity research: sheets, drawer, navigation

Goal: opening and closing the model picker, the side drawer and screen pushes should feel instant and continuous, at 120 Hz on ProMotion.

Stack: Expo SDK 57, React Native 0.86.3, React 19.2, Reanimated 4.5.1 + react-native-worklets 0.10.1, react-native-screens 4.26, react-native-gesture-handler 2.32, expo-glass-effect, React Compiler on (`app.json` experiments).

Confidence tags: **[code]** read in this repo. **[docs]** from official docs, retrieved through web search summaries (not opened page by page). **[inference]** reasoning, not measured. Nothing here has been profiled on a device yet. Section 6 says how to do that first.

---

## 0. Progress

Done (typecheck and lint clean; open/close measured on web, not yet on device):

- **Sheets leave RN `Modal`.** `src/components/ui/Portal.tsx` renders overlays in a `PortalHost` mounted after the Stack in `_layout.tsx`. `FormSheet` and `Sheet` now run slide, backdrop and drag-to-dismiss on the UI thread (Reanimated shared value + RNGH `Gesture.Pan`), with no `PanResponder` and no RN `Animated`.
- **Slide starts at the screen edge.** A sheet measures itself first (one layout pass) and hides just past its own height. Before, it hid a full screen height down, so the first part of the slide was invisible. On web the picker now moves on the first frame and is within 5 px of rest by ~300 ms.
- **Closing frees the screen at once.** `pointerEvents` flips to `none` when the close starts. The close uses an ease-out (`sheetMotion` in `lib/motion.ts`, clamped so the first frame can't dip the wrong way).
- **Model picker opens without mounting anything.** `FormSheet keepMounted` builds it in `requestIdleCallback` and keeps it built while closed. The picker holds its list order and size from open until it has slid away, so a pick only moves the checkmark. The page swipe-back is an RNGH pan.
- **Drawer.** The context is split: `useDrawer()` is stable and `useDrawerOpen()` re-renders on toggle. Gestures are memoized and the edge detector stays mounted. A screen pushed from the drawer slides over it, and the drawer snaps shut on the covered screen's `transitionEnd`, so there's one motion instead of two.
- **Orb.** Pauses while the chat screen is unfocused, the drawer is open or a sheet covers it. It redraws at most every 15 ms (60 fps on a 120 Hz screen).

Dropped: **`freezeOnBlur`.** Expo Router's native stack never freezes the screen directly below the focused one on Fabric (`NativeStackView.native.js`, `isBelowFocused`), so the chat under Settings wouldn't freeze. The orb pause covers the real cost there.

Next:

1. Release build on device; run section 6 and record numbers.
2. Reanimated static flags with `Tap` on RNGH `Pressable`, behind an A/B.
3. Move `ThreadMenu` off `Modal` onto the portal.
4. Virtualize the drawer's thread list if it grows.

---

## 1. What the code does today

### Model picker (`Composer.tsx:268` pill → `ModelPicker.tsx` → `FormSheet.tsx`)

1. **Mount on open, unmount on close [code].** `FormSheet.tsx:235` returns `null` until `open`, then mounts a React Native `<Modal>` (`:244`) and the full subtree in the same frame the slide starts. On iOS `Modal` creates a native view controller, so that cost lands in the first frame too. On close it animates 220 ms, then `setMounted(false)` (`:221`) tears everything down again. Every open pays full creation cost; every close pays full destruction cost.
2. **Subtree is heavy for a menu [code].** Each `Row` is a `Tap`, which is an `Animated.createAnimatedComponent(Pressable)` with two shared values, `useReducedMotion` and a `useAnimatedStyle` (`Tap.tsx:28-40`). The picker renders up to 5 model rows, Thinking, More models, Manage providers, plus the Thinking page rendered a second time off-screen just to measure it (`ModelPicker.tsx:437-447`). That is roughly 15-20 `Tap`s. Plus `Glass` radius 38 (`FormSheet.tsx:124`) and two interactive `Glass` toolbar buttons (`:76`).
3. **Layout happens twice while the sheet slides in [code].** `bodyH` is derived from `mainH` / `thinkH`, which are state set from `onLayout` (`ModelPicker.tsx:442`, `:458`). First render has `bodyH = WINDOW_GAP` (12 px), then `onLayout` fires, state updates, the sheet re-renders and re-lays out at its real height, all while the entry spring is running. The Glass shape is resized mid-animation.
4. **Mixed animation engines [code].** Sheet position uses RN core `Animated` (native driver), keyboard/lift uses Reanimated, the page slide uses Reanimated, drag-to-dismiss uses `PanResponder` + `drag.setValue` (`FormSheet.tsx:178-195`). `PanResponder` events cross the JS thread every move, so a drag stutters whenever JS is busy. `SideDrawer` already uses the right model (RNGH `Gesture.Pan` + worklets); the sheet does not.
5. **Selection does three things at once [code].** `pick()` (`ModelPicker.tsx:233`) calls `onSelect` (store write → Composer and every subscriber re-render) and `onClose` (starts the 220 ms close, then unmount) in the same tick. The JS thread is busiest exactly when the close animation needs smooth frames.
6. **"Manage providers" pushes a route under a live Modal [code].** `manage()` (`:276`) calls `onClose()` then `router.push("/settings")` immediately. The sheet is still mounted for 220 ms and the Settings screen mounts at the same time.
7. **The picker listens to the store while closed [code].** `ModelPicker` is mounted permanently inside `Composer` (`Composer.tsx:350`) and subscribes to `threads`, `models`, `providers`, `settings` (`ModelPicker.tsx:163-166`). `short` sorts every thread (`:245`). Composer also re-renders on every keystroke (`text` state).
8. **Same pattern elsewhere [code].** `Sheet.tsx` (chat options in `ChatHeader`) is the same Modal + mount-on-open design, and `ThreadMenu.tsx` also uses `Modal`.

### Side drawer (`SideDrawer.tsx`, `NavPanel.tsx`)

1. **Drag and spring run on the UI thread, which is right [code].** `progress` is a shared value, styles are `useAnimatedStyle`. The structure is sound.
2. **React state flips at the start of the animation [code].** `animateTo` calls `settle`, which calls `setIsOpen` (and `Keyboard.dismiss`) the moment the spring starts. The context value `{ open, close, isOpen, progress }` is a new object each render (`SideDrawer.tsx` provider), so every `useDrawer()` consumer re-renders in the first frames. Three `Gesture.Pan()` objects are rebuilt per render, and the edge `GestureDetector` is mounted/unmounted on toggle (`{!isOpen ? ... : null}`). React Compiler may hide some of this; confirm in the profiler.
3. **Navigating from the drawer overlaps two heavy things [code].** `NavPanel.tsx:82` `go()` runs `close()` then `router.push(href)` together: the drawer spring and the new screen's JS mount compete.
4. **The thread list is not virtualized and always mounted [code].** `NavPanel` renders `recents.map(...)` inside a `ScrollView`, subscribes to the whole `threads` map (`:53`), so any thread patch re-renders every row, even with the drawer closed.

### Always-running work

- **The empty-state orb never stops [code].** `Orb.tsx:60` runs a `useFrameCallback` every frame; each frame writes 8 animated `Path` `d` strings plus one `Circle` (`BANDS = 8`, `orb-core.ts:12`). With react-native-svg these are non-style props, so they most likely go through a Fabric commit per frame instead of the synchronous fast path **[inference]**. It keeps running while the model picker is open, while the drawer is open, and while another screen is pushed on top (Stack keeps the chat screen mounted; no `freezeOnBlur`, no focus pause). The screenshot you sent shows exactly this screen.
- **Glass count [code].** Header: 2 interactive `Glass` buttons. Composer: 1 large interactive `Glass`. Picker: 1 large + 2 interactive. All GPU-composited every frame.

### Config

- `CADisableMinimumFrameDurationOnPhone` is already `true` in `ios/Anomaly/Info.plist` [code]. Good.
- No `reanimated.staticFeatureFlags` in `package.json` [code]. The Fabric fast paths are off.
- `reactCompiler: true` [code]. Manual `useMemo`/`useCallback` is mostly unnecessary, but it does not stop Zustand re-renders.
- Navigation is `expo-router` `Stack` with defaults [code]: native transitions already, so push animation itself is not the problem; the delay before it is JS mount time **[inference]**.

---

## 2. Reference: what the docs say

### Reanimated 4 performance [docs]

https://docs.swmansion.com/react-native-reanimated/docs/guides/performance/

- Animate `transform`, `opacity`, `backgroundColor`. Avoid animating `width`/`height`/`top`/`left`/`margin`: each forces layout every frame.
- Do not read `sv.value` on the JS thread in render/effects. Use `scheduleOnRN` (replaces `runOnJS`) sparingly.
- Memoize `Gesture.Pan()` objects and `useFrameCallback` worklets (React Compiler does this automatically when it can).
- Static flags, set in the app's `package.json`, need native rebuild, not available in Expo Go:
  - `IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS` (≥ 4.2.0): applies non-layout styles (opacity, transform, backgroundColor, borderRadius, shadow*) without `ShadowTree::commit`.
  - `USE_COMMIT_HOOK_ONLY_FOR_REACT_COMMITS` (RN ≥ 0.80, Reanimated ≥ 4.2.0): helps FPS when many animated components are on screen.
  - `DISABLE_COMMIT_PAUSING_MECHANISM` + RN flag `preventShadowTreeCommitExhaustion`: fixes scroll-handler flicker.
- Caveat for the iOS flag: Fabric touch handling ignores synchronously applied transforms, so an RN `Pressable` can fire `onPressIn` and drop `onPress` mid/post animation. Docs recommend `Pressable` from `react-native-gesture-handler`. **`Tap` is exactly this case** (RN `Pressable` + animated scale).
- Known reports with the iOS flag: Reanimated #8810 (animatedStyle dropped for a frame when animatedProps change), react-native-screen-transitions #133 (slower navigation). A/B test; do not assume.
- Guideline: ≤ ~500 simultaneously animated components on iOS; use Skia beyond that.
- Measure in release builds; debug builds exaggerate JS cost.
- Feature flags: https://docs.swmansion.com/react-native-reanimated/docs/guides/feature-flags/
- Animating SVG: https://docs.swmansion.com/react-native-reanimated/docs/guides/animating-svg/ (works, but docs do not say SVG props use the fast path).

### Sheets and modals [docs] / [inference]

- Mounting the content, not the animation, is usually the biggest cost. `Modal` with `visible={false}` renders nothing, so it cannot be pre-warmed; a self-managed sheet kept mounted off-screen can. Keep it `pointerEvents="none"` when closed and stop its content updating.
- Defer heavy children until the open animation settles (`onShow`, `InteractionManager.runAfterInteractions`, `requestAnimationFrame`), show the shell first.
- Native alternative: expo-router `presentation: 'formSheet'` with `sheetAllowedDetents` (`'fitToContents'` or fractions), `sheetGrabberVisible`, `sheetCornerRadius`. Gestures and detents are native (UIKit sheet on iOS, so Liquid Glass on iOS 26 comes from the system). Limits: animation duration not customizable on iOS; `flex: 1` + `fitToContents` breaks on Android; iOS sheet may resize with keyboard; it is a route, so the custom sliding pages would become a nested navigator or in-screen state. https://reactnavigation.org/docs/native-stack-navigator/
- No published benchmark compares `formSheet` with JS `Modal`; any gain is reasoning, not measurement.
- `@gorhom/bottom-sheet` is already a dependency: memoize `snapPoints`, prefer fixed snap points over `enableDynamicSizing` (extra measure pass). https://www.shipnative.dev/blog/react-native-bottom-sheet
- With RN `Modal`, RNGH gestures need a `GestureHandlerRootView` inside the Modal.

### Liquid Glass [docs]

https://docs.expo.dev/versions/latest/sdk/glass-effect/ , https://developer.apple.com/documentation/swiftui/glasseffectcontainer

- Cost is GPU compositing and grows with the number and area of glass views and with content moving behind them.
- Group neighbouring glass in `GlassContainer` (Apple: rendered together, "improving rendering performance").
- `opacity: 0` on a `GlassView` or any parent stops it rendering. Fade with `glassEffectStyle={{ style, animate: true, animationDuration }}` or toggle style to `'none'` near 0.
- Keep glass for chrome only (the repo already follows this); avoid `isInteractive` on many views; check `isLiquidGlassAvailable()`.
- Verify on device with Instruments (Core Animation / Metal System Trace), not the simulator.
- Callstack guide: https://www.callstack.com/blog/how-to-use-liquid-glass-in-react-native

### Navigation [docs]

https://docs.expo.dev/versions/latest/sdk/router/ , https://docs.expo.dev/versions/v55.0.0/sdk/router/stack

- `router.prefetch(href)` exists ("prefetch a screen in the background before navigating"). Docs do not say what it does natively; measure before relying on it.
- `freezeOnBlur` (per screen) or `enableFreeze(true)` from `react-native-screens`: inactive screens stop re-rendering. Trade-off: a frozen screen does not update until focused.
- Stack `animation`: `default`, `fade`, `simple_push`, `slide_from_bottom`, `none`, etc. `animationDuration` only applies to `slide_from_bottom`, `fade_from_bottom`, `fade`, `simple_push` on iOS; not to `default`, modal, formSheet, pageSheet.
- SDK 55+: synchronous screen layout updates on by default; opt-out `disableSynchronousScreensUpdates` in the expo-router plugin config if a regression appears.
- Native stack runs transitions on the platform; the new screen's React tree still mounts on the JS thread first.

### State and re-renders [docs]

https://zustand.docs.pmnd.rs/reference/hooks/use-shallow , https://docs.expo.dev/guides/react-compiler/

- React Compiler memoizes components and children, but cannot stop a Zustand re-render: the selector result decides. Use narrow selectors, `useShallow` for object/array results, stable action references. Derived values (`short`, `recents`) belong in a selector or a memo keyed on the narrow slice, not on the whole `threads` map.

### 120 Hz [docs]

`CADisableMinimumFrameDurationOnPhone` raises the cap; iOS still adapts the rate. At 120 Hz per-frame overhead costs twice as much, so hitches are easier to see. At 8.3 ms per frame, JS work above that during an animation shows as a drop.

---

## 3. Prioritized plan

Ordered by (felt improvement) ÷ (risk). Each item names its check.

### P0: measure and cheap config (hours)

1. Build Release on a real iPhone; record the 7 scenarios in section 6 as the baseline. Everything below is judged against it.
2. Pause the orb whenever it is not the focus: `paused` prop already exists. Pass `paused` when the picker/drawer is open or the chat screen is unfocused (`useIsFocused`). Check: JS/UI frame time during picker open on the empty chat, before/after.
3. Add `freezeOnBlur: true` on the Stack (and `enableFreeze(true)`), so the chat screen stops re-rendering under pushed screens. Check: Settings push, then streamed message arrives, no chat re-render in Profiler.
4. Add Reanimated static flags in `package.json`, rebuild native:
   `"reanimated": { "staticFeatureFlags": { "IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS": true, "USE_COMMIT_HOOK_ONLY_FOR_REACT_COMMITS": true } }`
   Before enabling the iOS flag, switch `Tap` to RNGH `Pressable` (or verify `onPress` survives a mid-squeeze release). A/B against baseline; revert if navigation or one-frame flicker regresses.

### P1: model picker (the reported problem)

1. **Stop paying mount cost per open.** Replace RN `Modal` + RN `Animated` + `PanResponder` with an in-tree overlay at the root layout: a Reanimated `translateY` shared value, RNGH `Gesture.Pan` for drag-to-dismiss (worklets, no JS per move), `pointerEvents="none"` when closed. Keep the shell mounted; mount body content once and keep it. Same engine as `SideDrawer`, so the sheet and drawer feel the same. Removes the native view-controller presentation and the Modal/route-push conflict (item 6 above).
2. **Remove the second layout pass.** Heights are deterministic (`row minHeight 56`, known row counts, known footer). Compute `bodyH` from counts, or measure once and cache per page; never resize the glass shape mid-spring.
3. **Render the Thinking page only when pushed**; derive its height from `levels.length` instead of an off-screen measure copy.
4. **Sequence the selection.** `pick()`: show the checkmark, start the close, write the store after the close animation (or in `requestAnimationFrame`/transition) so the re-render storm does not land on the closing frames. Same for `manage()`: close first, push on completion (or push immediately and let the in-tree overlay fade under the pushed screen).
5. **Narrow store subscriptions.** Move `threads`/`models`/`providers`/`settings` reads into the body component, mount it once on first open, and derive `short` through a selector with `useShallow`. Composer keystrokes then never touch the picker.
6. **Glass diet for the sheet.** Put the two toolbar buttons in one `GlassContainer`; drop `isInteractive` where there is no touch feedback; use `glassEffectStyle` animate for fades, never `opacity` on a glass ancestor.
7. Apply the same shell to `Sheet.tsx` (chat options) and `ThreadMenu.tsx`.

Option to evaluate after P1.1: native `formSheet` route for the picker. Wins: system gestures and glass for free. Costs: no custom duration, sliding Thinking/All-models pages need rework, route-level mount on push. Prototype only if P1.1 still misses the budget.

### P1: drawer

1. Do not flip React state at gesture start. Drive `pointerEvents` and accessibility from the shared value (animated props) or flip `isOpen` in the spring completion callback with `scheduleOnRN`.
2. `useMemo` the context value; split `progress` (stable) from `isOpen` so consumers that only need `progress` never re-render.
3. Build the three `Gesture.Pan()` once (`useMemo`) and toggle with `.enabled()`; keep the edge detector mounted.
4. Navigation from the drawer: push first, close the drawer once the push is under way (the card slides back behind the new screen), or delay `router.push` to the spring's end. Pair with `router.prefetch` on press-in if it proves useful.
5. `NavPanel`: virtualize `recents` (FlashList/LegendList) or window it, memoize rows by thread id, subscribe through a selector that returns only the fields rows need.

### P2: navigation and screens

1. Keep first render of heavy screens light (`settings.tsx`, `history.tsx`, `memory.tsx`, `artifacts.tsx`): render the visible section, defer the rest after interactions.
2. Evaluate `router.prefetch` on press-in for Settings/History; measure time-to-first-frame of the push.
3. Pick a Stack `animation` per screen on purpose (`default` for pushes; `fade` or `slide_from_bottom` for overlay-like screens) and test `disableSynchronousScreensUpdates` only if a regression shows up.
4. Chat list: confirm message rendering is virtualized or windowed for long threads, and that streaming updates only re-render the last message.

### P3: orb

The orb is the largest continuous cost. After P0.2, if it still shows in traces: collapse to one `Path` (single `d` string) or move to a Skia canvas (no per-frame Fabric commit). Whether the iOS flag covers react-native-svg props is unconfirmed; test.

---

## 4. Frame budget and rules to keep

- 120 Hz = 8.3 ms per frame (60 Hz = 16.6 ms). During any open/close/push animation, JS thread work must stay under that, ideally near zero.
- Anything that moves in response to a finger or a transition runs as a worklet on a shared value. No `setState` per frame, no `PanResponder` for tracked gestures.
- Animate only `transform`/`opacity`/color. Never `height`/`width`/`padding` in a transition.
- Open: show shell instantly (animation starts frame 1), mount content before, or after the animation, never during.
- Close: animation first, state/store changes after.
- Hidden UI is `pointerEvents="none"` + frozen, not unmounted, when it will be reopened often.
- One glass layer per region; group siblings; no opacity on glass ancestors.

---

## 5. Risks

- Static Reanimated flags change touch behaviour for animated transforms (`Tap`). Test every pressable. Reported regressions exist; keep the flag behind an A/B.
- Keeping the sheet mounted costs memory and a live subtree; guard against hidden re-renders (narrow subscriptions, `freezeOnBlur`-style gating).
- In-tree overlay loses native modal behaviour: system back gesture, accessibility focus trap, status bar handling. Replace `onRequestClose`/`BackHandler`, set `accessibilityViewIsModal`, and hide the screen behind from accessibility while open (the picker already hides pages this way).
- `formSheet` route changes duration control and page model; do not mix it in until P1.1 is measured.

---

## 6. How to measure (do this first)

Release build on a physical ProMotion iPhone: `npx expo run:ios --device --configuration Release`.

Scenarios, each 10 runs, record dropped frames / hitches:

1. Empty chat → tap model pill → picker visible.
2. Picker → tap a model row → picker gone.
3. Picker → backdrop tap / swipe down.
4. Picker → Thinking page → back.
5. Open drawer (button) and (edge swipe).
6. Drawer → Settings (push) and back.
7. Chat while a reply streams: open picker, open drawer.

Tools:

- Xcode Instruments: **Animation Hitches**, **Time Profiler**, **Core Animation**, **Metal System Trace** (glass cost).
- React DevTools Profiler (dev build, for render counts and what re-rendered during open).
- Hermes sampling profiler for JS-thread hot spots during the open window.
- Reanimated and RN perf monitor for UI vs JS FPS.

Success criteria to agree on before changing code: no hitch during any scenario on the target device, picker open to first visible frame under ~100 ms, close frees the JS thread within one frame of the animation start.

Reproduce the baseline first; change one item at a time; keep the numbers next to each item above.

---

## 7. Sources

- Reanimated performance: https://docs.swmansion.com/react-native-reanimated/docs/guides/performance/
- Reanimated feature flags: https://docs.swmansion.com/react-native-reanimated/docs/guides/feature-flags/
- Reanimated 3 → 4 migration: https://docs.swmansion.com/react-native-reanimated/docs/guides/migration-from-3.x/
- Animating SVG: https://docs.swmansion.com/react-native-reanimated/docs/guides/animating-svg/
- Reanimated issues: #8810 (animatedStyle vs animatedProps frame drop), #7984 (120 Hz needs the Info.plist key), #10121 (touch handling with synchronous updates)
- Expo Router (prefetch, Stack options, freezeOnBlur): https://docs.expo.dev/versions/latest/sdk/router/ , https://docs.expo.dev/versions/v55.0.0/sdk/router/stack
- React Navigation native stack (formSheet, detents): https://reactnavigation.org/docs/native-stack-navigator/
- Expo GlassEffect: https://docs.expo.dev/versions/latest/sdk/glass-effect/
- Apple GlassEffectContainer: https://developer.apple.com/documentation/swiftui/glasseffectcontainer
- Apple ProMotion: https://developer.apple.com/documentation/quartzcore/optimizing-iphone-and-ipad-apps-to-support-promotion-displays
- React Compiler in Expo: https://docs.expo.dev/guides/react-compiler/
- Zustand `useShallow`: https://zustand.docs.pmnd.rs/reference/hooks/use-shallow
- React Native performance overview: https://reactnative.dev/docs/performance
- Bottom sheet notes: https://www.shipnative.dev/blog/react-native-bottom-sheet
- Liquid Glass in RN: https://www.callstack.com/blog/how-to-use-liquid-glass-in-react-native
