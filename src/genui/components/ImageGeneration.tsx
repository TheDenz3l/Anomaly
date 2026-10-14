import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { router, type Href } from "expo-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector, type GestureTouchEvent } from "react-native-gesture-handler";
import Animated, {
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle, Defs, G, Path, RadialGradient, Stop } from "react-native-svg";
import { ActivityRow } from "@/components/chat/Activity";
import { Glass } from "@/components/ui/Glass";
import { Icon } from "@/components/ui/Icon";
import { Text } from "@/components/ui/Text";
import type { GenProps } from "@/genui/kit";
import { useImageActions } from "@/lib/imageFile";
import { reflow } from "@/lib/motion";
import { BAND_STYLE, DotFlow, type DotFrame } from "./dotflow";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const RATIO = { portrait: 3 / 4, square: 1, landscape: 4 / 3, tall: 9 / 16, wide: 16 / 9 } as const;
const RADIUS = 16;
/**
 * The picture's size in the chat: about two thirds of the reply's width for tall and square
 * pictures, wider ones a little more, and never more than this share of the screen's height.
 */
const TALL_WIDTH_SHARE = 0.72;
const WIDE_WIDTH_SHARE = 0.9;
const MAX_HEIGHT_SHARE = 0.46;
/** Dot spacing and brightness, as tuned in the prototype. */
const PITCH = 7;
const GLOW = 1.1;
/** How long each of the model's lines stays up while the image renders. */
const STEP_MS = 3600;
/** Native draws the field at 30 fps: the dots move slowly, and it leaves the JS thread half free. */
const FRAME_MS = Platform.OS === "web" ? 0 : 32;
/** The reveal starts when the image has loaded, or after this long regardless. */
const LOAD_WAIT_MS = 8000;
const ios = Platform.OS === "ios";

/**
 * An image the model is making with the user's image model. While it renders: a field of dots the
 * user can rub (they part, light up and drag the flow along) under the model's own running
 * commentary. When the picture arrives the dots become windows onto it and swell until it's
 * whole. Tapping the picture opens it full screen; its button saves it to Photos. A chat opened
 * later shows the finished image straight away.
 */
export function ImageGeneration({ props, live }: GenProps<"ImageGeneration">) {
  const reduced = useReducedMotion();
  const screen = useWindowDimensions();
  const [width, setWidth] = useState(0);
  // Mounted while the image was on its way: it grows out of the dots. Otherwise it just shows.
  const [grew] = useState(() => props.state === "working");
  const [revealed, setRevealed] = useState(!grew);
  const [loaded, setLoaded] = useState(false);
  const [waited, setWaited] = useState(false);
  const stalled = props.state === "working" && !live;
  const step = useStep(props.steps, props.startedAt, props.state === "working" && !stalled);
  const url = props.state === "done" ? props.url : undefined;
  // The first address the picture arrives at stays for this view: the provider's link comes first
  // and the copy kept with the chat replaces it moments later, which would reload the picture.
  const [shown, setShown] = useState<string | undefined>(undefined);
  if (url && !shown) setShown(url);
  const src = shown ?? url;
  const { save, busy } = useImageActions(url, props.mime, props.title);

  useEffect(() => {
    if (!url || revealed) return;
    const t = setTimeout(() => setWaited(true), LOAD_WAIT_MS);
    return () => clearTimeout(t);
  }, [url, revealed]);

  // The shape the endpoint will send back, so the card doesn't change shape when it lands.
  const ratio =
    !grew && props.width && props.height
      ? props.width / props.height
      : (props.ratio ?? RATIO[props.aspect] ?? 3 / 4);
  const maxW = width * (ratio > 1.05 ? WIDE_WIDTH_SHARE : TALL_WIDTH_SHARE);
  const maxH = screen.height * MAX_HEIGHT_SHARE;
  const w = Math.round(Math.min(maxW, maxH * ratio));
  const h = Math.round(w / ratio);

  if (props.state === "error" || stalled) {
    return (
      <View className="gap-1">
        <ActivityRow
          orb="working"
          live={false}
          label={stalled ? "The image wasn’t finished" : "Couldn’t create the image"}
          doneIcon={stalled ? "stop-circle-outline" : "alert-circle-outline"}
        />
        {props.error ? (
          <Text muted className="pl-[30px] text-[13px] leading-[18px]">
            {props.error.charAt(0).toUpperCase() + props.error.slice(1)}
          </Text>
        ) : null}
      </View>
    );
  }

  const open = () => {
    if (!url) return;
    router.push({
      pathname: "/image" as Href as never,
      params: {
        url,
        title: props.title,
        mime: props.mime ?? "",
        w: String(props.width ?? ""),
        h: String(props.height ?? ""),
      },
    });
  };

  return (
    <Animated.View
      layout={reflow}
      className="gap-2"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {revealed ? null : <ActivityRow orb="working" live label={url ? "Here it comes" : step} />}
      {w > 0 ? (
        <View
          accessible={!revealed}
          accessibilityRole="image"
          accessibilityLabel={`Creating an image: ${props.title}`}
          style={{ width: w, height: h, borderRadius: RADIUS, overflow: "hidden" }}
          className="bg-black"
        >
          {url ? (
            <Pressable
              accessibilityRole="imagebutton"
              accessibilityLabel={props.title}
              accessibilityHint="Opens the image full screen"
              disabled={!revealed}
              onPress={open}
            >
              <Image
                source={{ uri: src }}
                onLoad={() => setLoaded(true)}
                onError={() => setLoaded(true)}
                contentFit="cover"
                cachePolicy="memory-disk"
                transition={grew ? 0 : 180}
                accessibilityIgnoresInvertColors
                style={{ width: w, height: h }}
              />
            </Pressable>
          ) : null}
          {url && revealed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save to Photos"
              onPress={() => void save()}
              disabled={busy !== null}
              hitSlop={8}
              style={styles.save}
            >
              <Glass radius={17} interactive>
                <View className="h-[34px] w-[34px] items-center justify-center">
                  {busy === "save" ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Icon name="download-outline" size={17} color="#fff" />
                  )}
                </View>
              </Glass>
            </Pressable>
          ) : null}
          {!revealed ? (
            <DotField
              key={`${w}x${h}`}
              width={w}
              height={h}
              reduced={reduced}
              ready={Boolean(url) && (loaded || waited)}
              onDone={() => setRevealed(true)}
            />
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  save: { position: "absolute", right: 10, bottom: 10 },
});

/** The model's lines, one after another, holding on the last until the image is in. */
function useStep(steps: string[], startedAt: number, running: boolean): string {
  const at = () => Math.max(0, Math.floor((Date.now() - startedAt) / STEP_MS));
  const [i, setI] = useState(at);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setI(at()), 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, startedAt]);
  return steps[Math.min(i, steps.length - 1)] ?? "Creating the image";
}

function DotField({
  width,
  height,
  reduced,
  ready,
  onDone,
}: {
  width: number;
  height: number;
  reduced: boolean;
  /** The image has loaded under the field: start the reveal. */
  ready: boolean;
  onDone: () => void;
}) {
  const engine = useMemo(
    () => new DotFlow(width, height, { pitch: PITCH, glow: GLOW, reduced }),
    [width, height, reduced]
  );
  const first = useMemo(() => engine.step(0, 0), [engine]);
  const frame = useSharedValue<DotFrame>(first);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  const glowId = `glow${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  useEffect(() => {
    if (ready) engine.reveal(performance.now());
  }, [ready, engine]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let finished = false;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - last < FRAME_MS) return;
      const f = engine.step(Math.min(0.05, (now - last) / 1000), now);
      last = now;
      frame.set(f);
      if (f.done && !finished) {
        finished = true;
        cancelAnimationFrame(raf);
        done.current();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, frame]);

  // Rubbing: side-to-side strokes belong to the card, a vertical swipe still scrolls the chat.
  const gesture = useMemo(() => {
    const at = rub(engine, reduced);
    const lift = () => engine.lift();
    return Gesture.Pan()
      .runOnJS(true)
      .activeOffsetX([-8, 8])
      .failOffsetY([-14, 14])
      .onTouchesDown(at)
      .onTouchesMove(at)
      .onTouchesUp(lift)
      .onTouchesCancelled(lift)
      .onFinalize(lift);
  }, [engine, reduced]);

  return (
    <GestureDetector gesture={gesture}>
      <View style={StyleSheet.absoluteFill}>
        <Svg width={width} height={height}>
          <Defs>
            <RadialGradient id={glowId} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#ccd5e7" stopOpacity={1} />
              <Stop offset="1" stopColor="#ccd5e7" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <FramePath frame={frame} field="cover" initial={first.cover} fill="#000" />
          <Dots frame={frame} initial={first} />
          <FramePath frame={frame} field="flash" initial={first.flash} fill="#fff" opacity={0.55} />
          <Glow frame={frame} gradient={glowId} />
        </Svg>
      </View>
    </GestureDetector>
  );
}

/** Feeds the finger to the field, with a light tick now and then while it moves fast. */
function rub(engine: DotFlow, reduced: boolean) {
  let lastTick = 0;
  return (e: GestureTouchEvent) => {
    const t = e.allTouches[0];
    if (!t) return;
    const now = performance.now();
    engine.touch(t.x, t.y, now);
    if (ios && !reduced && engine.speed > 350 && now - lastTick > 90) {
      lastTick = now;
      void Haptics.selectionAsync();
    }
  };
}

function Dots({ frame, initial }: { frame: SharedValue<DotFrame>; initial: DotFrame }) {
  const animatedProps = useAnimatedProps(() => ({ opacity: frame.get().dots }));
  return (
    <AnimatedG animatedProps={animatedProps}>
      {BAND_STYLE.map((s, k) =>
        s.opacity > 0.02 ? (
          <FramePath
            key={k}
            frame={frame}
            field="bands"
            band={k}
            initial={initial.bands[k]}
            fill={s.color}
            opacity={s.opacity}
          />
        ) : null
      )}
      <FramePath frame={frame} field="sparks" initial={initial.sparks} fill="#fff" />
    </AnimatedG>
  );
}

/** One path of the frame, redrawn from the UI thread whenever a new frame lands. */
function FramePath({
  frame,
  field,
  band = 0,
  initial,
  fill,
  opacity = 1,
}: {
  frame: SharedValue<DotFrame>;
  field: "bands" | "sparks" | "flash" | "cover";
  band?: number;
  initial: string;
  fill: string;
  opacity?: number;
}) {
  const animatedProps = useAnimatedProps(() => {
    const f = frame.get();
    return { d: field === "bands" ? f.bands[band] : f[field] };
  });
  return (
    <AnimatedPath d={initial} animatedProps={animatedProps} fill={fill} fillOpacity={opacity} />
  );
}

/** A soft light under the finger while it rubs. */
function Glow({ frame, gradient }: { frame: SharedValue<DotFrame>; gradient: string }) {
  const animatedProps = useAnimatedProps(() => {
    const g = frame.get().glow;
    return { cx: g.x, cy: g.y, opacity: g.a };
  });
  return (
    <AnimatedCircle
      cx={0}
      cy={0}
      r={80}
      opacity={0}
      fill={`url(#${gradient})`}
      animatedProps={animatedProps}
    />
  );
}
