import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Orb, type OrbState } from "@/components/orb/Orb";
import { Icon, type IconName } from "@/components/ui/Icon";
import { ShimmerText } from "@/components/ui/ShimmerText";
import { Tap } from "@/components/ui/Tap";
import { springs } from "@/lib/motion";
import { colors } from "@/lib/theme";

/** Points right when closed and turns down to open, following the row's state. */
function Disclosure({ open }: { open: boolean }) {
  const reduced = useReducedMotion();
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.set(reduced ? (open ? 1 : 0) : withSpring(open ? 1 : 0, springs.snappy));
  }, [open, reduced, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 90}deg` }] }));
  return (
    <Animated.View style={style}>
      <Icon name="chevron-forward" size={13} color={colors.textFaint} />
    </Animated.View>
  );
}

/**
 * One line of assistant activity: an orb that moves while the work runs and a label with light
 * passing through it. When the work is done the orb settles into a still glyph and the label stops.
 */
export function ActivityRow({
  orb,
  live,
  label,
  doneIcon,
  expanded,
  onToggle,
  trailing,
}: {
  orb: OrbState;
  live: boolean;
  label: string;
  /** Glyph once done. Omit to keep the orb, held still and dimmed. */
  doneIcon?: IconName;
  expanded?: boolean;
  onToggle?: () => void;
  trailing?: ReactNode;
}) {
  const glyph = live ? (
    <Orb state={orb} size={18} label={label} />
  ) : doneIcon ? (
    <Icon name={doneIcon} size={16} color={colors.textMuted} />
  ) : (
    <Orb state={orb} size={18} paused color={colors.textMuted} />
  );

  const body = (
    <View className="min-h-[30px] flex-row items-center gap-2.5">
      <View className="h-5 w-5 items-center justify-center">{glyph}</View>
      <View className="shrink flex-row items-center gap-1.5">
        <ShimmerText text={label} active={live} />
        {onToggle ? <Disclosure open={Boolean(expanded)} /> : null}
      </View>
      {trailing}
    </View>
  );

  if (!onToggle) return body;
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: Boolean(expanded) }}
      onPress={onToggle}
      className="self-start"
    >
      {body}
    </Tap>
  );
}

/** The thread hanging off an activity row: a hairline under the glyph, details indented beside it. */
export function Rail({ children }: { children: ReactNode }) {
  return <View className="ml-[9.5px] mt-1 border-l border-raised pb-1 pl-[20px]">{children}</View>;
}
