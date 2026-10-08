import { BlurView } from "expo-blur";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Reanimated, {
  Easing as REasing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass } from "@/components/ui/Glass";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { colors } from "@/lib/theme";

/** Window-space frame of the control the menu opens from. */
export type MenuAnchor = { x: number; y: number; width: number; height: number };

/** One row of the menu. `on` adds a checkmark; `section` draws a divider above the row. */
export type MenuItem = {
  key: string;
  label: string;
  icon: IconName;
  onPress: () => void;
  on?: boolean;
  danger?: boolean;
  section?: boolean;
};

const native = Platform.OS !== "web";
const BLUR = 22;
const AnimatedBlur = Reanimated.createAnimatedComponent(BlurView);
const MENU_W = 250;
const ROW_H = 52;
const PAD_V = 6;
const SEP_H = 13;
const GAP = 10;
const EDGE = 12;
const DANGER = "#F0645D";

/**
 * A short action menu that grows out of the control it was opened from, over a dimmed, lightly
 * blurred backdrop: the same glass, rows and motion as the chat list's long-press menu. It opens
 * above the control when there's room (the composer sits at the bottom) and below otherwise.
 */
export function ActionMenu({
  anchor,
  items,
  onClose,
  label,
}: {
  anchor: MenuAnchor | null;
  items: MenuItem[];
  onClose: () => void;
  /** What the menu is, for VoiceOver. */
  label: string;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [fade] = useState(() => new Animated.Value(0));
  const [progress] = useState(() => new Animated.Value(0));
  // Blur strength animates on its own: fading the blur's parent makes it flicker.
  const blur = useSharedValue(0);
  const blurProps = useAnimatedProps(() => ({ intensity: blur.get() }));
  const [shown, setShown] = useState(anchor);
  const [measured, setMeasured] = useState<number | null>(null);
  /**
   * The picked action waits until the menu's modal is fully gone: iOS won't present the photo
   * library, camera or file picker over a modal that's still on screen (it fails silently).
   */
  const pending = useRef<(() => void) | null>(null);
  const flush = () => {
    const act = pending.current;
    pending.current = null;
    act?.();
  };
  if (anchor && anchor !== shown) {
    setShown(anchor);
    setMeasured(null);
  }

  useEffect(() => {
    if (anchor) {
      if (reduced) {
        fade.setValue(1);
        progress.setValue(1);
        blur.set(BLUR);
        return;
      }
      blur.set(withTiming(BLUR, { duration: 200, easing: REasing.out(REasing.cubic) }));
      Animated.parallel([
        Animated.timing(fade, {
          toValue: 1,
          duration: 160,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: native,
        }),
        Animated.spring(progress, {
          toValue: 1,
          damping: 24,
          stiffness: 360,
          mass: 0.7,
          overshootClamping: true,
          useNativeDriver: native,
        }),
      ]).start();
    } else {
      const out = { toValue: 0, duration: reduced ? 0 : 130, useNativeDriver: native };
      blur.set(withTiming(0, { duration: out.duration }));
      Animated.parallel([Animated.timing(fade, out), Animated.timing(progress, out)]).start(
        ({ finished }) => {
          if (!finished) return;
          setShown(null);
          // Android has no onDismiss, its modal is gone once hidden; on iOS this is only a
          // backstop in case onDismiss never comes (flush runs an action once at most).
          setTimeout(flush, Platform.OS === "ios" ? 700 : 0);
        }
      );
    }
  }, [anchor, reduced, fade, progress, blur]);

  if (!shown) return <Modal transparent visible={false} animationType="none" onDismiss={flush} />;
  const a = shown;
  const sections = items.filter((i, n) => i.section && n > 0).length;
  const menuH = measured ?? PAD_V * 2 + items.length * ROW_H + sections * SEP_H;
  const menuW = Math.min(MENU_W, width - EDGE * 2);
  const left = Math.max(EDGE, Math.min(a.x, width - menuW - EDGE));
  const above = a.y - GAP - menuH >= insets.top + EDGE;
  const top = above
    ? a.y - GAP - menuH
    : Math.min(a.y + a.height + GAP, height - insets.bottom - EDGE - menuH);
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] });

  // Closes first, then acts once the modal has gone (see pending).
  const run = (item: MenuItem) => {
    pending.current = item.onPress;
    onClose();
  };

  return (
    <Modal
      transparent
      visible
      animationType="none"
      onRequestClose={onClose}
      onDismiss={flush}
      statusBarTranslucent
    >
      <View style={StyleSheet.absoluteFill}>
        <AnimatedBlur animatedProps={blurProps} tint="dark" style={StyleSheet.absoluteFill} />
        <Animated.View style={[StyleSheet.absoluteFill, styles.dim, { opacity: fade }]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close ${label}`}
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
      </View>
      <Animated.View
        accessibilityRole="menu"
        accessibilityLabel={label}
        onLayout={(e) => setMeasured(e.nativeEvent.layout.height)}
        style={[
          styles.menu,
          {
            left,
            top,
            width: menuW,
            opacity: fade,
            transformOrigin: above ? "bottom left" : "top left",
            transform: [{ scale: reduced ? 1 : scale }],
          },
        ]}
      >
        <Glass radius={26} tint="rgba(36,36,40,0.84)" style={{ paddingVertical: PAD_V }}>
          {items.map((item, n) => (
            <Fragment key={item.key}>
              {item.section && n > 0 ? <View style={styles.separator} /> : null}
              <Tap
                haptic
                accessibilityRole="menuitem"
                accessibilityState={item.on !== undefined ? { checked: item.on } : undefined}
                onPress={() => run(item)}
                style={styles.item}
              >
                <Icon name={item.icon} size={21} color={item.danger ? DANGER : colors.text} />
                <Text
                  className="flex-1 text-[17px] leading-6"
                  style={{ color: item.danger ? DANGER : colors.text }}
                >
                  {item.label}
                </Text>
                {item.on ? <Icon name="checkmark" size={19} color={colors.text} /> : null}
              </Tap>
            </Fragment>
          ))}
        </Glass>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { backgroundColor: "rgba(0,0,0,0.36)" },
  menu: {
    position: "absolute",
    borderRadius: 26,
    boxShadow: "0 18px 44px rgba(0,0,0,0.55)",
  },
  item: {
    height: ROW_H,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 20,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 6,
    marginHorizontal: 20,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
});
