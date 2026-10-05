import { Fragment, type ReactNode } from "react";
import { Text as RNText, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { CitationPill } from "./Citations";

/** Drops a trailing unmatched `**` so half-streamed bold doesn't flash raw asterisks. */
function balance(text: string): string {
  const count = (text.match(/\*\*/g) ?? []).length;
  if (count % 2 === 0) return text;
  const i = text.lastIndexOf("**");
  return text.slice(0, i) + text.slice(i + 2);
}

function inline(text: string, keyBase: string): ReactNode[] {
  return balance(text)
    .split(/(\*\*[^*]+\*\*|`[^`]+`|(?:\s?\[\d+\])+)/g)
    .filter(Boolean)
    .map((seg, i) => {
      const key = `${keyBase}-${i}`;
      if (seg.startsWith("**") && seg.endsWith("**")) {
        return (
          <RNText key={key} className="font-body-bold text-ink">
            {seg.slice(2, -2)}
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

type Block = { kind: "heading" | "para"; text: string } | { kind: "list"; items: string[] };

/** Splits text into headings, paragraphs and runs of list items (a heading may sit directly above a list). */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      out.push({ kind: "para", text: "" });
    } else if (line.startsWith("### ")) {
      out.push({ kind: "heading", text: line.slice(4) });
    } else if (/^(-|\d+\.)\s/.test(line)) {
      const last = out[out.length - 1];
      if (last?.kind === "list") last.items.push(line);
      else out.push({ kind: "list", items: [line] });
    } else {
      out.push({ kind: "para", text: line });
    }
  }
  return out.filter((b) => b.kind !== "para" || b.text);
}

/** Just enough Markdown for chat: paragraphs, ### headings, bullets, numbered lists, bold, code, [n] citations. */
export function Markdown({ text }: { text: string }) {
  return (
    <View className="gap-2.5">
      {blocks(text).map((b, bi) => {
        if (b.kind === "heading") {
          return (
            <Text
              key={bi}
              weight="bold"
              className={`text-[17px] leading-6 ${bi > 0 ? "mt-2" : ""}`}
            >
              {b.text}
            </Text>
          );
        }
        if (b.kind === "list") {
          return (
            <View key={bi} className="gap-1.5">
              {b.items.map((l, li) => {
                const numbered = /^\d+\./.test(l);
                const marker = numbered ? l.match(/^\d+\./)![0] : "•";
                return (
                  <View key={li} className="flex-row pr-2">
                    <Text
                      muted
                      weight={numbered ? "bold" : "regular"}
                      className="w-5 text-base leading-[25px]"
                    >
                      {marker}
                    </Text>
                    <Text className="flex-1 text-base leading-[25px]">
                      {inline(l.replace(/^(-|\d+\.)\s/, ""), `${bi}-${li}`)}
                    </Text>
                  </View>
                );
              })}
            </View>
          );
        }
        return (
          <Text key={bi} className="text-base leading-[25px]">
            {inline(b.text, String(bi))}
          </Text>
        );
      })}
    </View>
  );
}
