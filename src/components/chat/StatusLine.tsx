import { useEffect, useState, type ReactNode } from "react";
import { Platform, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  LayoutAnimationConfig,
  withTiming,
  type EntryExitAnimationFunction,
  type LayoutAnimationFunction,
} from "react-native-reanimated";
import { Favicon } from "@/components/ui/Favicon";
import { ShimmerText } from "@/components/ui/ShimmerText";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { domainOf } from "@/lib/links";
import { glyphIn, glyphOut } from "@/lib/motion";
import type { StatusPhase } from "@/lib/replyStatus";
import { Disclosure } from "./Activity";
import { GLYPH, StatusGlyph, glyphKey } from "./StatusGlyph";

/** Height of one line of status text; rolling words are clipped to it. */
const LINE = 22;
/** How far words travel as they roll in and out, in px. */
const ROLL = 8;
const ROLL_MS = 280;
const WIDTH_MS = 320;
const ease = Easing.out(Easing.cubic);
/** Space between the pieces of the line, which collapses along with a piece that leaves. */
const GAP = 6;
/** Room kept free for the clock and the chevron when a long detail is cut short. */
const RESERVE = 70;

/*
 * Every motion on the line is a Reanimated layout animation: it starts on the UI thread the moment
 * a change is committed, never waiting on the JS thread, which is busiest exactly when a reply
 * moves on (the answer finishing, its sources arriving). Web gets the plain swap.
 */
const native = Platform.OS !== "web";

/** New words rise into the line from just below it. */
const riseIn: EntryExitAnimationFunction = () => {
  "worklet";
  const t = { duration: ROLL_MS, easing: ease };
  return {
    initialValues: { opacity: 0, transform: [{ translateY: ROLL }] },
    animations: { opacity: withTiming(1, t), transform: [{ translateY: withTiming(0, t) }] },
  };
};

/**
 * Old words lift out of the line; the layer's own style keeps them hidden afterwards. Words making
 * way for new ones clear a little early; a piece closing takes its words with it to the end.
 */
function lift(closing: boolean): EntryExitAnimationFunction {
  return () => {
    "worklet";
    const t = { duration: ROLL_MS, easing: ease };
    return {
      initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
      animations: {
        opacity: withTiming(0, { duration: closing ? ROLL_MS : ROLL_MS * 0.8, easing: ease }),
        transform: [{ translateY: withTiming(-ROLL, t) }],
      },
    };
  };
}
const liftOut = lift(false);
const closeOut = lift(true);

/**
 * Each piece eases from its old frame to its new one on one shared curve, so a piece and the ones
 * after it always move together and never overlap. `growAtOnce` gives a piece more room at once
 * (the clock ticking to a wider number) so its last digit is never clipped.
 */
function glideBy(growAtOnce: boolean): LayoutAnimationFunction {
  return (v) => {
    "worklet";
    const t = { duration: WIDTH_MS, easing: ease };
    const width = growAtOnce && v.targetWidth > v.currentWidth ? v.targetWidth : v.currentWidth;
    return {
      initialValues: {
        originX: v.currentOriginX,
        originY: v.currentOriginY,
        width,
        height: v.currentHeight,
      },
      animations: {
        originX: withTiming(v.targetOriginX, t),
        originY: withTiming(v.targetOriginY, t),
        width: withTiming(v.targetWidth, width === v.targetWidth ? { duration: 0 } : t),
        height: withTiming(v.targetHeight, t),
      },
    };
  };
}
const glide = glideBy(false);
const glideClock = glideBy(true);

type Turn = {
  value: string;
  node: ReactNode;
  prev: { value: string; node: ReactNode } | null;
  n: number;
  roll: boolean;
};

/**
 * One piece of the line that rolls to its next value: the old words lift away as the new ones rise
 * in, while the piece eases from its old width to the new one. The pieces after it ride along on
 * the same curve, so nothing on the line can overlap or jump. An empty value collapses the piece,
 * gap included. `instant` swaps without the roll (the clock), still easing the width.
 */
function Rolling({
  value,
  children,
  gap = 0,
  maxWidth,
  instant = false,
  onWidth,
}: {
  value: string;
  children: ReactNode;
  gap?: number;
  maxWidth?: number;
  instant?: boolean;
  onWidth?: (width: number) => void;
}) {
  const [turn, setTurn] = useState<Turn>(() => ({
    value,
    node: children,
    prev: null,
    n: 0,
    roll: true,
  }));
  if (turn.value !== value) {
    const roll = !(instant && turn.value && value);
    setTurn({
      value,
      node: children,
      prev: roll && turn.value ? { value: turn.value, node: turn.node } : null,
      n: turn.n + 1,
      roll,
    });
  }

  useEffect(() => {
    if (!turn.value) onWidth?.(0);
    if (!turn.prev) return;
    // The leaving words are hidden by their own style once lifted; this only unmounts them.
    const t = setTimeout(
      () => setTurn((s) => (s.n === turn.n ? { ...s, prev: null } : s)),
      ROLL_MS + 60
    );
    return () => clearTimeout(t);
    // Runs once per turn; the turn carries everything it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn.n]);

  const layer = {
    height: LINE,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: gap,
    maxWidth,
  } as const;

  return (
    <Animated.View
      layout={native ? (instant ? glideClock : glide) : undefined}
      style={{ height: LINE, flexDirection: "row", overflow: "hidden" }}
    >
      {turn.prev ? (
        <Animated.View
          key={`out-${turn.n}`}
          entering={native ? (value ? liftOut : closeOut) : undefined}
          style={[
            layer,
            { position: "absolute", left: 0, top: 0, opacity: 0 },
            { transform: [{ translateY: -ROLL }] },
          ]}
        >
          {turn.prev.node}
        </Animated.View>
      ) : null}
      {value ? (
        <Animated.View
          key={`in-${turn.n}`}
          entering={native && turn.roll ? riseIn : undefined}
          onLayout={
            onWidth ? (e: LayoutChangeEvent) => onWidth(e.nativeEvent.layout.width) : undefined
          }
          style={[layer, { flexShrink: 0 }]}
        >
          {children}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/**
 * One line that tells you what a reply is doing and changes with it: the glyph swaps, the label
 * rolls to the next step with light passing through it, a muted detail says what the step is on
 * (a query, a page, a card), and a clock counts up. When the reply ends it settles into a still
 * summary that opens the steps behind it.
 */
export function StatusLine({
  phase,
  live,
  label,
  detail,
  site,
  sources,
  sourceCount = 0,
  timer,
  expanded,
  onToggle,
  enter = false,
  width = 0,
}: {
  phase: StatusPhase;
  live: boolean;
  label: string;
  detail?: string;
  /** A page being read; its favicon and domain take the detail's place. */
  site?: string;
  /** Pages a finished reply searched, for a small stack of favicons and the count. */
  sources?: string[];
  sourceCount?: number;
  timer?: string;
  expanded?: boolean;
  onToggle?: () => void;
  /** Plays the line in: a reply that is live when it mounts, not one already finished. */
  enter?: boolean;
  /** The width the line may take; a long detail is cut short to fit. */
  width?: number;
}) {
  // The check only draws itself when the reply finishes here, not on a chat opened afterwards.
  const [firstPhase] = useState(phase);
  const [labelWidth, setLabelWidth] = useState(0);
  const aside = site ? domainOf(site) : detail;
  const words = [label, aside, timer].filter(Boolean).join(", ");
  const asideMax = width > 0 ? Math.max(48, width - GLYPH - 10 - labelWidth - RESERVE) : undefined;

  return (
    <Tap
      disabled={!onToggle}
      accessibilityRole={onToggle ? "button" : "text"}
      accessibilityLabel={words}
      accessibilityState={onToggle ? { expanded: Boolean(expanded) } : undefined}
      accessibilityLiveRegion="polite"
      onPress={onToggle}
      className="self-start"
    >
      {/* A finished reply shows its line still; a live one plays it in. */}
      <LayoutAnimationConfig skipEntering={!enter}>
        <View className="min-h-[30px] flex-row items-center">
          <View
            style={{ width: GLYPH, height: GLYPH, marginRight: 10 }}
            importantForAccessibility="no-hide-descendants"
          >
            <Animated.View
              key={glyphKey(phase)}
              entering={glyphIn}
              exiting={glyphOut}
              style={{
                position: "absolute",
                inset: 0,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <StatusGlyph phase={phase} draw={phase !== firstPhase} />
            </Animated.View>
          </View>
          <Rolling value={label} onWidth={setLabelWidth}>
            <ShimmerText text={label} active={live} />
          </Rolling>
          <Rolling value={site ?? aside ?? ""} gap={GAP} maxWidth={asideMax}>
            {site ? (
              <View className="mr-1.5">
                <Favicon url={site} size={14} />
              </View>
            ) : null}
            <Text numberOfLines={1} className="shrink text-[14px] leading-[22px] text-ink-faint">
              {aside}
            </Text>
          </Rolling>
          <Rolling value={sources?.length ? String(sourceCount) : ""} gap={GAP}>
            <View className="flex-row">
              {(sources ?? []).map((url, i) => (
                <View key={url} style={{ marginLeft: i === 0 ? 0 : -5, zIndex: 3 - i }}>
                  <Favicon url={url} size={16} ring />
                </View>
              ))}
            </View>
            <Text className="ml-1.5 text-[13px] leading-[22px] text-ink-faint">{sourceCount}</Text>
          </Rolling>
          <Rolling value={timer ?? ""} gap={GAP} instant>
            <Text className="text-[13px] leading-[22px] text-ink-faint">{timer}</Text>
          </Rolling>
          <Rolling value={onToggle ? "open" : ""} gap={GAP}>
            <Disclosure open={Boolean(expanded)} />
          </Rolling>
        </View>
      </LayoutAnimationConfig>
    </Tap>
  );
}
