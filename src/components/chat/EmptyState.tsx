import { View } from "react-native";
import Animated from "react-native-reanimated";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Display, Text } from "@/components/ui/Text";
import { enterUp } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { colors } from "@/lib/theme";

const starters: { prompt: string; icon: IconName; builds: string }[] = [
  {
    prompt: "What movies are playing near me?",
    icon: "film-outline",
    builds: "Showtimes and a theatre map",
  },
  {
    prompt: "Show my savings if I add $500 a month",
    icon: "trending-up-outline",
    builds: "A chart you can drag",
  },
  {
    prompt: "Compare Pixel 11 and iPhone 17 using sub-agents",
    icon: "git-network-outline",
    builds: "Parallel workers, then a comparison",
  },
  {
    prompt: "What's the weather this weekend?",
    icon: "partly-sunny-outline",
    builds: "Forecast card",
  },
  { prompt: "Packing list for 4 days in Lisbon", icon: "checkbox-outline", builds: "Checklist" },
  {
    prompt: "Book a table for Saturday",
    icon: "restaurant-outline",
    builds: "Form that asks before sending",
  },
  { prompt: "Remember that I'm vegetarian", icon: "sparkles-outline", builds: "Saves to memory" },
];

export function EmptyState() {
  const send = useApp((s) => s.send);
  const setResearchMode = useApp((s) => s.setResearchMode);
  const incognito = useApp((s) => s.draft.incognito);

  return (
    <View className="flex-1 pt-6">
      <Animated.View entering={enterUp(0)}>
        <Display className="text-[44px] leading-[52px]">Atlas</Display>
      </Animated.View>
      <Animated.View entering={enterUp(1)}>
        <Text muted className="mt-1 text-[17px] leading-6">
          {incognito
            ? "Incognito. Nothing here is remembered."
            : "Ask in words. Get answers you can tap, drag and edit."}
        </Text>
      </Animated.View>

      <View className="mt-8">
        {starters.map((s, i) => (
          <Animated.View key={s.prompt} entering={enterUp(i + 2)}>
          <Tap
            accessibilityRole="button"
            accessibilityHint={s.builds}
            onPress={() => send(s.prompt, [])}
            className="flex-row items-center gap-3.5 border-b border-hairline py-3.5"
          >
            <Icon name={s.icon} size={20} color={colors.textMuted} />
            <View className="flex-1">
              <Text weight="medium" className="text-base leading-[22px]">
                {s.prompt}
              </Text>
              <Text className="text-[13px] text-ink-faint">{s.builds}</Text>
            </View>
          </Tap>
          </Animated.View>
        ))}
        <Animated.View entering={enterUp(starters.length + 2)}>
        <Tap
          accessibilityRole="button"
          onPress={() => {
            setResearchMode(true);
            send("Research the best e-bikes under $2,000 for commuting", []);
          }}
          className="flex-row items-center gap-3.5 py-3.5"
        >
          <Icon name="telescope-outline" size={20} color={colors.primary} />
          <View className="flex-1">
            <Text weight="medium" className="text-base leading-[22px] text-primary-strong">
              Research the best e-bikes under $2,000
            </Text>
            <Text className="text-[13px] text-ink-faint">
              Deep research: clarify, plan, search, verify
            </Text>
          </View>
        </Tap>
        </Animated.View>
      </View>
    </View>
  );
}
