import { createContext, useContext, useState, type ReactNode } from "react";
import { Platform, Pressable, Text as RNText, View } from "react-native";
import { Favicon } from "@/components/ui/Favicon";
import { Sheet } from "@/components/ui/Sheet";
import { publisherName } from "@/lib/citations";
import { colors, fonts } from "@/lib/theme";
import type { Source } from "@/lib/types";
import { SourceRow } from "./SourceRow";

type CitationApi = { sources: Source[]; open: (nums: number[]) => void };

const CitationContext = createContext<CitationApi | null>(null);

/** Gives a reply's text access to its sources, and hosts the sheet a citation opens. */
export function CitationProvider({
  sources,
  children,
}: {
  sources: Source[];
  children: ReactNode;
}) {
  const [nums, setNums] = useState<number[] | null>(null);
  const cited = (nums ?? []).map((n) => ({ n, source: sources[n - 1] })).filter((c) => c.source);
  return (
    <CitationContext.Provider value={{ sources, open: setNums }}>
      {children}
      <Sheet
        open={nums !== null}
        onClose={() => setNums(null)}
        title={cited.length === 1 ? "Source" : `${cited.length} sources`}
        subtitle="Cited for this line of the answer."
      >
        <View className="gap-1">
          {cited.map(({ n, source }) => (
            <SourceRow key={source.id} source={source} index={n} />
          ))}
        </View>
      </Sheet>
    </CitationContext.Provider>
  );
}

const label = {
  fontFamily: fonts.medium,
  fontSize: 12,
  lineHeight: 16,
  color: colors.textMuted,
};

/**
 * Inline citation: the publisher's icon and name in a quiet pill, "+2" when a claim leans on
 * several sources. Tapping it opens exactly those sources. Numbers the reply has no source for
 * show nothing, never a bare "[7]". `hidden` lays it out invisibly, for RichText's underline mask.
 */
export function CitationPill({ nums, hidden }: { nums: number[]; hidden?: boolean }) {
  const ctx = useContext(CitationContext);
  const cited = nums.filter((n) => ctx?.sources[n - 1]);
  if (!ctx || !cited.length) return null;
  const first = ctx.sources[cited[0] - 1];
  const name = publisherName(first.url, first.title);
  const more = cited.length > 1 ? `+${cited.length - 1}` : "";
  const a11y =
    cited.length > 1 ? `Sources: ${name} and ${cited.length - 1} more` : `Source: ${name}`;
  const open = () => ctx.open(cited);

  if (Platform.OS === "web") {
    // On the web a nested span can carry its own padding and radius, so it stays real inline text.
    return (
      <RNText
        accessibilityRole="button"
        accessibilityLabel={a11y}
        onPress={open}
        style={[
          label,
          {
            opacity: hidden ? 0 : 1,
            marginLeft: 5,
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 999,
            backgroundColor: colors.raised,
            cursor: "pointer",
            whiteSpace: "nowrap",
          } as object,
        ]}
      >
        {name}
        {more ? <RNText style={{ color: colors.textFaint }}>{` ${more}`}</RNText> : null}
      </RNText>
    );
  }

  // Native text can't round a nested span, so the pill is an inline view sitting on the baseline,
  // nudged down to centre on the line. The space before it is real text: where the pill wraps,
  // the line break takes the space and the pill starts flush with the text below.
  return (
    <>
      {" "}
      <View
        pointerEvents={hidden ? "none" : "auto"}
        style={{
          opacity: hidden ? 0 : 1,
          transform: [{ translateY: Platform.OS === "ios" ? 3 : 4 }],
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={a11y}
          onPress={open}
          hitSlop={6}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            height: 20,
            paddingLeft: 3,
            paddingRight: 8,
            borderRadius: 10,
            backgroundColor: pressed ? colors.raisedHigh : colors.raised,
          })}
        >
          <Favicon url={first.url} size={14} fill />
          <RNText numberOfLines={1} style={[label, { maxWidth: 76 }]}>
            {name}
          </RNText>
          {more ? <RNText style={[label, { color: colors.textFaint }]}>{more}</RNText> : null}
        </Pressable>
      </View>
    </>
  );
}
