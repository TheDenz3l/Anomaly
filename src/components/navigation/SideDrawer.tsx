import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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
  isOpen: boolean;
  /** 0 closed → 1 open, tracking the finger during a drag. Drives the menu glyph and panel stagger. */
  progress: SharedValue<number>;
};

const DrawerContext = createContext<DrawerApi>({
  open: () => {},
  close: () => {},
  isOpen: false,
  progress: makeMutable(0),
});

export const useDrawer = () => useContext(DrawerContext);

const SPRING = { damping: 30, stiffness: 300, mass: 0.9, overshootClamping: true };
const FLING = 450;

/**
 * Push-style side drawer: the panel sits behind the chat, and the chat slides right as a rounded card.
 * Open from the header button or a swipe from the left edge; close by tapping or swiping the card.
 */
export function SideDrawer({ panel, children }: { panel: ReactNode; children: ReactNode }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const W = Math.min(340, Math.round(width * 0.82));
  const progress = useSharedValue(0);
  const start = useSharedValue(0);
  const [isOpen, setIsOpen] = useState(false);

  const settle = (target: number) => {
    setIsOpen(target === 1);
    if (target === 1) Keyboard.dismiss();
  };

  const animateTo = (target: 0 | 1) => {
    progress.set(reduced ? target : withSpring(target, SPRING));
    settle(target);
  };

  const open = () => animateTo(1);
  const close = () => animateTo(0);

  useEffect(() => {
    if (!isOpen) return;
    if (Platform.OS === "web") {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          progress.set(withSpring(0, SPRING));
          setIsOpen(false);
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      progress.set(withSpring(0, SPRING));
      setIsOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [isOpen, progress]);

  /** Horizontal drag that tracks the finger, then springs open or shut on release. */
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

  const edgeGesture = drag(!isOpen, 0.35);
  const panelGesture = drag(isOpen, 0.65);
  const cardGesture = drag(isOpen, 0.65);

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
    <DrawerContext.Provider value={{ open, close, isOpen, progress }}>
      <View style={styles.root}>
        <Animated.View
          accessibilityElementsHidden={!isOpen}
          importantForAccessibility={isOpen ? "auto" : "no-hide-descendants"}
          style={[styles.panel, { width: W, pointerEvents: isOpen ? "auto" : "none" }, panelStyle]}
        >
          <GestureDetector gesture={panelGesture}>
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
          <GestureDetector gesture={cardGesture}>
            <Animated.View
              style={[StyleSheet.absoluteFill, styles.dim, { pointerEvents: isOpen ? "auto" : "none" }, dimStyle]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close menu"
                onPress={close}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          </GestureDetector>
          {!isOpen ? (
            <GestureDetector gesture={edgeGesture}>
              <View style={[styles.edge, { top: insets.top + 64 }]} />
            </GestureDetector>
          ) : null}
        </Animated.View>
      </View>
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
