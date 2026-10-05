import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { colors, fonts } from "@/lib/theme";
import { Text } from "./Text";

/** One sweep, then a rest before the next, in ms. */
const CYCLE = 2200;
const SWEEP = 0.72;

/**
 * Label with a band of light passing through it while work is in progress (the "thinking" shimmer).
 * Each character's opacity follows a soft bell centred on the band, so it reads as a gradient on
 * every platform without masked views. Static text when inactive or under Reduce Motion.
 */
export function ShimmerText({
  text,
  active = true,
  size = 15,
  lineHeight = 22,
}: {
  text: string;
  active?: boolean;
  size?: number;
  lineHeight?: number;
}) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  const live = active && !reduced;

  useEffect(() => {
    if (!live) {
      cancelAnimation(progress);
      return;
    }
    progress.set(0);
    progress.set(withRepeat(withTiming(1, { duration: CYCLE, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(progress);
  }, [live, progress]);

  if (!live) {
    return (
      <Text weight="medium" muted style={{ fontSize: size, lineHeight }} numberOfLines={1}>
        {text}
      </Text>
    );
  }

  const chars = Array.from(text);
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={text} style={{ flexDirection: "row", flexShrink: 1, overflow: "hidden" }}>
      {chars.map((ch, i) => (
        <Char key={`${i}${ch}`} ch={ch} index={i} total={chars.length} progress={progress} size={size} lineHeight={lineHeight} />
      ))}
    </View>
  );
}

function Char({
  ch,
  index,
  total,
  progress,
  size,
  lineHeight,
}: {
  ch: string;
  index: number;
  total: number;
  progress: SharedValue<number>;
  size: number;
  lineHeight: number;
}) {
  const style = useAnimatedStyle(() => {
    const band = Math.max(3, total * 0.3);
    const p = Math.min(1, progress.get() / SWEEP);
    // The band starts fully left of the text and ends fully right of it, so each sweep enters and leaves cleanly.
    const at = -band + p * (total + band * 2);
    const dist = (index - at) / band;
    const glow = Math.exp(-dist * dist * 2.4);
    return { opacity: 0.4 + 0.6 * glow };
  });
  return (
    <Animated.Text
      importantForAccessibility="no"
      style={[{ fontFamily: fonts.medium, fontSize: size, lineHeight, color: colors.text }, style]}
    >
      {ch === " " ? "\u00A0" : ch}
    </Animated.Text>
  );
}
