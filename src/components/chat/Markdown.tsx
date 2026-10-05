import { Fragment, type ReactNode, memo } from "react";
import { Text as RNText, View, Linking, ScrollView } from "react-native";
import { Text } from "@/components/ui/Text";
import { CitationPill } from "./Citations";
import { useSmoothText } from "./useSmoothText";

/** Drops a trailing unmatched `**` so half-streamed bold doesn't flash raw asterisks. */
function balance(text: string): string {
  const count = (text.match(/\*\*/g) ?? []).length;
  if (count % 2 === 0) return text;
  const i = text.lastIndexOf("**");
  return text.slice(0, i) + text.slice(i + 2);
}

const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/;

function inline(text: string, keyBase: string): ReactNode[] {
  return balance(text)
    .split(
      /(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*]+\*\*|\*[^*\s][^*\n]*?\*|`[^`]+`|(?:\s?\[\d+\])+)/g
    )
    .filter(Boolean)
    .map((seg, i) => {
      const key = `${keyBase}-${i}`;
      const link = seg.match(LINK);
      if (link) {
        const url = link[2];
        return (
          <RNText
            key={key}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(url)}
            className="text-primary-strong"
          >
            {link[1]}
          </RNText>
        );
      }
      if (seg.startsWith("**") && seg.endsWith("**") && seg.length > 4) {
        return (
          <RNText key={key} className="font-body-bold text-ink">
            {seg.slice(2, -2)}
          </RNText>
        );
      }
      if (seg.startsWith("*") && seg.endsWith("*") && seg.length > 2) {
        return (
          <RNText key={key} className="font-body-italic text-ink">
            {seg.slice(1, -1)}
          </RNText>
        );
      }
      if (seg.startsWith("`") && seg.endsWith("`")) {
        return (
          <RNText key={key} className="font-body-medium text-[14px] text-primary-strong">
            {seg.slice(1, -1)}
          </RNText>
        );
      }
      if (/^(\s?\[\d+\])+$/.test(seg)) {
        const nums = [...seg.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
        return <CitationPill key={key} nums={nums} />;
      }
      return <Fragment key={key}>{seg}</Fragment>;
    });
}

type BlockKind = "heading" | "para" | "list" | "quote" | "table" | "code" | "rule" | "gap";
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
  return out.filter((b) => b.kind !== "gap");
}

function TableView({ raw, index }: { raw: string; index: number }) {
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
                <Text
                  weight={header && ri === 0 ? "bold" : "regular"}
                  className={`text-[14px] leading-5 ${align[ci] === "right" ? "text-right" : ""}`}
                >
                  {inline(r[ci] ?? "", `${index}-${ri}-${ci}`)}
                </Text>
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
}: {
  kind: BlockKind;
  raw: string;
  index: number;
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
  if (kind === "code") {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="rounded-xl bg-card px-3 py-2.5">
          <Text className="text-[13px] leading-5">{raw}</Text>
        </View>
      </ScrollView>
    );
  }
  if (kind === "table") return <TableView raw={raw} index={index} />;
  if (kind === "quote") {
    const lines = raw.split("\n").map((l) => l.replace(/^\s*>\s?/, ""));
    return (
      <View className="gap-1.5 border-l-2 border-raised pl-3">
        {lines
          .filter((l) => l.trim())
          .map((l, li) => (
            <Text key={li} className="text-base leading-[25px]">
              {inline(l, `${index}-${li}`)}
            </Text>
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
              <Text className="flex-1 text-base leading-[25px]">
                {inline(body, `${index}-${li}`)}
              </Text>
            </View>
          );
        })}
      </View>
    );
  }
  return <Text className="text-base leading-[25px]">{inline(raw, String(index))}</Text>;
});

/**
 * Chat Markdown: headings, paragraphs, bullets and numbered lists (nested), quotes, tables, code
 * fences, rules, bold, italic, code, [label](https://…) links and [n] citations. While streaming,
 * text is revealed smoothly and only the block still growing re-renders.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const smooth = useSmoothText(text, streaming);
  // A citation (" [1") or link ("[label](https://ex") still arriving would flash as raw brackets.
  const visible =
    smooth.length < text.length
      ? smooth.replace(/\s?\[\d*$/, "").replace(/\[[^\]\n]*\]\([^)\s]*$/, "")
      : smooth;
  return (
    <View className="gap-2.5">
      {blocks(visible).map((b, bi) => (
        <BlockView key={bi} kind={b.kind} raw={b.raw} index={bi} />
      ))}
    </View>
  );
}
