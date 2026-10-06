import { useNavigation } from "expo-router";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  makeMutable,
  type SharedValue,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { colors } from "@/lib/theme";

type DrawerApi = {
  open: () => void;
  close: () => void;
  /** 0 closed → 1 open, tracking the finger during a drag. Drives the menu glyph and panel stagger. */
  progress: SharedValue<number>;
};

const DrawerContext = createContext<DrawerApi>({
  open: () => {},
  close: () => {},
  progress: makeMutable(0),
});
const DrawerOpenContext = createContext(false);

/** Stable for the drawer's lifetime: reading it never re-renders on open or close. */
export const useDrawer = () => useContext(DrawerContext);
/** Whether the drawer is open. Re-renders on every toggle; animate from `progress` instead. */
export const useDrawerOpen = () => useContext(DrawerOpenContext);

const SPRING = { damping: 30, stiffness: 300, mass: 0.9, overshootClamping: true };
const FLING = 450;

type TransitionEvents = {
  addListener: (
    type: "transitionEnd",
    listener: (e: { data?: { closing?: boolean } }) => void
  ) => () => void;
};

/**
 * Push-style side drawer: the panel sits behind the chat, and the chat slides right as a rounded card.
 * Open from the header button or a swipe from the left edge; close by tapping or swiping the card.
 */
export function SideDrawer({ panel, children }: { panel: ReactNode; children: ReactNode }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const navigation = useNavigation() as unknown as TransitionEvents;
  const W = Math.min(340, Math.round(width * 0.82));
  const progress = useSharedValue(0);
  const start = useSharedValue(0);
  const [isOpen, setIsOpen] = useState(false);

  const api = useMemo<DrawerApi>(() => {
    const animateTo = (target: 0 | 1) => {
      progress.set(reduced ? target : withSpring(target, SPRING));
      setIsOpen(target === 1);
      if (target === 1) Keyboard.dismiss();
    };
    return { open: () => animateTo(1), close: () => animateTo(0), progress };
  }, [progress, reduced]);

  useEffect(() => {
    if (!isOpen) return;
    if (Platform.OS === "web") {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") api.close();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      api.close();
      return true;
    });
    return () => sub.remove();
  }, [isOpen, api]);

  // A screen opened from the drawer slides over it. Once that screen covers the chat, the drawer
  // shuts out of sight, so going back lands on the conversation without a second animation.
  useEffect(() => {
    if (!isOpen) return;
    return navigation.addListener("transitionEnd", (e) => {
      if (!e.data?.closing) return;
      progress.set(0);
      setIsOpen(false);
    });
  }, [isOpen, navigation, progress]);

  /** Horizontal drags that track the finger, then spring open or shut on release. */
  const gestures = useMemo(() => {
    // The spring already runs on the UI thread; JS only records where it is heading.
    const settle = (target: number) => {
      setIsOpen(target === 1);
      if (target === 1) Keyboard.dismiss();
    };
    const drag = (enabled: boolean, openBias: number) =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetX([-10, 10])
        .failOffsetY([-14, 14])
        .onBegin(() => {
          start.set(progress.get());
        })
        .onUpdate((e) => {
          progress.set(Math.min(1, Math.max(0, start.get() + e.translationX / W)));
        })
        .onEnd((e) => {
          const target =
            e.velocityX > FLING ? 1 : e.velocityX < -FLING ? 0 : progress.get() > openBias ? 1 : 0;
          progress.set(reduced ? target : withSpring(target, SPRING));
          scheduleOnRN(settle, target);
        });
    return { edge: drag(!isOpen, 0.35), panel: drag(isOpen, 0.65), card: drag(isOpen, 0.65) };
  }, [isOpen, W, reduced, progress, start]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.get() * W }],
    borderRadius: progress.get() * 34,
    borderColor: `rgba(255, 255, 255, ${0.12 * progress.get()})`,
  }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: progress.get() * 0.5 }));
  const panelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 1], [0.4, 1]),
    transform: [{ translateX: interpolate(progress.get(), [0, 1], [-W * 0.16, 0]) }],
  }));

  return (
    <DrawerContext.Provider value={api}>
      <DrawerOpenContext.Provider value={isOpen}>
        <View style={styles.root}>
          <Animated.View
            accessibilityElementsHidden={!isOpen}
            importantForAccessibility={isOpen ? "auto" : "no-hide-descendants"}
            style={[
              styles.panel,
              { width: W, pointerEvents: isOpen ? "auto" : "none" },
              panelStyle,
            ]}
          >
            <GestureDetector gesture={gestures.panel}>
              <View style={{ flex: 1 }}>{panel}</View>
            </GestureDetector>
          </Animated.View>

          <Animated.View style={[styles.card, cardStyle]}>
            <View
              style={{ flex: 1 }}
              accessibilityElementsHidden={isOpen}
              importantForAccessibility={isOpen ? "no-hide-descendants" : "auto"}
            >
              {children}
            </View>
            <GestureDetector gesture={gestures.card}>
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  styles.dim,
                  { pointerEvents: isOpen ? "auto" : "none" },
                  dimStyle,
                ]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close menu"
                  onPress={api.close}
                  style={StyleSheet.absoluteFill}
                />
              </Animated.View>
            </GestureDetector>
            <GestureDetector gesture={gestures.edge}>
              <View
                style={[
                  styles.edge,
                  { top: insets.top + 64, pointerEvents: isOpen ? "none" : "auto" },
                ]}
              />
            </GestureDetector>
          </Animated.View>
        </View>
      </DrawerOpenContext.Provider>
    </DrawerContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.drawer, overflow: "hidden" },
  panel: { position: "absolute", top: 0, bottom: 0, left: 0 },
  card: {
    flex: 1,
    overflow: "hidden",
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dim: { backgroundColor: "#000" },
  edge: { position: "absolute", left: 0, bottom: 0, width: 14 },
});
