import { Image } from "expo-image";
import { Animated, View } from "react-native";
import { Icon } from "@/components/ui/Icon";
import { Text } from "@/components/ui/Text";
import { ComponentRenderer } from "@/genui/ComponentRenderer";
import { colors } from "@/lib/theme";
import type { Message, Source } from "@/lib/types";
import { Markdown } from "./Markdown";
import { SourcesBar } from "./SourcesBar";
import { ThinkingBlock, usePulse } from "./ThinkingBlock";

export function UserMessage({ message }: { message: Message }) {
  const event = message.parts.find((p) => p.type === "ui_event");
  if (event && event.type === "ui_event") {
    // Auto-saves are the system acting, not the user — the memory card already shows it.
    if (event.action === "auto_saved") return null;
    return (
      <View
        accessibilityLabel={`You: ${event.label}`}
        className="flex-row items-center justify-end gap-1.5 py-0.5"
      >
        <Icon name="return-down-forward" size={13} color={colors.textFaint} />
        <Text weight="medium" className="text-[13px] text-ink-faint">
          {event.label}
        </Text>
      </View>
    );
  }
  const images = message.parts.filter((p) => p.type === "image");
  const text = message.parts.find((p) => p.type === "text");
  return (
    <View className="items-end gap-1.5">
      {images.length > 0 ? (
        <View className="flex-row flex-wrap justify-end gap-1.5">
          {images.map((p) =>
            p.type === "image" ? (
              <Image
                key={p.id}
                source={{ uri: p.uri }}
                accessibilityLabel="Attached photo"
                style={{
                  width: images.length > 1 ? 120 : 200,
                  height: images.length > 1 ? 120 : 200 * ((p.height ?? 3) / (p.width ?? 4)),
                  borderRadius: 18,
                }}
                contentFit="cover"
              />
            ) : null
          )}
        </View>
      ) : null}
      {text && text.type === "text" ? (
        <View className="max-w-[82%] rounded-[22px] rounded-br-md bg-primary px-4 py-2.5">
          <Text className="text-base leading-6 text-white">{text.text}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Working() {
  const pulse = usePulse(true);
  return (
    <Animated.View accessibilityLabel="Working" style={{ opacity: pulse }}>
      <View className="flex-row items-center gap-2 py-1">
        <View className="h-2 w-2 rounded-full bg-primary" />
        <Text weight="medium" muted className="text-sm">
          Working
        </Text>
      </View>
    </Animated.View>
  );
}

/** Assistant replies have no bubble: text on black, components on surface cards (PRD §2.4). */
export function AssistantMessage({ message, last }: { message: Message; last: boolean }) {
  const streaming = message.status === "streaming";
  const sources: Source[] = [];
  for (const p of message.parts) if (p.type === "sources") sources.push(...p.sources);
  const seen = new Set<string>();
  const unique = sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
  const visible = message.parts.filter((p) => p.type !== "sources");

  return (
    <View className="gap-3.5">
      {visible.length === 0 && streaming ? <Working /> : null}
      {visible.map((p) => {
        switch (p.type) {
          case "thinking":
            return <ThinkingBlock key={p.id} part={p} />;
          case "text":
            return <Markdown key={p.id} text={p.text} />;
          case "component":
            return (
              <ComponentRenderer
                key={p.id}
                part={p}
                threadId={message.threadId}
                messageStreaming={streaming}
              />
            );
          default:
            return null;
        }
      })}
      {message.status === "stopped" ? (
        <View className="flex-row items-center gap-1.5">
          <Icon name="stop-circle-outline" size={14} color={colors.textFaint} />
          <Text className="text-[13px] text-ink-faint">Stopped</Text>
        </View>
      ) : null}
      {!streaming ? <SourcesBar message={message} sources={unique} /> : null}
      {last ? null : <View className="h-1" />}
    </View>
  );
}
