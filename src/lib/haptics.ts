import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/**
 * Reply haptics: a light tick as words appear, spaced wider while the reply winds down, then one
 * soft tap once the last of the text is on screen. Silent off the chat screen.
 */
const ios = Platform.OS === "ios";
let lastTick = 0;
let revealing = 0;
let landPending = false;
let chatVisible = true;

/** Typing tick, at most one per `spacing` ms. */
export function typingTick(spacing: number) {
  const now = Date.now();
  if (!ios || !chatVisible || now - lastTick < spacing) return;
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

/** The reply is complete; tap once its text has finished appearing. */
export function replyFinished() {
  if (revealing > 0) landPending = true;
  else land();
}

export function setChatVisible(visible: boolean) {
  chatVisible = visible;
  if (!visible) landPending = false;
}
