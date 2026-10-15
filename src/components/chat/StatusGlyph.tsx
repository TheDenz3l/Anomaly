import { useEffect } from "react";
import { Platform, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type EntryAnimationsValues,
  type EntryExitAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { Orb, type OrbState } from "@/components/orb/Orb";
import { Icon } from "@/components/ui/Icon";
import type { StatusPhase } from "@/lib/replyStatus";
import { colors } from "@/lib/theme";

/** The status line's glyph box, in px. */
export const GLYPH = 20;

/**
 * While the model works out what to say, the line's glyph is the globe, moving the way the work
 * moves: a walk of light for thinking, a sweeping lens for the web, a falling ring otherwise.
 * Searching and reading share one globe so the lens carries on across them.
 */
const GLOBE: Partial<Record<StatusPhase, OrbState>> = {
  thinking: "reasoning",
  searching: "searching",
  reading: "searching",
  working: "working",
};

/** Phases that draw the same glyph share a key, so the line only swaps glyphs when the picture changes. */
export function glyphKey(phase: StatusPhase): string {
  const globe = GLOBE[phase];
  return globe ? `globe-${globe}` : phase;
}

/** 0 → 1 over `ms`, over and over. Holds at `rest` under Reduce Motion. */
function useLoop(ms: number, rest: number): SharedValue<number> {
  const reduced = useReducedMotion();
  const p = useSharedValue(rest);
  useEffect(() => {
    if (reduced) {
      p.set(rest);
      return;
    }
    p.set(0);
    p.set(withRepeat(withTiming(1, { duration: ms, easing: Easing.linear }), -1, false));
  }, [reduced, ms, rest, p]);
  return p;
}

/** How far through its own slice [from, from + span] of the loop `p` is, eased. */
function slice(p: number, from: number, span: number): number {
  "worklet";
  const x = Math.min(1, Math.max(0, (p - from) / span));
  return x * x * (3 - 2 * x);
}

/** Everything drawn so far fades together at the end of each loop, ready for the next pass. */
function fadeTail(p: number): number {
  "worklet";
  return p < 0.84 ? 1 : 1 - (p - 0.84) / 0.16;
}

const LINES = [13, 10, 6];

/** Writing: three lines of text filled in one after another, like a pen working down a page. */
function Lines({ color }: { color: string }) {
  const p = useLoop(2100, 0.8);
  return (
    <View style={{ width: 16, gap: 3 }}>
      {LINES.map((w, i) => (
        <View key={i} style={{ width: w, height: 2, borderRadius: 1 }}>
          <View
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 1,
              backgroundColor: color,
              opacity: 0.18,
            }}
          />
          <Stroke p={p} index={i} color={color} />
        </View>
      ))}
    </View>
  );
}

function Stroke({ p, index, color }: { p: SharedValue<number>; index: number; color: string }) {
  const style = useAnimatedStyle(() => {
    const v = p.get();
    return { opacity: fadeTail(v), transform: [{ scaleX: slice(v, index * 0.24, 0.26) }] };
  });
  return (
    <Animated.View
      style={[
        { position: "absolute", inset: 0, borderRadius: 1, backgroundColor: color },
        { transformOrigin: "left" },
        style,
      ]}
    />
  );
}

/** Clockwise from the top left, the order the tiles of a card land in. */
const TILES = [
  { x: 0, y: 0 },
  { x: 9, y: 0 },
  { x: 9, y: 9 },
  { x: 0, y: 9 },
];

/** Building a card: four tiles settle into place one by one, then clear for the next pass. */
function Tiles({ color }: { color: string }) {
  const p = useLoop(1900, 0.8);
  return (
    <View style={{ width: 16, height: 16 }}>
      {TILES.map((t, i) => (
        <Tile key={i} p={p} index={i} x={t.x} y={t.y} color={color} />
      ))}
    </View>
  );
}

function Tile({
  p,
  index,
  x,
  y,
  color,
}: {
  p: SharedValue<number>;
  index: number;
  x: number;
  y: number;
  color: string;
}) {
  const style = useAnimatedStyle(() => {
    const v = p.get();
    const k = slice(v, index * 0.16, 0.22);
    return { opacity: (0.2 + 0.8 * k) * fadeTail(v), transform: [{ scale: 0.55 + 0.45 * k }] };
  });
  return (
    <Animated.View
      style={[
        { position: "absolute", left: x, top: y, width: 7, height: 7, borderRadius: 2 },
        { backgroundColor: color },
        style,
      ]}
    />
  );
}

/** Making an image: a grid of pixels developing in a wave from one corner to the other. */
function Pixels({ color }: { color: string }) {
  const p = useLoop(1600, 0.5);
  return (
    <View style={{ width: 16, flexDirection: "row", flexWrap: "wrap", gap: 2 }}>
      {Array.from({ length: 9 }, (_, i) => (
        <Pixel key={i} p={p} at={(Math.floor(i / 3) + (i % 3)) / 4} color={color} />
      ))}
    </View>
  );
}

function Pixel({ p, at, color }: { p: SharedValue<number>; at: number; color: string }) {
  const style = useAnimatedStyle(() => {
    // Distance around the loop from the crest of the wave, so it wraps without a seam.
    let d = Math.abs(p.get() - at);
    d = Math.min(d, 1 - d);
    return { opacity: 0.22 + 0.78 * Math.exp(-d * d * 28) };
  });
  return (
    <Animated.View
      style={[{ width: 4, height: 4, borderRadius: 1.2, backgroundColor: color }, style]}
    />
  );
}

const CHECK = "M4.5 10.2 L8 13.6 L15.5 6";

/**
 * Draws the check by uncovering it from left to right, down the short stroke and up the long one.
 * An entering animation, so it starts on the UI thread the moment the reply finishes, however busy
 * the JS thread is with the finished answer.
 */
const drawIn: EntryExitAnimationFunction = (v: EntryAnimationsValues) => {
  "worklet";
  return {
    initialValues: { width: 0 },
    animations: {
      width: withTiming(v.targetWidth, { duration: 420, easing: Easing.out(Easing.cubic) }),
    },
  };
};

/** Done: a check that draws itself when the reply finishes in front of you. */
function Check({ color, draw }: { color: string; draw: boolean }) {
  return (
    <Animated.View
      entering={draw && Platform.OS !== "web" ? drawIn : undefined}
      style={{ width: GLYPH, height: GLYPH, overflow: "hidden" }}
    >
      <Svg width={GLYPH} height={GLYPH} viewBox="0 0 20 20">
        <Path
          d={CHECK}
          stroke={color}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}

/**
 * The picture at the start of the status line. `draw` plays the check's stroke, for a reply that
 * finishes while it is on screen rather than one that was already done when the chat opened.
 */
export function StatusGlyph({ phase, draw = false }: { phase: StatusPhase; draw?: boolean }) {
  const globe = GLOBE[phase];
  if (globe) return <Orb state={globe} size={18} />;
  switch (phase) {
    case "writing":
      return <Lines color={colors.text} />;
    case "building":
      return <Tiles color={colors.text} />;
    case "imaging":
      return <Pixels color={colors.text} />;
    case "stopped":
      return (
        <View
          style={{ width: 9, height: 9, borderRadius: 2.5, backgroundColor: colors.textFaint }}
        />
      );
    case "error":
      return <Icon name="alert-circle-outline" size={17} color={colors.danger} />;
    default:
      return <Check color={colors.textMuted} draw={draw} />;
  }
}
