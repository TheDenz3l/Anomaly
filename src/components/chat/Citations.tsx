import { createContext, useContext, useState, type ReactNode } from "react";
import { Platform, Pressable, Text as RNText, View } from "react-native";
import { Sheet } from "@/components/ui/Sheet";
import { colors, fonts } from "@/lib/theme";
import type { Source } from "@/lib/types";
import { shortName, SourceRow } from "./SourceRow";

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

const pill = {
  fontFamily: fonts.medium,
  fontSize: 11,
  lineHeight: 16,
  color: colors.textMuted,
};

/**
 * Inline citation, Perplexity-style: the publisher's name in a quiet pill, "+2" when a claim leans on
 * several sources. Tapping it opens exactly those sources.
 */
export function CitationPill({ nums }: { nums: number[] }) {
  const ctx = useContext(CitationContext);
  const first = ctx?.sources[nums[0] - 1];
  const label =
    (first ? shortName(first.url) : String(nums[0])) +
    (nums.length > 1 ? ` +${nums.length - 1}` : "");
  const a11y = `Sources ${nums.join(", ")}${first ? `, ${shortName(first.url)}` : ""}`;
  const open = () => ctx?.open(nums);

  if (Platform.OS === "web") {
    // On the web a nested span can carry its own padding and radius, so it stays real inline text.
    return (
      <RNText
        accessibilityRole="button"
        accessibilityLabel={a11y}
        onPress={open}
        style={[
          pill,
          {
            marginLeft: 4,
            paddingHorizontal: 7,
            paddingVertical: 1,
            borderRadius: 999,
            backgroundColor: colors.raised,
            cursor: "pointer",
            whiteSpace: "nowrap",
          } as object,
        ]}
      >
        {label}
      </RNText>
    );
  }

  // Native text can't round a nested span, so the pill is an inline view sitting on the baseline.
  return (
    <View style={{ paddingLeft: 4, transform: [{ translateY: Platform.OS === "ios" ? 3 : 4 }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11y}
        onPress={open}
        hitSlop={6}
        style={({ pressed }) => ({
          paddingHorizontal: 7,
          height: 18,
          justifyContent: "center",
          borderRadius: 9,
          backgroundColor: pressed ? colors.raisedHigh : colors.raised,
        })}
      >
        <RNText style={pill}>{label}</RNText>
      </Pressable>
    </View>
  );
}
