import { Linking, View } from "react-native";
import { Favicon } from "@/components/ui/Favicon";
import { domainOf } from "@/lib/links";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import type { Source } from "@/lib/types";

const originLabel: Record<Source["origin"], string> = {
  native: "from model web search",
  app: "fetched by Anomaly",
  subagent: "read by a sub-agent",
};

/** Full source entry for sheets: number, favicon, title, snippet, where it came from. */
export function SourceRow({ source, index }: { source: Source; index: number }) {
  return (
    <Tap
      accessibilityRole="link"
      accessibilityHint={`Opens ${domainOf(source.url)}`}
      onPress={() => void Linking.openURL(source.url)}
      className="flex-row gap-3 rounded-2xl px-1 py-3"
    >
      <Text weight="bold" className="w-5 pt-0.5 text-right text-xs text-ink-faint">
        {index}
      </Text>
      <Favicon url={source.url} size={26} />
      <View className="flex-1">
        <Text weight="bold" className="text-[15px] leading-5" numberOfLines={2}>
          {source.title}
        </Text>
        <Text muted className="mt-0.5 text-[13px] leading-[18px]" numberOfLines={2}>
          {source.snippet}
        </Text>
        <Text className="mt-1 text-xs text-ink-faint">
          {domainOf(source.url)}, {originLabel[source.origin]}
        </Text>
      </View>
    </Tap>
  );
}

/** Short publisher name for inline citations: "electricbikereview.com" → "electricbikereview". */
export function shortName(url: string): string {
  const labels = domainOf(url).split(".");
  // The label before the suffix, stepping past short second-level suffixes like "co" or "gc".
  let i = labels.length - 2;
  if (i > 0 && labels[i].length <= 3) i -= 1;
  const name = labels[Math.max(0, i)];
  return name.length > 16 ? `${name.slice(0, 15)}…` : name;
}
