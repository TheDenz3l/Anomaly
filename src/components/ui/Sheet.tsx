import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sheetMotion } from "@/lib/motion";
import { colors, LIST_RADIUS } from "@/lib/theme";
import { Glass } from "./Glass";
import { Icon } from "./Icon";
import { Portal, useCover } from "./Portal";
import { Tap } from "./Tap";
import { Text } from "./Text";
import Reanimated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useEffect, useRef, useState, ReactNode } from "react";
import {
  KeyboardAwareScrollView,
  useReanimatedKeyboardAnimation,
  KeyboardAwareScrollViewRef,
} from "react-native-keyboard-controller";

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
};

/** Hidden this far past its own edge, so the glass rim leaves the screen too. */
const MARGIN = 24;

/**
 * Bottom sheet on glass. Slides up; respects reduced motion.
 *
 * With the keyboard up the sheet keeps its size (no relayout when the keyboard comes or goes) and
 * moves with the keyboard frame by frame: it rises as far as the room above it allows, the footer
 * rides on top of the keyboard, and the body scrolls the focused field into the space between.
 *
 * Renders above every screen through the PortalHost rather than in a Modal; its motion runs on the
 * UI thread.
 */
export function Sheet(props: Props) {
  return (
    <Portal>
      <SheetLayer {...props} />
    </Portal>
  );
}

function SheetLayer({ open, onClose, title, subtitle, children, footer, scroll = true }: Props) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const keyboard = useReanimatedKeyboardAnimation();
  const [sheetH, setSheetH] = useState(0);
  const [footerH, setFooterH] = useState(0);
  const body = useRef<KeyboardAwareScrollViewRef>(null);
  // Field positions measured mid slide-in are off by the slide, so keyboard-aware scrolling waits
  // for the sheet to land (an autofocused field would otherwise scroll itself out of view).
  const [landed, setLanded] = useState(false);
  if (!open && landed) setLanded(false);
  useCover(open);

  /** How far down the sheet hides once measured; until then it waits below the whole screen. */
  const travel = useRef<number | null>(null);
  const waiting = useRef(false);
  const y = useSharedValue(height);
  const reach = useSharedValue(height);

  // How far the whole sheet can rise before its top would reach the status bar.
  const room = Math.max(0, height - insets.top - 8 - sheetH);
  const homeIndicator = insets.bottom;
  // A sheet with room for the whole keyboard above it simply rides on the keyboard; only taller
  // sheets need the body to scroll the focused field into view.
  const short = room >= height * 0.42;

  const sheetLift = useAnimatedStyle(() => {
    // The home-indicator padding slides under the keyboard rather than floating above it.
    const k = Math.max(0, -keyboard.height.value - homeIndicator * keyboard.progress.value);
    return { transform: [{ translateY: -Math.min(k, room) }] };
  }, [room, homeIndicator]);
  const footerLift = useAnimatedStyle(() => {
    const k = Math.max(0, -keyboard.height.value - homeIndicator * keyboard.progress.value);
    const covered = Math.max(0, k - room);
    return {
      transform: [{ translateY: -covered }],
      backgroundColor: `rgba(20,20,23,${interpolate(covered, [0, 12], [0, 1], "clamp")})`,
    };
  }, [room, homeIndicator]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));
  const dim = useAnimatedStyle(() => ({
    opacity: interpolate(y.get(), [0, reach.get()], [1, 0], "clamp"),
  }));

  const slideIn = () => {
    const land = () => setLanded(true);
    const done = (finished?: boolean) => {
      "worklet";
      if (finished) scheduleOnRN(land);
    };
    y.set(reduced ? withTiming(0, { duration: 0 }, done) : withSpring(0, sheetMotion.open, done));
  };

  const hidden = () => {
    travel.current = null;
    y.set(height);
    setMounted(false);
  };

  useEffect(() => {
    if (!mounted) return;
    if (open) {
      // Wait one layout pass so the slide starts at the screen's edge, not far below it.
      if (travel.current === null && !reduced) waiting.current = true;
      else slideIn();
      return;
    }
    waiting.current = false;
    Keyboard.dismiss();
    y.set(
      withTiming(
        travel.current ?? height,
        reduced ? { duration: 0 } : sheetMotion.close,
        (finished) => {
          if (finished) scheduleOnRN(hidden);
        }
      )
    );
    // slideIn/hidden only touch refs, shared values and setters; re-running on their identity
    // would restart the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted, reduced]);

  useEffect(() => {
    if (landed) body.current?.assureFocusedInputVisible();
  }, [landed]);

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

  if (!mounted) return null;

  const maxHeight = height * 0.88;

  return (
    <View
      accessibilityViewIsModal={open}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      // Closing hands touches back at once; the slide-out never blocks the screen under it.
      style={[StyleSheet.absoluteFill, { pointerEvents: open ? "auto" : "none" }]}
    >
      <Reanimated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.55)" }, dim]}
      >
        <Pressable accessibilityLabel="Close" style={{ flex: 1 }} onPress={onClose} />
      </Reanimated.View>
      <Reanimated.View
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          setSheetH(h);
          travel.current = h + MARGIN;
          reach.set(h + MARGIN);
          if (!waiting.current) return;
          waiting.current = false;
          y.set(h + MARGIN);
          slideIn();
        }}
        style={[
          {
            position: "absolute",
            bottom: 0,
            alignSelf: "center",
            width: Math.min(width, 560),
            maxHeight,
          },
          slide,
        ]}
      >
        <Reanimated.View style={[{ maxHeight, flexShrink: 1 }, sheetLift]}>
          <Glass
            radius={30}
            style={{
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              backgroundColor: "rgba(20,20,23,0.92)",
              // Header and footer keep their size; only the body shrinks and scrolls.
              maxHeight,
              flexShrink: 1,
            }}
          >
            {/* Tapping the sheet's header puts the keyboard away, as in iOS forms. */}
            <Pressable accessible={false} onPress={Keyboard.dismiss}>
              <View className="items-center pt-2.5 pb-1">
                <View className="h-1 w-9 rounded-full bg-raised" />
              </View>
              {title ? (
                <View className="flex-row items-start px-5 pt-2 pb-3">
                  <View className="flex-1 pr-3">
                    <Text weight="bold" className="text-lg">
                      {title}
                    </Text>
                    {subtitle ? (
                      <Text muted className="mt-0.5 text-sm leading-5">
                        {subtitle}
                      </Text>
                    ) : null}
                  </View>
                  <Tap
                    accessibilityLabel="Close"
                    onPress={onClose}
                    hitSlop={10}
                    className="h-8 w-8 items-center justify-center rounded-full bg-raised"
                  >
                    <Icon name="close" size={18} color={colors.textMuted} />
                  </Tap>
                </View>
              ) : null}
            </Pressable>
            {scroll ? (
              // A rounded window, so lists scrolled under the header keep their corners.
              <View
                style={{
                  flexShrink: 1,
                  marginHorizontal: 20,
                  marginBottom: footer ? 0 : insets.bottom + 8,
                  borderRadius: LIST_RADIUS,
                  overflow: "hidden",
                }}
              >
                <KeyboardAwareScrollView
                  style={{ flexGrow: 0, flexShrink: 1 }}
                  contentContainerStyle={{ paddingBottom: 12 }}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="interactive"
                  ref={body}
                  enabled={landed && !short}
                  // Clear the footer riding on the keyboard; the sheet's own rise already counts.
                  bottomOffset={(footer ? footerH : 0) + 40 - room}
                >
                  {children}
                </KeyboardAwareScrollView>
              </View>
            ) : (
              children
            )}
            {footer ? (
              <Reanimated.View
                onLayout={(e) => setFooterH(e.nativeEvent.layout.height)}
                style={[
                  { paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 16 },
                  footerLift,
                ]}
              >
                {footer}
              </Reanimated.View>
            ) : null}
          </Glass>
        </Reanimated.View>
      </Reanimated.View>
    </View>
  );
}
