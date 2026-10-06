import { useEffect, useRef, useState, type Ref } from "react";
import {
  Platform,
  Text as RNText,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { LinkIcon } from "@/components/ui/LinkIcon";
import { domainOf, fetchLinkTitle, linkMarkup, parseLinks } from "@/lib/links";
import { colors, fonts } from "@/lib/theme";

type Selection = { start: number; end: number };

type Props = Omit<TextInputProps, "value" | "onChangeText" | "children" | "style" | "selection"> & {
  /** Raw text: links are Markdown, `[Page title](url)`. */
  value: string;
  onChangeValue: (raw: string) => void;
  ref?: Ref<TextInput>;
};

const web = Platform.OS === "web";
const ICON = 17;
/** No-break spaces hold the icon's place in front of a link title and keep the two on one line. */
const SLOT = "\u00A0".repeat(5);

/** One run of the display text and the raw text it stands for. */
type Piece = {
  text: string;
  raw: string;
  start: number;
  rawStart: number;
  url?: string;
};

function layout(raw: string): Piece[] {
  let start = 0;
  let rawStart = 0;
  return parseLinks(raw, false).map((s) => {
    const piece: Piece =
      s.type === "link"
        ? { text: SLOT + s.title, raw: s.raw, start, rawStart, url: s.url }
        : { text: s.text, raw: s.text, start, rawStart };
    start += piece.text.length;
    rawStart += piece.raw.length;
    return piece;
  });
}

const joined = (pieces: Piece[]) => pieces.map((p) => p.text).join("");

/** Raw offset for a display offset; inside a link it snaps to the nearer edge. */
function toRaw(pieces: Piece[], at: number): number {
  for (const p of pieces) {
    if (at > p.start + p.text.length) continue;
    if (!p.url) return p.rawStart + (at - p.start);
    return at - p.start < p.text.length / 2 ? p.rawStart : p.rawStart + p.raw.length;
  }
  const last = pieces[pieces.length - 1];
  return last ? last.rawStart + last.raw.length : 0;
}

function toDisplay(pieces: Piece[], rawAt: number): number {
  for (const p of pieces) {
    if (rawAt > p.rawStart + p.raw.length) continue;
    if (!p.url) return p.start + (rawAt - p.rawStart);
    return rawAt === p.rawStart ? p.start : p.start + p.text.length;
  }
  return joined(pieces).length;
}

/**
 * Bare URLs become links once they are finished: followed by whitespace, or anywhere in a paste.
 * Each starts with its domain as the title until the page's real title arrives.
 */
function autolink(raw: string, pasted: [number, number] | null): { raw: string; urls: string[] } {
  const urls: string[] = [];
  let out = "";
  let at = 0;
  for (const s of parseLinks(raw)) {
    const source = s.type === "text" ? s.text : s.raw;
    const end = at + source.length;
    const finished =
      s.type === "link" &&
      !s.title &&
      (/\s/.test(raw[end] ?? "") || (pasted !== null && at >= pasted[0] && end <= pasted[1]));
    if (finished) {
      out += linkMarkup(domainOf(s.url), s.url);
      urls.push(s.url);
    } else out += source;
    at = end;
  }
  return { raw: out, urls };
}

/**
 * The composer's text field. Pasted links turn into the site's icon plus the page title, in blue,
 * and behave as one unit: backspace removes the whole link, typing inside one lands after it.
 * Native draws the styled text in the TextInput itself and lays an invisible copy on top only to
 * place the icons; web can't style a textarea, so its text is drawn by that copy instead.
 */
/**
 * A link in the invisible copy. The icon hangs off a zero-width anchor after the slot's first
 * no-break space, which keeps it on the same line as the title; web also needs nowrap for that.
 */
function MirrorLink({ text, url, visible }: { text: string; url: string; visible: boolean }) {
  const [, head = text, tail = ""] = text.match(/^(\u00A0+\S*)([\s\S]*)$/) ?? [];
  return (
    <RNText style={visible ? styles.link : undefined}>
      <RNText style={styles.keep}>
        {head.charAt(0)}
        <View style={styles.slot}>
          <View style={styles.icon}>
            <LinkIcon url={url} size={ICON} />
          </View>
        </View>
        {head.slice(1)}
      </RNText>
      {tail}
    </RNText>
  );
}

export function LinkInput({ value, onChangeValue, onSelectionChange, ref, ...rest }: Props) {
  const pieces = layout(value);
  const display = joined(pieces);
  const hasLinks = pieces.some((p) => p.url);
  const selection = useRef<Selection | null>(null);
  const [forced, setForced] = useState<Selection | undefined>();
  const [scrollY, setScrollY] = useState(0);
  // iOS keeps a multiline field at its tallest when its text is cleared from outside (a sent
  // message), so a clear that didn't come from typing gives the field a fresh native view.
  const [typed, setTyped] = useState(value);
  const [generation, setGeneration] = useState(0);
  if (value !== typed) {
    setTyped(value);
    if (value === "") setGeneration((g) => g + 1);
  }
  const latest = useRef({ value, onChangeValue });
  useEffect(() => {
    latest.current = { value, onChangeValue };
  });

  const place = (at: number) => setForced({ start: at, end: at });

  /** Swaps a link's provisional domain title for the page title, keeping the caret beside the same text. */
  const resolve = (url: string) => {
    void fetchLinkTitle(url).then((title) => {
      if (!title) return;
      const { value: current, onChangeValue: commit } = latest.current;
      const from = linkMarkup(domainOf(url), url);
      const to = linkMarkup(title, url);
      if (from === to || !current.includes(from)) return;
      const next = current.split(from).join(to);
      commit(next);
      const sel = selection.current;
      if (!sel) return;
      const rawCaret = toRaw(layout(current), sel.start);
      const before = current.slice(0, rawCaret).split(from).length - 1;
      place(toDisplay(layout(next), rawCaret + before * (to.length - from.length)));
    });
  };

  const onChangeText = (next: string) => {
    const prev = display;
    const sel = selection.current;
    const delta = next.length - prev.length;
    let a: number;
    let b: number;
    let inserted: string;
    if (
      sel &&
      sel.start === sel.end &&
      delta < 0 &&
      sel.start + delta >= 0 &&
      prev.slice(0, sel.start + delta) + prev.slice(sel.start) === next
    ) {
      a = sel.start + delta;
      b = sel.start;
      inserted = "";
    } else if (
      sel &&
      sel.start === sel.end &&
      delta > 0 &&
      prev.slice(0, sel.start) +
        next.slice(sel.start, sel.start + delta) +
        prev.slice(sel.start) ===
        next
    ) {
      a = sel.start;
      b = sel.start;
      inserted = next.slice(sel.start, sel.start + delta);
    } else {
      const max = Math.min(prev.length, next.length);
      a = 0;
      while (a < max && prev[a] === next[a]) a++;
      let endPrev = prev.length;
      let endNext = next.length;
      while (endPrev > a && endNext > a && prev[endPrev - 1] === next[endNext - 1]) {
        endPrev--;
        endNext--;
      }
      b = endPrev;
      inserted = next.slice(a, endNext);
    }

    for (const p of pieces) {
      if (!p.url) continue;
      const end = p.start + p.text.length;
      if (b > a && a < end && b > p.start) {
        a = Math.min(a, p.start);
        b = Math.max(b, end);
      } else if (b === a && a > p.start && a < end) {
        a = end;
        b = end;
      }
    }

    const ra = toRaw(pieces, a);
    const rb = toRaw(pieces, b);
    const edited = value.slice(0, ra) + inserted + value.slice(rb);
    const { raw, urls } = autolink(edited, inserted.length > 1 ? [ra, ra + inserted.length] : null);
    setTyped(raw);
    onChangeValue(raw);
    const shown = joined(layout(raw));
    if (shown !== next) place(Math.max(0, shown.length - (prev.length - b)));
    urls.forEach(resolve);
  };

  const mirror = (visible: boolean) => (
    <RNText style={[styles.text, !visible && styles.clear]}>
      {pieces.map((p, i) =>
        p.url ? <MirrorLink key={i} text={p.text} url={p.url} visible={visible} /> : p.text
      )}
      {visible ? "\u200B" : null}
    </RNText>
  );

  const shared = {
    ...rest,
    ref,
    multiline: true,
    onChangeText,
    selection: forced,
    onSelectionChange: (e: Parameters<NonNullable<TextInputProps["onSelectionChange"]>>[0]) => {
      selection.current = e.nativeEvent.selection;
      if (forced) setForced(undefined);
      onSelectionChange?.(e);
    },
  };

  if (web) {
    return (
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.box}>
          <View
            pointerEvents="none"
            aria-hidden
            importantForAccessibility="no-hide-descendants"
            style={styles.pad}
          >
            {mirror(true)}
          </View>
          <TextInput
            {...shared}
            value={display}
            style={[styles.text, styles.pad, StyleSheet.absoluteFill, styles.webInput] as never}
          />
        </View>
      </ScrollView>
    );
  }

  return (
    <View>
      <TextInput
        key={generation}
        {...shared}
        onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
        style={[styles.text, styles.pad, styles.nativeInput]}
      >
        {pieces.map((p, i) => (
          <RNText key={i} style={p.url ? styles.link : undefined}>
            {p.text}
          </RNText>
        ))}
      </TextInput>
      {hasLinks ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[StyleSheet.absoluteFill, styles.clip]}
        >
          <View style={[styles.pad, { transform: [{ translateY: -scrollY }] }]}>
            {mirror(false)}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  text: { fontFamily: fonts.body, fontSize: 16, lineHeight: 22, color: colors.text },
  clear: { color: "transparent" },
  link: { color: colors.link },
  pad: { paddingHorizontal: 12, paddingTop: 11, paddingBottom: 9 },
  nativeInput: { minHeight: 44, maxHeight: 140 },
  scroll: { maxHeight: 140, flexGrow: 0 },
  box: { minHeight: 44 },
  webInput: {
    color: "transparent",
    caretColor: colors.text,
    outlineStyle: "none",
    resize: "none",
    overflow: "hidden",
  } as object,
  clip: { overflow: "hidden" },
  keep: (web ? { whiteSpace: "nowrap" } : {}) as object,
  /** Zero-width, so the copy wraps exactly like the input. */
  slot: { width: 0, height: ICON - 3 },
  icon: { position: "absolute", left: -4, top: 0 },
});
