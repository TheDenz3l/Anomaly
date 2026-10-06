import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "@/lib/theme";
import { Glass } from "./Glass";
import { Icon } from "./Icon";
import { Tap } from "./Tap";
import { Text } from "./Text";
import Reanimated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
} from "react-native-reanimated";
import {
  Animated,
  Keyboard,
  Modal,
  Platform,
  Pressable,
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

const native = Platform.OS !== "web";

/**
 * Bottom sheet on glass. Slides up; respects reduced motion.
 *
 * With the keyboard up the sheet keeps its size (no relayout when the keyboard comes or goes) and
 * moves with the keyboard frame by frame: it rises as far as the room above it allows, the footer
 * rides on top of the keyboard, and the body scrolls the focused field into the space between.
 */
export function Sheet({ open, onClose, title, subtitle, children, footer, scroll = true }: Props) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [progress] = useState(() => new Animated.Value(0));
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

  useEffect(() => {
    if (open) {
      const land = ({ finished }: { finished: boolean }) => finished && setLanded(true);
      if (reduced)
        Animated.timing(progress, { toValue: 1, duration: 0, useNativeDriver: native }).start(land);
      else
        Animated.spring(progress, {
          toValue: 1,
          damping: 24,
          stiffness: 260,
          mass: 0.9,
          useNativeDriver: native,
        }).start(land);
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: reduced ? 0 : 170,
        useNativeDriver: native,
      }).start(() => setMounted(false));
    }
  }, [open, reduced, progress]);

  useEffect(() => {
    if (landed) body.current?.assureFocusedInputVisible();
  }, [landed]);

  if (!mounted) return null;

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [Math.min(520, height * 0.6), 0],
  });
  const maxHeight = height * 0.88;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={{ flex: 1, opacity: progress, backgroundColor: "rgba(0,0,0,0.55)" }}>
        <Pressable accessibilityLabel="Close" style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View
        onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
        style={{
          position: "absolute",
          bottom: 0,
          alignSelf: "center",
          width: Math.min(width, 560),
          maxHeight,
          transform: [{ translateY }],
        }}
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
              <KeyboardAwareScrollView
                style={{ flexGrow: 0, flexShrink: 1 }}
                contentContainerStyle={{
                  paddingHorizontal: 20,
                  paddingBottom: footer ? 12 : insets.bottom + 20,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
                ref={body}
                enabled={landed && !short}
                // Clear the footer riding on the keyboard; the sheet's own rise already counts.
                bottomOffset={(footer ? footerH : 0) + 40 - room}
              >
                {children}
              </KeyboardAwareScrollView>
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
      </Animated.View>
    </Modal>
  );
}
