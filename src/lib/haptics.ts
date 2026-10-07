import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/**
 * Reply haptics. As a reply starts appearing, a light tick per word for a moment; the ticks then
 * thin out over a couple of seconds and stop, even though the text keeps coming. When the reply is
 * done and its last words are on screen, one soft tap.
 */
const ios = Platform.OS === "ios";
/** Full-rate ticking, then the fade: the gap between ticks eases from TICK_MS out to FADE_GAP_MS. */
const FULL_MS = 900;
const FADE_MS = 1800;
const TICK_MS = 70;
const FADE_GAP_MS = 480;

/** When this reply's ticks began; 0 until its first word appears. */
let started = 0;
let lastTick = 0;
let revealing = 0;
let landPending = false;
let chatVisible = true;

/** A word appeared on screen. */
export function typingTick() {
  if (!ios || !chatVisible) return;
  const now = Date.now();
  if (!started) started = now;
  const t = now - started;
  if (t > FULL_MS + FADE_MS) return;
  const fade = Math.max(0, (t - FULL_MS) / FADE_MS);
  // Ease in: the ticks spread out slowly at first, then quickly, so they trail off.
  const gap = TICK_MS + (FADE_GAP_MS - TICK_MS) * fade * fade;
  if (now - lastTick < gap) return;
  lastTick = now;
  void Haptics.selectionAsync();
}

function land() {
  landPending = false;
  if (ios && chatVisible) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
}

/** A reply's text started appearing on screen. */
export function revealStarted() {
  revealing++;
}

/** The text that has arrived so far is all on screen. */
export function revealEnded() {
  revealing = Math.max(0, revealing - 1);
  if (revealing === 0 && landPending) land();
}

/**
 * The reply stopped streaming. A finished reply taps once its text has played out; a stopped or
 * failed one ends quietly. Either way the next reply starts its ticks afresh.
 */
export function replyEnded(finished: boolean) {
  started = 0;
  if (!finished) landPending = false;
  else if (revealing > 0) landPending = true;
  else land();
}

export function setChatVisible(visible: boolean) {
  chatVisible = visible;
  if (!visible) landPending = false;
}

/**
 * Incognito switched. On is a firm click and a soft settle, a switch pressed home; off is one
 * light tap, so the two read apart without looking.
 */
export function incognitoToggled(on: boolean) {
  if (!ios) return;
  if (!on) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
  setTimeout(() => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft), 90);
}
