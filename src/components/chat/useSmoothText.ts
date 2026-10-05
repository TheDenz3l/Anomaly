import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";

/** The backlog drains over about this long, which bridges the server's ~200 ms flushes. */
const LAG_S = 0.32;
/** Once the reply ends, whatever is left plays out quickly. */
const FINISH_S = 0.2;
const MIN_CPS = 40;

/**
 * Reveals streamed text a few characters per frame instead of a chunk per network update. The rate
 * follows the backlog, so fast models stay close behind and slow ones never stall mid-word.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(() => (streaming ? 0 : text.length));
  const pos = useRef(shown);
  const target = useRef(text.length);
  const live = useRef(streaming);
  const frame = useRef<number | null>(null);
  const lastT = useRef(0);

  useEffect(() => {
    target.current = text.length;
    live.current = streaming;
    if (reduced || pos.current > text.length) {
      pos.current = text.length;
      setShown(text.length);
      return;
    }
    if (frame.current !== null || pos.current >= text.length) return;
    lastT.current = 0;
    const step = (t: number) => {
      const dt = lastT.current ? Math.min((t - lastT.current) / 1000, 0.1) : 1 / 60;
      lastT.current = t;
      const backlog = target.current - pos.current;
      const cps = Math.max(MIN_CPS, backlog / (live.current ? LAG_S : FINISH_S));
      pos.current = Math.min(target.current, pos.current + cps * dt);
      const n = Math.floor(pos.current);
      setShown((s) => (s === n ? s : n));
      frame.current = pos.current < target.current ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
  }, [text, streaming, reduced]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    []
  );

  return reduced ? text : text.slice(0, shown);
}
