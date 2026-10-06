import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";
import { revealEnded, revealStarted, typingTick } from "@/lib/haptics";

/** While streaming, the reveal trails the model by about this long, bridging the server's flushes. */
const LAG_S = 0.9;
const MIN_CPS = 28;
/** Reading pace: about 20 words a second, however fast the model writes. */
const MAX_CPS = 110;
/** Only a large backlog lifts the cap, so the text never falls more than a few seconds behind. */
const CATCH_UP_S = 3;
/** After the reply ends, the rest plays out over about this long, easing into the last word. */
const FINISH_S = 0.8;
const FINISH_MIN_CPS = 70;

/**
 * Reveals streamed text a few characters per frame instead of a chunk per network update. The
 * reveal trails the model at a steady reading pace (catching up only when far behind), then plays
 * out the rest with an easing finish. New words feed the reply haptics.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(() => (streaming ? 0 : text.length));
  const pos = useRef(shown);
  const target = useRef(text.length);
  const source = useRef(text);
  const live = useRef(streaming);
  const frame = useRef<number | null>(null);
  const lastT = useRef(0);

  useEffect(() => {
    target.current = text.length;
    source.current = text;
    live.current = streaming;
    if (reduced || pos.current > text.length) {
      pos.current = text.length;
      setShown(text.length);
      return;
    }
    if (frame.current !== null || pos.current >= text.length) return;
    lastT.current = 0;
    revealStarted();
    const step = (t: number) => {
      const dt = lastT.current ? Math.min((t - lastT.current) / 1000, 0.1) : 1 / 60;
      lastT.current = t;
      const backlog = target.current - pos.current;
      const cps = live.current
        ? Math.min(Math.max(MIN_CPS, backlog / LAG_S), Math.max(MAX_CPS, backlog / CATCH_UP_S))
        : Math.max(FINISH_MIN_CPS, backlog / FINISH_S);
      const before = Math.floor(pos.current);
      pos.current = Math.min(target.current, pos.current + cps * dt);
      const n = Math.floor(pos.current);
      if (n > before && /\s/.test(source.current.slice(before, n))) typingTick();
      setShown((s) => (s === n ? s : n));
      if (pos.current < target.current) frame.current = requestAnimationFrame(step);
      else {
        frame.current = null;
        revealEnded();
      }
    };
    frame.current = requestAnimationFrame(step);
  }, [text, streaming, reduced]);

  useEffect(
    () => () => {
      if (frame.current === null) return;
      cancelAnimationFrame(frame.current);
      revealEnded();
    },
    []
  );

  return reduced ? text : text.slice(0, shown);
}
