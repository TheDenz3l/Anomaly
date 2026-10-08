import * as Clipboard from "expo-clipboard";
import * as Speech from "expo-speech";
import { useEffect, useState } from "react";
import { Share, View } from "react-native";
import Animated from "react-native-reanimated";
import { Favicon } from "@/components/ui/Favicon";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Sheet } from "@/components/ui/Sheet";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { reportText, tableMarkdown } from "@/lib/artifacts";
import { fadeIn, popIn } from "@/lib/motion";
import { findModel, useApp } from "@/lib/store";
import { colors } from "@/lib/theme";
import type { Message, Source } from "@/lib/types";
import { SourceRow } from "./SourceRow";

/** Plain text for copy, share and speech. Components contribute their fallbackText (PRD §3.3). */
export function plainText(message: Message): string {
  return message.parts
    .map((p) =>
      p.type === "text"
        ? p.text.replace(/\*\*/g, "").replace(/\s?\[\d+\]/g, "")
        : p.type === "component"
          ? (p.name === "Table" && tableMarkdown(p.props)) || p.fallbackText
          : ""
    )
    .filter(Boolean)
    .join("\n\n");
}

function ActionIcon({
  icon,
  label,
  onPress,
  active,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      className="h-8 w-[30px] items-center justify-center rounded-full"
    >
      <Icon name={icon} size={17} color={active ? colors.primary : colors.textMuted} />
    </Tap>
  );
}

function tokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Always last in a reply: stacked favicons, "N sources", then share/save/regenerate/copy (PRD §3.2). */
export function SourcesBar({ message, sources }: { message: Message; sources: Source[] }) {
  const [open, setOpen] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const saved = useApp((s) => s.savedMessageIds.includes(message.id));
  const toggleSaved = useApp((s) => s.toggleSaved);
  const regenerate = useApp((s) => s.regenerate);
  const showToast = useApp((s) => s.showToast);
  const models = useApp((s) => s.models);
  const busy = useApp((s) => s.streaming !== null);
  const model = message.meta ? findModel(models, message.meta.modelRef) : null;

  useEffect(() => () => void Speech.stop(), []);

  const copy = async () => {
    await Clipboard.setStringAsync(plainText(message));
    showToast("Copied");
  };

  const share = async () => {
    try {
      await Share.share({ message: plainText(message) });
    } catch {
      await copy();
    }
  };

  const speak = () => {
    if (speaking) {
      void Speech.stop();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    Speech.speak(plainText(message), {
      onDone: () => setSpeaking(false),
      onStopped: () => setSpeaking(false),
      onError: () => setSpeaking(false),
    });
  };

  const exportReport = async () => {
    const body = reportText(message);
    const refs = sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.url}`).join("\n");
    await Clipboard.setStringAsync(`${body}\n\n## Sources\n${refs}`);
    showToast("Report copied as Markdown");
  };

  const level = message.meta && message.meta.levelSent !== "off" ? message.meta.levelSent : null;

  return (
    <Animated.View entering={fadeIn} className="gap-1.5">
      <View className="flex-row items-center">
        {sources.length > 0 ? (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`${sources.length} sources`}
            onPress={() => setOpen(true)}
            className="mr-1 flex-row items-center gap-2 rounded-full bg-raised py-1 pl-1 pr-3"
          >
            <View className="flex-row">
              {sources.slice(0, 3).map((s, i) => (
                <Animated.View
                  key={s.id}
                  entering={popIn.delay(80 + i * 70)}
                  style={{ marginLeft: i === 0 ? 0 : -7, zIndex: 10 - i }}
                >
                  <Favicon url={s.url} size={22} ring />
                </Animated.View>
              ))}
            </View>
            <Text weight="bold" className="text-[13px]">
              {sources.length} sources
            </Text>
          </Tap>
        ) : null}
        <View className="flex-1" />
        {message.meta?.kind === "report" ? (
          <ActionIcon icon="download-outline" label="Export report" onPress={exportReport} />
        ) : null}
        <ActionIcon
          icon={speaking ? "stop-circle-outline" : "volume-medium-outline"}
          label={speaking ? "Stop reading" : "Read aloud"}
          onPress={speak}
          active={speaking}
        />
        <ActionIcon icon="share-outline" label="Share" onPress={share} />
        <ActionIcon
          icon={saved ? "bookmark" : "bookmark-outline"}
          label={saved ? "Unsave" : "Save"}
          onPress={() => toggleSaved(message.id)}
          active={saved}
        />
        <ActionIcon
          icon="refresh"
          label="Regenerate"
          onPress={() => !busy && regenerate(message.id)}
        />
        <ActionIcon icon="copy-outline" label="Copy" onPress={copy} />
      </View>
      {message.meta ? (
        <View className="flex-row items-center gap-1.5 pl-1">
          {level ? <Icon name="bulb-outline" size={12} color={colors.textFaint} /> : null}
          <Text className="text-xs text-ink-faint">
            {[
              model?.name,
              level
                ? `${level.charAt(0).toUpperCase()}${level.slice(1)} thinking${message.meta.levelRequested === "auto" ? " (auto)" : ""}`
                : null,
              message.meta.reasoningTokens > 0
                ? `${tokens(message.meta.reasoningTokens)} reasoning tokens`
                : null,
            ]
              .filter(Boolean)
              .join(", ")}
          </Text>
        </View>
      ) : null}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={`${sources.length} sources`}
        subtitle="Merged across web search, Anomaly’s own fetches and sub-agents. Every citation in the answer points to one of these."
      >
        <View className="gap-1">
          {sources.map((s, i) => (
            <SourceRow key={s.id} source={s} index={i + 1} />
          ))}
        </View>
      </Sheet>
    </Animated.View>
  );
}
