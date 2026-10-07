import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  KeyboardAwareScrollView,
  useReanimatedKeyboardAnimation,
  type KeyboardAwareScrollViewRef,
} from "react-native-keyboard-controller";
import Reanimated, {
  FadeIn,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  withDelay,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { colors, LIST_RADIUS } from "@/lib/theme";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { Portal, useCover, useFocusHandoff } from "./Portal";
import { Tap } from "./Tap";
import { Text } from "./Text";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { sheetMotion } from "@/lib/motion";
export type SheetAction = {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
};

type Props = {
  open: boolean;
  /** Backdrop tap, a swipe down on the toolbar, or the system back gesture. */
  onClose: () => void;
  /** Runs once the sheet has finished sliding away. */
  onHidden?: () => void;
  title: string;
  /** Left toolbar button. Defaults to Close. */
  leading?: SheetAction;
  /** Right toolbar button: the sheet's one prominent action. */
  confirm?: SheetAction;
  /** Runs once the sheet has finished sliding in; focus fields here. */
  onShown?: () => void;
  /** Changing it scrolls the body back to the top, e.g. between steps. */
  page?: string;
  /** A fixed body that ends at the keyboard instead of scrolling, for text editors. */
  fill?: boolean;
  /**
   * A content-height sheet floating just above the bottom edge on glass (the iOS 26 partial
   * sheet). It grows with its content up to the full height, then scrolls.
   */
  fit?: boolean;
  /** Children lay out the body themselves (no scroll view), e.g. a sheet with sliding pages. */
  bare?: boolean;
  /**
   * Built while the app is idle and kept while closed, so opening it mounts nothing. For sheets
   * opened often; their children must not rely on remounting to reset.
   */
  keepMounted?: boolean;
  /**
   * Whether closing hands the keyboard back to the field that had it when the sheet opened.
   * False when the sheet closes to open another screen.
   */
  restoreFocus?: boolean;
  /**
   * How much of the sheet shows at rest, from its top edge to the bottom of the screen; the rest
   * waits below the edge. Dragging anywhere on the sheet moves it. Omit to show it whole, with
   * only the toolbar draggable.
   */
  detent?: number;
  /** With `detent`, pulling the sheet up shows `expandTo` of it (all of it when omitted). */
  expandable?: boolean;
  expandTo?: number;
  children: ReactNode;
};

/** Full-height sheets are opaque, as on iOS 26; glass stays on the controls floating over them. */
export const SHEET_BG = "#141417";
export const GROUP_BG = "#222226";

const { open: OPEN, close: CLOSE, settle: SETTLE } = sheetMotion;
/** Hidden this far past its own edge, so the shadow and glass rim leave the screen too. */
const MARGIN = 24;

function ToolbarButton({ action, prominent }: { action: SheetAction; prominent?: boolean }) {
  const off = Boolean(action.disabled || action.busy);
  return (
    <Tap
      haptic={prominent}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: off, busy: Boolean(action.busy) }}
      disabled={off}
      hitSlop={8}
      onPress={action.onPress}
    >
      <Glass
        radius={22}
        interactive
        tint={prominent && !action.disabled ? colors.primary : undefined}
      >
        <View style={styles.button}>
          {action.busy ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Reanimated.View key={action.icon} entering={FadeIn.duration(200)}>
              <Icon
                name={action.icon}
                size={20}
                color={action.disabled ? colors.textFaint : colors.text}
              />
            </Reanimated.View>
          )}
        </View>
      </Glass>
    </Tap>
  );
}

/** Gap between a floating sheet and the screen edges. */
const FLOAT = 8;
/** Toolbar height; a bare body gets what's left of the sheet. */
export const TOOLBAR_H = 64;

/** Inner width and the most body height a floating (`fit`) sheet has on this screen. */
export function floatingSheetBox(screen: { width: number; height: number }, insetTop: number) {
  return {
    width: Math.min(screen.width - FLOAT * 2, 560),
    maxBody: screen.height - insetTop - 10 - FLOAT * 2 - TOOLBAR_H,
  };
}

/** A floating sheet sits on Liquid Glass; a full-height one is opaque. */
function Wrap({
  fit,
  maxHeight,
  children,
}: {
  fit?: boolean;
  maxHeight: number;
  children: ReactNode;
}) {
  if (!fit) return <>{children}</>;
  return (
    <Glass radius={38} tint="rgba(24,24,27,0.55)" style={{ maxHeight, flexShrink: 1 }}>
      {children}
    </Glass>
  );
}

/** Editor body: fills the sheet and stops at the top of the keyboard, frame by frame. */
function FillBody({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const keyboard = useReanimatedKeyboardAnimation();
  const bottom = insets.bottom;
  const pad = useAnimatedStyle(
    () => ({ paddingBottom: Math.max(bottom + 8, -keyboard.height.value + 8) }),
    [bottom]
  );
  return <Reanimated.View style={[styles.fill, pad]}>{children}</Reanimated.View>;
}

/**
 * Full-height form sheet in the iOS 26 pattern: a toolbar with Close on the left and the one
 * prominent confirm action on the right, so the keyboard never covers what finishes the task.
 * The body scrolls the focused field above the keyboard; swiping the toolbar down dismisses.
 *
 * It renders above every screen through the PortalHost rather than in a Modal, and all of its
 * motion (slide, backdrop, drag) runs on the UI thread.
 */
export function FormSheet(props: Props) {
  return (
    <Portal>
      <SheetLayer {...props} />
    </Portal>
  );
}

type Phase = "hidden" | "waiting" | "open" | "closing";

function SheetLayer({
  open,
  onClose,
  onHidden,
  title,
  leading,
  confirm,
  onShown,
  page,
  fill,
  fit,
  bare,
  keepMounted,
  restoreFocus = true,
  detent,
  expandable = false,
  expandTo,
  children,
}: Props) {
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  // Field positions measured mid slide-in are off by the slide, so keyboard-aware scrolling
  // waits for the sheet to land.
  const [landed, setLanded] = useState(false);
  if (!open && landed) setLanded(false);
  const body = useRef<KeyboardAwareScrollViewRef>(null);
  const latest = useRef({ onShown, onHidden });
  useEffect(() => {
    latest.current = { onShown, onHidden };
  });
  const handoff = useFocusHandoff();
  const [sheetH, setSheetH] = useState(0);
  // Pulled up whole past its detent. A new detent (another page) starts lowered again.
  const [expanded, setExpanded] = useState(false);
  const [shownDetent, setShownDetent] = useState(detent);
  if (detent !== shownDetent) {
    setShownDetent(detent);
    setExpanded(false);
  }
  const edge = fit ? FLOAT : 0;
  /** How far below its full height a sheet `h` tall rests to show `visible` of itself. */
  const lowerBy = (h: number, visible?: number) =>
    visible === undefined ? 0 : Math.max(0, h + edge - visible);
  const lowered = lowerBy(sheetH, detent);
  const raised = detent === undefined ? 0 : lowerBy(sheetH, expandTo);
  const rest = expanded ? raised : lowered;
  // What lies under the sheet (the empty chat's orb) tucks itself below its top edge.
  useCover(open, fit ? (sheetH > 0 ? height - edge - sheetH + rest : null) : insets.top + 10);

  const phase = useRef<Phase>("hidden");
  /** How far down the sheet hides: its own height once measured, so it slides in from the edge. */
  const travel = useRef<number | null>(null);
  const y = useSharedValue(height);
  const reach = useSharedValue(height);
  const dragStart = useSharedValue(0);
  /** For the drag: where the sheet rests lowered and pulled up, and whether it pulls up. */
  const low = useSharedValue(0);
  const high = useSharedValue(0);
  const canExpand = useSharedValue(false);
  /** The resting place the sheet is heading to, so a re-render doesn't restart a move. */
  const aim = useSharedValue(0);

  const settled = () => {
    phase.current = "hidden";
    setExpanded(false);
    if (!keepMounted) {
      // Its next content may be taller, so it waits below the whole screen until measured.
      travel.current = null;
      y.set(height);
      setMounted(false);
    }
    latest.current.onHidden?.();
  };

  const land = () => {
    setLanded(true);
    latest.current.onShown?.();
  };
  /** Moves the open sheet to a resting place. */
  const goTo = (target: number) => {
    phase.current = "open";
    aim.set(target);
    const done = (finished?: boolean) => {
      "worklet";
      if (finished) scheduleOnRN(land);
    };
    y.set(reduced ? withTiming(target, { duration: 0 }, done) : withSpring(target, OPEN, done));
  };

  const measure = (h: number) => {
    setSheetH(h);
    const t = h + edge + MARGIN;
    travel.current = t;
    reach.set(t);
    if (phase.current === "hidden") y.set(t);
    if (phase.current === "waiting") {
      y.set(t);
      goTo(expanded && detent !== undefined ? lowerBy(h, expandTo) : lowerBy(h, detent));
    }
  };

  useEffect(() => {
    if (!mounted) return;
    if (open) {
      handoff.take();
      // A sheet not measured yet waits one layout pass, then starts at the screen's edge
      // instead of travelling unseen from the top.
      if (travel.current === null && !reduced) phase.current = "waiting";
      else goTo(rest);
      return;
    }
    if (phase.current === "hidden") return;
    handoff.giveBack(restoreFocus);
    phase.current = "closing";
    y.set(
      withTiming(travel.current ?? height, reduced ? { duration: 0 } : CLOSE, (finished) => {
        if (finished) scheduleOnRN(settled);
      })
    );
    // goTo/settled only read refs and stable setters; re-running on their identity would
    // restart the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted, reduced]);

  // A new detent (another page) or a new height moves the open sheet to its new resting place.
  useEffect(() => {
    low.set(lowered);
    high.set(raised);
    canExpand.set(expandable && raised < lowered);
    if (phase.current === "open" && aim.get() !== rest) goTo(rest);
    // goTo only reads refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowered, raised, rest, expandable]);

  // Frequent sheets are built while the app is idle, so even the first open mounts nothing.
  useEffect(() => {
    if (!keepMounted || mounted) return;
    const id = requestIdleCallback(() => setMounted(true), { timeout: 3000 });
    return () => cancelIdleCallback(id);
  }, [keepMounted, mounted]);

  useEffect(() => {
    if (!open) return;
    if (Platform.OS === "web") {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  useEffect(() => {
    if (landed) body.current?.assureFocusedInputVisible();
  }, [landed]);

  useEffect(() => {
    body.current?.scrollTo({ y: 0, animated: false });
  }, [page]);

  const drag = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .failOffsetX([-12, 12])
    .onBegin(() => {
      dragStart.set(y.get());
    })
    .onUpdate((e) => {
      // Above its highest resting place the sheet gives a little, like a rubber band.
      const top = canExpand.get() ? high.get() : low.get();
      const raw = dragStart.get() + e.translationY;
      y.set(raw < top ? top - (top - raw) * 0.2 : raw);
    })
    .onEnd((e) => {
      const at = y.get();
      const floor = low.get();
      if (at > floor + 120 || (e.velocityY > 1000 && at >= floor - 8)) {
        // Asks to close and holds; the close animation replaces the delayed settle. A sheet that
        // refuses (unsaved changes) springs back once the delay runs out.
        aim.set(floor);
        y.set(withDelay(150, withSpring(floor, SETTLE)));
        scheduleOnRN(onClose);
      } else if (
        canExpand.get() &&
        e.velocityY < 500 &&
        (e.velocityY < -500 || at < (floor + high.get()) / 2)
      ) {
        aim.set(high.get());
        y.set(withSpring(high.get(), SETTLE));
        scheduleOnRN(setExpanded, true);
      } else {
        aim.set(floor);
        y.set(withSpring(floor, SETTLE));
        scheduleOnRN(setExpanded, false);
      }
    });
  // Without a detent only the toolbar drags, so a form's own scrolling keeps the body.
  if (detent === undefined) drag.hitSlop({ top: 0, height: TOOLBAR_H });

  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));
  const dim = useAnimatedStyle(() => ({
    opacity: interpolate(y.get(), [low.get(), reach.get()], [1, 0], "clamp"),
  }));

  if (!mounted) return null;

  const top = insets.top + 10;
  const maxHeight = height - top - FLOAT;

  return (
    <View
      accessibilityViewIsModal={open}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      // Closing hands touches back at once; the slide-out never blocks the screen under it.
      style={[StyleSheet.absoluteFill, { pointerEvents: open ? "auto" : "none" }]}
    >
      <Reanimated.View style={[StyleSheet.absoluteFill, styles.backdrop, dim]}>
        <Pressable accessibilityLabel="Close" style={{ flex: 1 }} onPress={onClose} />
      </Reanimated.View>
      <GestureDetector gesture={drag}>
        <Reanimated.View
          onLayout={(e) => measure(e.nativeEvent.layout.height)}
          style={[
            fit ? styles.floating : styles.sheet,
            fit
              ? { maxHeight, width: Math.min(width - FLOAT * 2, 560) }
              : { top, width: Math.min(width, 560) },
            slide,
          ]}
        >
          <Wrap fit={fit} maxHeight={maxHeight}>
            <View style={styles.toolbar}>
              {fit ? (
                <View pointerEvents="none" style={styles.grabberWrap}>
                  <View style={styles.grabber} />
                </View>
              ) : null}
              <ToolbarButton
                action={leading ?? { label: "Close", icon: "close", onPress: onClose }}
              />
              <View pointerEvents="none" style={styles.titleWrap}>
                <Reanimated.View key={title} entering={FadeIn.duration(240)}>
                  <Text
                    weight="bold"
                    accessibilityRole="header"
                    numberOfLines={1}
                    style={styles.title}
                  >
                    {title}
                  </Text>
                </Reanimated.View>
              </View>
              {confirm ? (
                <ToolbarButton action={confirm} prominent />
              ) : (
                <View style={styles.button} />
              )}
            </View>
            {bare ? (
              children
            ) : fill ? (
              <FillBody>{children}</FillBody>
            ) : (
              <View style={[styles.clip, fit ? styles.clipFit : styles.clipFull]}>
                <KeyboardAwareScrollView
                  ref={body}
                  enabled={landed}
                  bottomOffset={28}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="interactive"
                  style={fit ? { flexGrow: 0, flexShrink: 1 } : undefined}
                  contentContainerStyle={{
                    paddingTop: 6,
                    paddingBottom: fit ? 8 : insets.bottom + 28,
                  }}
                >
                  {children}
                </KeyboardAwareScrollView>
              </View>
            )}
          </Wrap>
        </Reanimated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    position: "absolute",
    bottom: 0,
    alignSelf: "center",
    backgroundColor: SHEET_BG,
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.10)",
    overflow: "hidden",
  },
  floating: {
    position: "absolute",
    bottom: FLOAT,
    alignSelf: "center",
    borderRadius: 38,
  },
  toolbar: {
    height: TOOLBAR_H,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  button: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  /** A floating sheet's drag handle, over the toolbar that the swipe-down follows. */
  grabberWrap: { position: "absolute", top: 6, left: 0, right: 0, alignItems: "center" },
  grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.28)" },
  titleWrap: {
    position: "absolute",
    left: 72,
    right: 72,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 17, color: colors.text },
  fill: { flex: 1, paddingHorizontal: 16 },
  /** The scroll area is a rounded window, so lists scrolled under the toolbar stay rounded. */
  clip: { marginHorizontal: 16, borderRadius: LIST_RADIUS, overflow: "hidden" },
  clipFit: { flexShrink: 1, marginBottom: 12 },
  clipFull: { flex: 1 },
});
