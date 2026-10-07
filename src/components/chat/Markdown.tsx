import MaskedView from "@react-native-masked-view/masked-view";
import { Fragment, type ReactNode, memo } from "react";
import {
  Text as RNText,
  View,
  ScrollView,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Svg, { Defs, Pattern, Rect } from "react-native-svg";
import { colors, fonts } from "@/lib/theme";
import { IMAGE_URL, ImageGallery, VideoCard, youtubeId, type ImageRef } from "./Media";
import { Text } from "@/components/ui/Text";
import { CitationPill } from "./Citations";
import { useSmoothText } from "./useSmoothText";
import { domainOf, openLink, trimUrl } from "@/lib/links";

/** Drops a trailing unmatched `**` so half-streamed bold doesn't flash raw asterisks. */
function balance(text: string): string {
  const count = (text.match(/\*\*/g) ?? []).length;
  if (count % 2 === 0) return text;
  const i = text.lastIndexOf("**");
  return text.slice(0, i) + text.slice(i + 2);
}

/**
 * The end of a reply still arriving can be half a Markdown construct. Shown raw, it flashes
 * brackets and addresses that then vanish into a link, a photo or a video card. This holds back
 * what can't render yet and keeps what can, so nothing appears and then disappears.
 */
function settle(text: string): string {
  return (
    text
      // A citation still arriving: " [1".
      .replace(/\s?\[\d*$/, "")
      // A photo waits whole; it shows as a picture once its address is complete.
      .replace(/!\[[^\]\n]*(?:\]\([^)\s]*|\])?$/, "")
      // A link still arriving reads as its label, already bold like the link it becomes.
      .replace(/\[([^\]\n]*)(?:\]\([^)\s]*|\])?$/, (all, label: string) =>
        !label ? "" : /^\d+$/.test(label) ? all : `**${label}**`
      )
      // A bare address waits until it is whole: it may become a link, a photo or a video.
      .replace(/(^|\s)(?:https?:\/\/\S*|h(?:t(?:t(?:p(?:s?:?\/{0,2})?)?)?)?)$/, "$1")
      // A "!" opening a photo; one ending a sentence sits against its word and stays.
      .replace(/(^|\s)!$/, "$1")
      // A list item left empty by the above doesn't show as a lone bullet.
      .replace(/(^|\n)\s*(?:[-*+]|\d+[.)])\s*$/, "$1")
  );
}

const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/;
const BARE_URL = /^https?:\/\/[^\s<>()\]]+$/;

/** A bare URL reads as its site and path, shortened: example.com/news/2026/… */
function shortUrl(url: string): string {
  const rest = url.replace(/^https?:\/\/(www\.)?[^/?#]+/, "").replace(/\/$/, "");
  const path = rest.length > 22 ? `${rest.slice(0, 21)}…` : rest;
  return domainOf(url) + path;
}

const ARROW = "\u2009↗";
const HIDE = { color: "transparent" } as const;

/**
 * A link in reply text: bold, with an arrow, opening in the in-app browser. Its dotted underline
 * is drawn by RichText. In a mask it is an opaque block where the dots should show.
 */
function LinkRun({ label, url, mask }: { label: ReactNode; url: string; mask?: boolean }) {
  if (mask) {
    return (
      <RNText style={styles.maskLink}>
        {label}
        <RNText style={styles.maskArrow}>{ARROW}</RNText>
      </RNText>
    );
  }
  return (
    <RNText accessibilityRole="link" onPress={() => void openLink(url)} style={styles.link}>
      {label}
      <RNText style={styles.arrow}>{ARROW}</RNText>
    </RNText>
  );
}

/** `mask` lays the same text out invisibly, with only the link runs filled in. */
function inline(text: string, keyBase: string, mask = false): ReactNode[] {
  return balance(text)
    .split(
      /(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>()\]]+|\*\*[^*]+\*\*|\*[^*\s][^*\n]*?\*|`[^`]+`|(?:\s?\[\d+\])+)/g
    )
    .filter(Boolean)
    .map((seg, i) => {
      const key = `${keyBase}-${i}`;
      const link = seg.match(LINK);
      if (link) return <LinkRun key={key} label={link[1]} url={link[2]} mask={mask} />;
      if (BARE_URL.test(seg)) {
        const url = trimUrl(seg);
        return (
          <Fragment key={key}>
            <LinkRun label={shortUrl(url)} url={url} mask={mask} />
            {seg.slice(url.length)}
          </Fragment>
        );
      }
      // Emphasis can wrap a link or a citation (models often bold a whole "[title](url)"), so its
      // contents go through the same pass.
      if (seg.startsWith("**") && seg.endsWith("**") && seg.length > 4) {
        return (
          <RNText key={key} className="font-body-bold text-ink" style={mask ? HIDE : undefined}>
            {inline(seg.slice(2, -2), key, mask)}
          </RNText>
        );
      }
      if (seg.startsWith("*") && seg.endsWith("*") && seg.length > 2) {
        return (
          <RNText key={key} className="font-body-italic text-ink" style={mask ? HIDE : undefined}>
            {inline(seg.slice(1, -1), key, mask)}
          </RNText>
        );
      }
      if (seg.startsWith("`") && seg.endsWith("`")) {
        return (
          <RNText
            key={key}
            className="font-body-medium text-[14px] text-primary-strong"
            style={mask ? HIDE : undefined}
          >
            {seg.slice(1, -1)}
          </RNText>
        );
      }
      if (/^(\s?\[\d+\])+$/.test(seg)) {
        const nums = [...seg.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
        return mask ? (
          <View key={key} style={{ opacity: 0 }}>
            <CitationPill nums={nums} />
          </View>
        ) : (
          <CitationPill key={key} nums={nums} />
        );
      }
      return <Fragment key={key}>{seg}</Fragment>;
    });
}

/**
 * The dots sit this far below where iOS draws a plain underline, level with the descenders.
 * Sizes are whole pixels at 3x, so every dot renders the same.
 */
const DOT_BAND = [2, 2 + 1 / 3];
const DOT_STEP = 10 / 3;
const DOT_SIZE = 4 / 3;
const HAS_LINK = /\]\(https?:\/\/|https?:\/\//;

/**
 * Evenly spaced dot columns. The mask keeps only a thin band under each link, which cuts the
 * columns into a row of dots wherever that link's text runs, on every line it wraps to.
 */
function Dots() {
  return (
    <Svg width="100%" height="100%">
      <Defs>
        <Pattern id="dots" patternUnits="userSpaceOnUse" width={DOT_STEP} height={10}>
          <Rect x={0} y={0} width={DOT_SIZE} height={10} fill="rgba(250,250,250,0.6)" />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#dots)" />
    </Svg>
  );
}

function RichText({
  text,
  keyBase,
  className,
  style,
  live = false,
}: {
  text: string;
  keyBase: string;
  className: string;
  style?: StyleProp<ViewStyle>;
  /** Still being written: the dotted underline waits, so the mask isn't redrawn every frame. */
  live?: boolean;
}) {
  // One shape whether or not the text has a link yet, so a link arriving mid-reply doesn't
  // remount the text around it (that remount is the flash).
  return (
    <View style={style}>
      <Text className={className}>{inline(text, keyBase)}</Text>
      {!live && HAS_LINK.test(text) ? (
        <MaskedView
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={StyleSheet.absoluteFill}
          maskElement={
            <View style={StyleSheet.absoluteFill}>
              {DOT_BAND.map((dy) => (
                <Text
                  key={dy}
                  className={className}
                  style={[HIDE, styles.maskCopy, { transform: [{ translateY: dy }] }]}
                >
                  {inline(text, keyBase, true)}
                </Text>
              ))}
            </View>
          }
        >
          <Dots />
        </MaskedView>
      ) : null}
    </View>
  );
}

type BlockKind =
  "heading" | "para" | "list" | "quote" | "table" | "code" | "rule" | "gap" | "images" | "video";
/** `raw` keeps the block's source lines so memoized views skip blocks that stopped changing. */
type Block = { kind: BlockKind; raw: string };

const HEADING = /^\s*(#{1,6})\s+(.*)$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*```/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .replace(/\\\|/g, "\u0000")
    .split("|")
    .map((c) => c.replace(/\u0000/g, "|").trim());
}

/** Splits text into headings, paragraphs, lists, quotes, tables, code fences and rules. */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      out.push({ kind: "code", raw: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      out.push({ kind: "gap", raw: "" });
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: "rule", raw: "" });
      continue;
    }
    if (HEADING.test(line)) {
      out.push({ kind: "heading", raw: line });
      continue;
    }
    const kind: BlockKind = /^\s*\|/.test(line)
      ? "table"
      : /^\s*>/.test(line)
        ? "quote"
        : ITEM.test(line)
          ? "list"
          : "para";
    const last = out[out.length - 1];
    if (kind !== "para" && last?.kind === kind) last.raw += `\n${line}`;
    else out.push({ kind, raw: line });
  }
  return withMedia(out.filter((b) => b.kind !== "gap"));
}

const IMAGE = /!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
const URLS = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<>()\]]+/g;
const ITEM_MARK = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * Lifts media out of the text: Markdown images (and image URLs on their own line) gather into a
 * gallery after their block, consecutive galleries merge, and each YouTube link adds a video card
 * under the block that mentions it. Each image and video shows once per reply.
 */
function withMedia(list: Block[]): Block[] {
  const out: Block[] = [];
  const seenImages = new Set<string>();
  const seenVideos = new Set<string>();
  for (const b of list) {
    if (b.kind === "code" || b.kind === "table" || b.kind === "rule") {
      out.push(b);
      continue;
    }
    const images: ImageRef[] = [];
    const raw = b.raw
      .replace(IMAGE, (_, alt: string, url: string) => {
        images.push({ url, alt });
        return "";
      })
      .split("\n")
      .filter((line) => {
        const t = line.replace(ITEM_MARK, "").trim();
        if (IMAGE_URL.test(t)) {
          images.push({ url: t, alt: "" });
          return false;
        }
        // An item left empty once its image moved to the gallery.
        return !(b.kind === "list" && /^\s*(?:[-*+]|\d+[.)])\s*$/.test(line));
      })
      .join("\n");
    if (raw.trim()) out.push({ kind: b.kind, raw });
    const fresh = images.filter((i) => !seenImages.has(i.url));
    fresh.forEach((i) => seenImages.add(i.url));
    if (fresh.length) {
      const lines = fresh.map((i) => `${i.url}\t${i.alt}`).join("\n");
      const last = out[out.length - 1];
      if (last?.kind === "images") last.raw += `\n${lines}`;
      else out.push({ kind: "images", raw: lines });
    }
    for (const m of raw.matchAll(URLS)) {
      const url = m[2] ?? trimUrl(m[0]);
      const id = youtubeId(url);
      if (!id || seenVideos.has(id)) continue;
      seenVideos.add(id);
      out.push({ kind: "video", raw: `${id}\t${url}\t${m[1] ?? ""}` });
    }
  }
  return out;
}

function TableView({ raw, index, live }: { raw: string; index: number; live: boolean }) {
  const lines = raw.split("\n");
  const sepAt = lines.findIndex((l) => TABLE_SEPARATOR.test(l));
  const align =
    sepAt >= 0 ? cells(lines[sepAt]).map((c) => (/-:$/.test(c) ? "right" : "left")) : [];
  const rows = lines.filter((_, i) => i !== sepAt).map(cells);
  const header = sepAt === 1;
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => {
    const chars = Math.max(...rows.map((r) => (r[c] ?? "").replace(/\*\*|`/g, "").length));
    return Math.min(240, Math.max(84, chars * 7.5 + 28));
  });
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="overflow-hidden rounded-xl border border-raised">
        {rows.map((r, ri) => (
          <View
            key={ri}
            className={`flex-row ${header && ri === 0 ? "bg-raised" : ""} ${ri > 0 ? "border-t border-raised" : ""}`}
          >
            {widths.map((w, ci) => (
              <View
                key={ci}
                style={{ width: w }}
                className={`px-3 py-2 ${ci > 0 ? "border-l border-raised" : ""}`}
              >
                {header && ri === 0 ? (
                  <Text
                    weight="bold"
                    className={`text-[14px] leading-5 ${align[ci] === "right" ? "text-right" : ""}`}
                  >
                    {inline(r[ci] ?? "", `${index}-${ri}-${ci}`)}
                  </Text>
                ) : (
                  <RichText
                    text={r[ci] ?? ""}
                    keyBase={`${index}-${ri}-${ci}`}
                    className={`text-[14px] leading-5 ${align[ci] === "right" ? "text-right" : ""}`}
                    live={live}
                  />
                )}
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const HEADING_SIZE = ["text-[22px] leading-7", "text-[19px] leading-7", "text-[17px] leading-6"];

const BlockView = memo(function BlockView({
  kind,
  raw,
  index,
  live,
}: {
  kind: BlockKind;
  raw: string;
  index: number;
  /** The block still being written, at the end of a reply that is streaming. */
  live: boolean;
}) {
  if (kind === "heading") {
    const [, hashes, text] = raw.match(HEADING)!;
    const size = HEADING_SIZE[hashes.length - 1] ?? "text-base leading-6";
    return (
      <Text weight="bold" className={`${size} ${index > 0 ? "mt-2" : ""}`}>
        {inline(text.replace(/\*\*/g, ""), String(index))}
      </Text>
    );
  }
  if (kind === "rule") return <View className="my-1 h-px bg-raised" />;
  if (kind === "images") {
    const images = raw.split("\n").map((l) => {
      const [url, alt = ""] = l.split("\t");
      return { url, alt };
    });
    return (
      <View className="my-1">
        <ImageGallery images={images} live={live} />
      </View>
    );
  }
  if (kind === "video") {
    const [id, url, label = ""] = raw.split("\t");
    return (
      <View className="my-1">
        <VideoCard id={id} url={url} label={label} />
      </View>
    );
  }
  if (kind === "code") {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="rounded-xl bg-card px-3 py-2.5">
          <Text className="text-[13px] leading-5">{raw}</Text>
        </View>
      </ScrollView>
    );
  }
  if (kind === "table") return <TableView raw={raw} index={index} live={live} />;
  if (kind === "quote") {
    const lines = raw.split("\n").map((l) => l.replace(/^\s*>\s?/, ""));
    return (
      <View className="gap-1.5 border-l-2 border-raised pl-3">
        {lines
          .filter((l) => l.trim())
          .map((l, li) => (
            <RichText
              key={li}
              text={l}
              keyBase={`${index}-${li}`}
              className="text-base leading-[25px]"
              live={live}
            />
          ))}
      </View>
    );
  }
  if (kind === "list") {
    return (
      <View className="gap-1.5">
        {raw.split("\n").map((l, li) => {
          const [, space, mark, body] = l.match(ITEM) ?? ["", "", "-", l];
          const depth = Math.min(3, Math.floor(space.replace(/\t/g, "  ").length / 2));
          const numbered = /^\d/.test(mark);
          return (
            <View key={li} className="flex-row pr-2" style={{ marginLeft: depth * 16 }}>
              <Text
                muted
                weight={numbered ? "bold" : "regular"}
                className={`${numbered ? "w-6" : "w-5"} text-base leading-[25px]`}
              >
                {numbered ? mark.replace(")", ".") : depth ? "◦" : "•"}
              </Text>
              <RichText
                text={body}
                keyBase={`${index}-${li}`}
                className="text-base leading-[25px]"
                style={{ flex: 1 }}
                live={live}
              />
            </View>
          );
        })}
      </View>
    );
  }
  return (
    <RichText text={raw} keyBase={String(index)} className="text-base leading-[25px]" live={live} />
  );
});

/**
 * Chat Markdown: headings, paragraphs, bullets and numbered lists (nested), quotes, tables, code
 * fences, rules, bold, italic, code, [label](https://…) links and [n] citations. While streaming,
 * text is revealed smoothly and only the block still growing re-renders.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const smooth = useSmoothText(text, streaming);
  // More may follow whenever the reply is still streaming, not just while the reveal is behind:
  // the text the server has sent so far can itself stop halfway through a link.
  const growing = streaming || smooth.length < text.length;
  const list = blocks(growing ? settle(smooth) : smooth);
  return (
    <View className="gap-2.5">
      {list.map((b, bi) => (
        <BlockView
          key={bi}
          kind={b.kind}
          raw={b.raw}
          index={bi}
          live={growing && bi === list.length - 1}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  link: { fontFamily: fonts.bold, color: colors.text },
  arrow: { color: colors.textMuted, fontSize: 13 },
  maskLink: {
    fontFamily: fonts.bold,
    color: "transparent",
    textDecorationLine: "underline",
    textDecorationColor: "#000",
  },
  maskArrow: { fontSize: 13, color: "transparent", textDecorationLine: "none" },
  maskCopy: { position: "absolute", top: 0, left: 0, right: 0 },
});
