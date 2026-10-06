import {
  ActivityIndicator,
  Animated,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import {
  KeyboardAwareScrollView,
  useReanimatedKeyboardAnimation,
  type KeyboardAwareScrollViewRef,
} from "react-native-keyboard-controller";
import Reanimated, { useAnimatedStyle, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "@/lib/theme";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { Tap } from "./Tap";
import { Text } from "./Text";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  children: ReactNode;
};

const native = Platform.OS !== "web";
/** Full-height sheets are opaque, as on iOS 26; glass stays on the controls floating over them. */
export const SHEET_BG = "#141417";
export const GROUP_BG = "#222226";

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
            <Icon
              name={action.icon}
              size={20}
              color={action.disabled ? colors.textFaint : colors.text}
            />
          )}
        </View>
      </Glass>
    </Tap>
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
 */
export function FormSheet({
  open,
  onClose,
  title,
  leading,
  confirm,
  onShown,
  page,
  fill,
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
  const [progress] = useState(() => new Animated.Value(0));
  const [drag] = useState(() => new Animated.Value(0));
  const body = useRef<KeyboardAwareScrollViewRef>(null);
  const shown = useRef(onShown);
  useEffect(() => {
    shown.current = onShown;
  });

  // Rebuilt only when onClose changes, which doesn't happen mid-drag (drags don't re-render).
  const pan = useMemo(() => {
    const settle = () =>
      Animated.spring(drag, {
        toValue: 0,
        damping: 24,
        stiffness: 300,
        useNativeDriver: native,
      }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_, g) => {
        if (g.dy > 120 || g.vy > 1) onClose();
        settle();
      },
      onPanResponderTerminate: settle,
    });
  }, [drag, onClose]);

  useEffect(() => {
    if (open) {
      drag.setValue(0);
      const done = ({ finished }: { finished: boolean }) => {
        if (!finished) return;
        setLanded(true);
        shown.current?.();
      };
      if (reduced)
        Animated.timing(progress, { toValue: 1, duration: 0, useNativeDriver: native }).start(done);
      else
        Animated.spring(progress, {
          toValue: 1,
          damping: 28,
          stiffness: 260,
          mass: 0.9,
          overshootClamping: true,
          useNativeDriver: native,
        }).start(done);
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: reduced ? 0 : 220,
        useNativeDriver: native,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [open, reduced, progress, drag]);

  useEffect(() => {
    if (landed) body.current?.assureFocusedInputVisible();
  }, [landed]);

  useEffect(() => {
    body.current?.scrollTo({ y: 0, animated: false });
  }, [page]);

  if (!mounted) return null;

  const top = insets.top + 10;
  const translateY = Animated.add(
    progress.interpolate({ inputRange: [0, 1], outputRange: [height - top, 0] }),
    drag
  );

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: progress }]}>
        <Pressable accessibilityLabel="Close" style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[styles.sheet, { top, width: Math.min(width, 560), transform: [{ translateY }] }]}
      >
        <View {...pan.panHandlers} style={styles.toolbar}>
          <ToolbarButton action={leading ?? { label: "Close", icon: "close", onPress: onClose }} />
          <View pointerEvents="none" style={styles.titleWrap}>
            <Text weight="bold" accessibilityRole="header" numberOfLines={1} style={styles.title}>
              {title}
            </Text>
          </View>
          {confirm ? <ToolbarButton action={confirm} prominent /> : <View style={styles.button} />}
        </View>
        {fill ? (
          <FillBody>{children}</FillBody>
        ) : (
          <KeyboardAwareScrollView
            ref={body}
            enabled={landed}
            bottomOffset={28}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 6,
              paddingBottom: insets.bottom + 28,
            }}
          >
            {children}
          </KeyboardAwareScrollView>
        )}
      </Animated.View>
    </Modal>
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
  toolbar: {
    height: 64,
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
});
