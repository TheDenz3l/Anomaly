import { useEffect, useState } from "react";
import { Animated, Platform, View } from "react-native";
import ReAnimated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { fadeIn, fadeOut, springs } from "@/lib/motion";
import { colors } from "@/lib/theme";
import type { ThinkingPart } from "@/lib/types";

export function usePulse(active: boolean) {
  const [v] = useState(() => new Animated.Value(1));
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!active || reduced) {
      v.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, {
          toValue: 0.35,
          duration: 700,
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: Platform.OS !== "web" }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [active, reduced, v]);
  return v;
}

/** Chevron that turns to show whether the section is open. */
function Chevron({ open }: { open: boolean }) {
  const turn = useSharedValue(open ? 1 : 0);
  const reduced = useReducedMotion();
  useEffect(() => {
    turn.set(reduced ? (open ? 1 : 0) : withSpring(open ? 1 : 0, springs.snappy));
  }, [open, reduced, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 180}deg` }] }));
  return (
    <ReAnimated.View style={style}>
      <Icon name="chevron-down" size={14} color={colors.textFaint} />
    </ReAnimated.View>
  );
}

/** Collapsible reasoning text — only shown when the endpoint actually returns it (PRD §3.5). */
export function ThinkingBlock({ part }: { part: ThinkingPart }) {
  const [open, setOpen] = useState(false);
  const pulse = usePulse(!part.done);
  const secs = Math.max(1, Math.round((part.durationMs ?? 0) / 1000));
  const preview = part.text.slice(-110);

  return (
    <View>
      <Tap
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={part.done ? `Thought for ${secs} seconds` : "Thinking"}
        onPress={() => setOpen((o) => !o)}
        className="flex-row items-center gap-1.5 self-start py-1"
      >
        <Animated.View style={{ opacity: pulse }}>
          <Icon name="bulb-outline" size={15} color={colors.textMuted} />
        </Animated.View>
        <Text weight="medium" muted className="text-sm">
          {part.done ? `Thought for ${secs}s` : "Thinking"}
        </Text>
        <Chevron open={open} />
      </Tap>
      {open ? (
        <ReAnimated.View entering={fadeIn} exiting={fadeOut} className="ml-1.5 mt-1 border-l-2 border-raised pl-3">
          <Text className="text-sm leading-[21px] text-ink-faint">{part.text}</Text>
        </ReAnimated.View>
      ) : !part.done && preview ? (
        <Text numberOfLines={1} className="ml-6 text-[13px] text-ink-faint">
          {preview}
        </Text>
      ) : null}
    </View>
  );
}
