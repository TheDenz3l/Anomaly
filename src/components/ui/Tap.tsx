import * as Haptics from "expo-haptics";
import type { ComponentProps } from "react";
import { Platform, Pressable, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { springs } from "@/lib/motion";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = Omit<ComponentProps<typeof Pressable>, "style"> & {
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Squeeze in pixels at full press — the same felt depth for a 36px button and a full-width row. */
const SQUEEZE_PX = 10;
const MAX_SQUEEZE = 0.06;

/**
 * Pressable that squeezes and dims under the finger, then springs back on release.
 * Optional light haptic on iOS.
 */
export function Tap({ haptic, onPress, onPressIn, onPressOut, onLayout, style, ...rest }: Props) {
  const pressed = useSharedValue(0);
  const width = useSharedValue(0);
  const reduced = useReducedMotion();
  const maxSqueeze = reduced ? 0 : MAX_SQUEEZE;

  const feedback = useAnimatedStyle(() => {
    const squeeze = Math.min(maxSqueeze, SQUEEZE_PX / Math.max(width.get(), 1));
    return {
      opacity: 1 - pressed.get() * 0.28,
      transform: [{ scale: 1 - pressed.get() * squeeze }],
    };
  });

  return (
    <AnimatedPressable
      {...rest}
      onLayout={(e) => {
        width.set(e.nativeEvent.layout.width);
        onLayout?.(e);
      }}
      onPressIn={(e) => {
        pressed.set(withTiming(1, { duration: 80 }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        pressed.set(withSpring(0, springs.snappy));
        onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptic && Platform.OS === "ios") void Haptics.selectionAsync();
        onPress?.(e);
      }}
      style={[style, feedback]}
    />
  );
}
