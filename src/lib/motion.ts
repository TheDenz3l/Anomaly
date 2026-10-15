import { Platform } from "react-native";
import {
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  ZoomIn,
  ZoomOut,
  Easing,
  withSpring,
  withTiming,
  type EntryExitAnimationFunction,
} from "react-native-reanimated";

/**
 * One motion vocabulary for the whole app. Layout animations below respect the system
 * Reduce Motion setting automatically; hand-rolled ones check useReducedMotion().
 */
/**
 * Reanimated on web only runs its predefined presets with duration/delay modifiers. Spring and
 * custom-initial-value variants become ad-hoc keyframes that leave elements absolutely positioned
 * afterwards, so web gets the plain preset of the same motion.
 */
const web = Platform.OS === "web";

export const springs = {
  /** Press feedback, toggles, thumbs — quick and settled. */
  snappy: { damping: 20, stiffness: 380, mass: 0.6 },
  /** Things travelling a distance — drawer, sheets, indicators. */
  glide: { damping: 26, stiffness: 240, mass: 0.9 },
};

const iosOut = Easing.bezierFn(0.32, 0.72, 0, 1);
/**
 * The iOS sheet curve, clamped: a timing's first frame can land a hair before its start time,
 * and the curve extrapolated below 0 nudges a sheet the wrong way for a frame.
 */
export function clampedOut(t: number) {
  "worklet";
  return iosOut(Math.min(1, Math.max(0, t)));
}

/**
 * Sheets open on a critically damped spring, quick off the mark with no bounce (a bottom-anchored
 * sheet that overshoots shows a gap under it). They close on a slightly softer spring that starts
 * from rest, or from the finger's speed when flicked away, so they leave as smoothly as they came.
 */
export const sheetMotion = {
  open: { damping: 34, stiffness: 340, mass: 0.9, overshootClamping: true },
  close: { damping: 29, stiffness: 260, mass: 0.9, overshootClamping: true },
  /** A drag let go before it dismisses settles back. */
  settle: { damping: 30, stiffness: 320, overshootClamping: true },
};

/** Section entrance when a page opens: rise and fade, staggered by position (capped so long pages don't crawl). */
export const enterUp = (index = 0) => {
  const base = FadeInDown.duration(360).delay(30 + Math.min(index, 10) * 45);
  return web ? base : base.withInitialValues({ opacity: 0, transform: [{ translateY: 14 }] });
};

export const fadeIn = FadeIn.duration(220);
export const fadeOut = FadeOut.duration(140);

/**
 * Siblings sliding into the space left by an added or removed item. Native only: on web, Reanimated
 * positions elements absolutely for layout transitions, which collapses stacked sections.
 */
export const reflow = web ? undefined : LinearTransition.springify().damping(26).stiffness(260);

/** Small controls that appear and disappear in place (send ↔ mic ↔ stop, jump-to-latest). */
export const popIn = web ? ZoomIn.duration(180) : ZoomIn.springify().damping(15).stiffness(320);
export const popOut = ZoomOut.duration(110);

/** Switching to another chat: the conversation settles in from slightly below. */
export const threadIn = web
  ? FadeInDown.duration(300)
  : FadeInDown.duration(300).withInitialValues({ opacity: 0, transform: [{ translateY: 10 }] });

/** Your message rising out of the composer. */
export const bubbleIn = web
  ? FadeInDown.duration(260)
  : FadeInDown.springify().damping(18).stiffness(220);
/** Assistant replies have no bubble, so they simply fade up into place. */
export const replyIn = FadeIn.duration(320);
/** A card arriving inside a reply that is still streaming. */
export const cardIn = FadeIn.duration(280);
/** The new-chat orb making way for the first message. */
export const emptyOut = FadeOut.duration(200);

/** Its glyph swapping: the old one shrinks away while the new one grows in with a small twist. */
const glyphEnter: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.35 }, { rotate: "-35deg" }] },
    animations: {
      opacity: withTiming(1, { duration: 160 }),
      transform: [
        { scale: withSpring(1, { damping: 13, stiffness: 260, mass: 0.7 }) },
        { rotate: withSpring("0deg", { damping: 16, stiffness: 220 }) },
      ],
    },
  };
};
const glyphExit: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: {
      opacity: withTiming(0, { duration: 150 }),
      transform: [{ scale: withTiming(0.35, { duration: 190 }) }],
    },
  };
};
export const glyphIn = web ? ZoomIn.duration(220) : glyphEnter;
export const glyphOut = web ? ZoomOut.duration(150) : glyphExit;
