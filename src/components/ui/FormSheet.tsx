import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
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
import { Portal, useCover } from "./Portal";
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
  useCover(open);

  const phase = useRef<Phase>("hidden");
  /** How far down the sheet hides: its own height once measured, so it slides in from the edge. */
  const travel = useRef<number | null>(null);
  const y = useSharedValue(height);
  const reach = useSharedValue(height);
  const dragStart = useSharedValue(0);

  const settled = () => {
    phase.current = "hidden";
    if (!keepMounted) {
      // Its next content may be taller, so it waits below the whole screen until measured.
      travel.current = null;
      y.set(height);
      setMounted(false);
    }
    latest.current.onHidden?.();
  };

  const slideIn = () => {
    phase.current = "open";
    const land = () => {
      setLanded(true);
      latest.current.onShown?.();
    };
    const done = (finished?: boolean) => {
      "worklet";
      if (finished) scheduleOnRN(land);
    };
    y.set(reduced ? withTiming(0, { duration: 0 }, done) : withSpring(0, OPEN, done));
  };

  const measure = (h: number) => {
    const t = h + (fit ? FLOAT : 0) + MARGIN;
    travel.current = t;
    reach.set(t);
    if (phase.current === "hidden") y.set(t);
    if (phase.current === "waiting") {
      y.set(t);
      slideIn();
    }
  };

  useEffect(() => {
    if (!mounted) return;
    if (open) {
      // A sheet not measured yet waits one layout pass, then starts at the screen's edge
      // instead of travelling unseen from the top.
      if (travel.current === null && !reduced) phase.current = "waiting";
      else slideIn();
      return;
    }
    if (phase.current === "hidden") return;
    Keyboard.dismiss();
    phase.current = "closing";
    y.set(
      withTiming(travel.current ?? height, reduced ? { duration: 0 } : CLOSE, (finished) => {
        if (finished) scheduleOnRN(settled);
      })
    );
    // slideIn/settled only read refs and stable setters; re-running on their identity would
    // restart the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted, reduced]);

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
    .activeOffsetY(8)
    .failOffsetX([-12, 12])
    .onBegin(() => {
      dragStart.set(y.get());
    })
    .onUpdate((e) => {
      y.set(Math.max(0, dragStart.get() + e.translationY));
    })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 1000) {
        // Asks to close and holds; the close animation replaces the delayed settle. A sheet that
        // refuses (unsaved changes) springs back once the delay runs out.
        y.set(withDelay(150, withSpring(0, SETTLE)));
        scheduleOnRN(onClose);
      } else y.set(withSpring(0, SETTLE));
    });

  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));
  const dim = useAnimatedStyle(() => ({
    opacity: interpolate(y.get(), [0, reach.get()], [1, 0], "clamp"),
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
          <GestureDetector gesture={drag}>
            <View style={styles.toolbar}>
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
          </GestureDetector>
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
