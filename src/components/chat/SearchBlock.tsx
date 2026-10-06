import { useState } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import { Favicon } from "@/components/ui/Favicon";
import { domainOf, openLink } from "@/lib/links";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { fadeIn, fadeOut, popIn } from "@/lib/motion";
import { colors } from "@/lib/theme";
import type { SearchPart } from "@/lib/types";
import { ActivityRow, Rail } from "./Activity";

const FIRST = 6;

function label(part: SearchPart): string {
  if (part.phase === "searching") return "Searching the web";
  if (part.phase === "reading")
    return part.sources.length ? `Reading ${part.sources.length} sources` : "Reading sources";
  return "Searched the web";
}

/**
 * The search step, inline above the answer: what was searched and which pages came back, in the
 * order they arrived. Open while it runs so you can watch it work; folds away once the answer starts.
 */
export function SearchBlock({ part, animate }: { part: SearchPart; animate: boolean }) {
  const live = part.phase !== "done";
  const [choice, setChoice] = useState<boolean | null>(null);
  const [all, setAll] = useState(false);
  const open = choice ?? live;
  const shown = all ? part.sources : part.sources.slice(0, FIRST);
  const hidden = part.sources.length - shown.length;
  const enter = animate ? fadeIn : undefined;

  return (
    <View>
      <ActivityRow
        orb="searching"
        live={live}
        label={label(part)}
        doneIcon="globe-outline"
        expanded={open}
        onToggle={() => setChoice(!open)}
        trailing={
          !open && part.sources.length > 0 ? (
            <View className="ml-0.5 flex-row items-center gap-1.5">
              <View className="flex-row">
                {part.sources.slice(0, 3).map((s, i) => (
                  <Animated.View
                    key={s.id}
                    entering={animate ? popIn : undefined}
                    style={{ marginLeft: i === 0 ? 0 : -5, zIndex: 3 - i }}
                  >
                    <Favicon url={s.url} size={16} ring />
                  </Animated.View>
                ))}
              </View>
              <Text className="text-[13px] text-ink-faint">{part.sources.length}</Text>
            </View>
          ) : null
        }
      />
      {open ? (
        <Animated.View entering={animate ? undefined : fadeIn} exiting={fadeOut}>
          <Rail>
            {part.queries.map((q) => (
              <Animated.View
                key={q}
                entering={enter}
                className="flex-row items-center gap-2.5 py-1.5"
              >
                <Icon name="search" size={14} color={colors.textFaint} />
                <Text muted className="flex-1 text-[14px] leading-5" numberOfLines={1}>
                  {q}
                </Text>
              </Animated.View>
            ))}
            {shown.map((s) => (
              <Animated.View key={s.id} entering={enter}>
                <Tap
                  accessibilityRole="link"
                  accessibilityLabel={`${s.title}, ${domainOf(s.url)}`}
                  onPress={() => void openLink(s.url)}
                  className="flex-row items-center gap-2.5 py-1.5"
                >
                  <Favicon url={s.url} size={16} />
                  <Text className="flex-1 text-[14px] leading-5 text-ink/80" numberOfLines={1}>
                    {s.title}
                  </Text>
                </Tap>
              </Animated.View>
            ))}
            {hidden > 0 || all ? (
              <Tap
                accessibilityRole="button"
                onPress={() => setAll(!all)}
                className="self-start py-1.5"
              >
                <Text weight="medium" className="text-[14px] text-ink-faint">
                  {all ? "Show less" : `Show ${hidden} more`}
                </Text>
              </Tap>
            ) : null}
          </Rail>
        </Animated.View>
      ) : null}
    </View>
  );
}
