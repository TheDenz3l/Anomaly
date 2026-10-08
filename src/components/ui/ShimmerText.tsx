import { useEffect, useMemo, useState } from "react";
import { Animated, Easing, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { colors, fonts } from "@/lib/theme";
import { Text } from "./Text";

/** One sweep, then a rest before the next, in ms. */
const CYCLE = 2200;
const SWEEP = 0.72;
/** Points along the sweep each character's opacity curve is drawn through. */
const SAMPLES = 24;

/** A character's opacity at sweep progress `v` (0–1): a soft bell centred on the band of light. */
function glowAt(v: number, index: number, total: number): number {
  const band = Math.max(3, total * 0.3);
  const p = Math.min(1, v / SWEEP);
  // The band starts fully left of the text and ends fully right of it, so each sweep enters and leaves cleanly.
  const at = -band + p * (total + band * 2);
  const dist = (index - at) / band;
  return 0.4 + 0.6 * Math.exp(-dist * dist * 2.4);
}

const INPUT = [...Array.from({ length: SAMPLES + 1 }, (_, i) => (i / SAMPLES) * SWEEP), 1];

/**
 * Label with a band of light passing through it while work is in progress (the "thinking" shimmer).
 * Each character's opacity follows a soft bell centred on the band, so it reads as a gradient on
 * every platform without masked views. Static text when inactive or under Reduce Motion.
 *
 * Driven by the native animation driver: opacity changes are applied to the views directly, with no
 * React or shadow-tree work per frame, so a label shimmering for a whole reply costs the JS thread
 * nothing and never delays a touch.
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
  const [progress] = useState(() => new Animated.Value(0));
  const live = active && !reduced;

  useEffect(() => {
    if (!live) return;
    progress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: CYCLE,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [live, progress]);

  const chars = useMemo(() => Array.from(text), [text]);
  const opacities = useMemo(
    () =>
      chars.map((_, i) =>
        progress.interpolate({
          inputRange: INPUT,
          outputRange: INPUT.map((v) => glowAt(v, i, chars.length)),
        })
      ),
    [chars, progress]
  );

  if (!live) {
    return (
      <Text weight="medium" muted style={{ fontSize: size, lineHeight }} numberOfLines={1}>
        {text}
      </Text>
    );
  }

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={text}
      style={{ flexDirection: "row", flexShrink: 1, overflow: "hidden" }}
    >
      {chars.map((ch, i) => (
        <Animated.Text
          key={`${i}${ch}`}
          importantForAccessibility="no"
          style={{
            fontFamily: fonts.medium,
            fontSize: size,
            lineHeight,
            color: colors.text,
            opacity: opacities[i],
          }}
        >
          {ch === " " ? "\u00A0" : ch}
        </Animated.Text>
      ))}
    </View>
  );
}
