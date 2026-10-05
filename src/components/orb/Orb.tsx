import { useEffect, useMemo } from "react";
import { View } from "react-native";
import Animated, {
  useAnimatedProps,
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { colors } from "@/lib/theme";
import { BANDS, makeOrb, orbFrame, type OrbFrame, type OrbState } from "./orb-core";

export type { OrbState } from "./orb-core";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  state?: OrbState;
  /** Width and height in px. Tuned to read at 20. */
  size?: number;
  color?: string;
  /** Holds it on its current frame — used once the work it stands for is done. */
  paused?: boolean;
  speed?: number;
  density?: number;
  dotSize?: number;
  /** Draws one dot in this colour: the anomaly in the Anomaly mark. */
  anomalyColor?: string;
  /** What screen readers announce. Without one the orb is hidden from them. */
  label?: string;
};

/**
 * Animated dot sphere that shows what the assistant is doing by how its dots move: a walk of light
 * for reasoning, a sweeping lens for search, a falling ring for work. Holds still under Reduce Motion.
 */
export function Orb({
  state = "base",
  size = 20,
  color = colors.text,
  paused = false,
  speed = 1,
  density = 1,
  dotSize = 1,
  anomalyColor,
  label,
}: Props) {
  const reduced = useReducedMotion();
  const still = paused || reduced;
  const cfg = useMemo(
    () => makeOrb(state, size, { density, dotSize, anomaly: anomalyColor !== undefined }),
    [state, size, density, dotSize, anomalyColor]
  );
  const initial = useMemo(() => orbFrame(0, cfg), [cfg]);
  const t = useSharedValue(0);

  const clock = useFrameCallback((info) => {
    // A frame's gap is capped so a backgrounded app carries on instead of jumping.
    t.set(t.get() + Math.min(info.timeSincePreviousFrame ?? 16, 100) * speed);
  }, !still);

  useEffect(() => {
    clock.setActive(!still);
  }, [clock, still]);

  const frame = useDerivedValue(() => orbFrame(t.get(), cfg), [cfg]);

  return (
    <View
      accessible={Boolean(label)}
      accessibilityRole={label ? "image" : undefined}
      accessibilityLabel={label}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"}
      style={{ width: size, height: size }}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {Array.from({ length: BANDS }, (_, k) => (
          <Band key={k} frame={frame} band={k} d={initial.paths[k]} color={color} />
        ))}
        {anomalyColor ? <Anomaly frame={frame} initial={initial} color={anomalyColor} /> : null}
      </Svg>
    </View>
  );
}

function Band({
  frame,
  band,
  d,
  color,
}: {
  frame: SharedValue<OrbFrame>;
  band: number;
  d: string;
  color: string;
}) {
  const animatedProps = useAnimatedProps(() => ({ d: frame.get().paths[band] }));
  return (
    <AnimatedPath
      d={d}
      animatedProps={animatedProps}
      fill={color}
      fillOpacity={(band + 1) / BANDS}
    />
  );
}

function Anomaly({
  frame,
  initial,
  color,
}: {
  frame: SharedValue<OrbFrame>;
  initial: OrbFrame;
  color: string;
}) {
  const animatedProps = useAnimatedProps(() => {
    const f = frame.get();
    return { cx: f.ax, cy: f.ay, r: f.ar, fillOpacity: f.aa };
  });
  return (
    <AnimatedCircle
      cx={initial.ax}
      cy={initial.ay}
      r={initial.ar}
      fillOpacity={initial.aa}
      animatedProps={animatedProps}
      fill={color}
    />
  );
}
