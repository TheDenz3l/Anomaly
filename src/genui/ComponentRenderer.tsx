import { useState, type ComponentType } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import { Icon } from "@/components/ui/Icon";
import { Text } from "@/components/ui/Text";
import { cardIn } from "@/lib/motion";
import { useApp, useComponentEvents } from "@/lib/store";
import { colors } from "@/lib/theme";
import type { ComponentPart } from "@/lib/types";
import { catalogComponents } from "./components";
import { GenSkeleton, type GenProps } from "./kit";
import type { CatalogName } from "./schemas";

const registry = catalogComponents as Record<CatalogName, ComponentType<GenProps<CatalogName>>>;

type Props = { part: ComponentPart; threadId: string; messageStreaming: boolean };

/**
 * Validates and hydrates a tool call into a native component. Skeleton while arguments stream,
 * a readable fallback if validation fails — never model-generated code.
 */
export function ComponentRenderer({ part, threadId, messageStreaming }: Props) {
  const events = useComponentEvents(threadId, part.id);
  const busy = useApp((s) => s.streaming !== null);
  const emitUiEvent = useApp((s) => s.emitUiEvent);
  // Cards fade in once when they first become ready during a live reply — whether they arrived as a
  // skeleton first or fully formed (tools render cards directly). Replayed threads show them at once.
  // A mount-time layout animation, not a JS-driven opacity value: if it is interrupted the card is
  // simply shown, it can never be left invisible.
  const [animateIn] = useState(() => part.status === "streaming" || messageStreaming);

  if (part.status === "streaming") return <GenSkeleton name={part.name} />;

  if (part.status === "invalid") {
    return (
      <View className="gap-2 rounded-3xl border border-[rgba(220,74,68,0.4)] bg-card p-4">
        <View className="flex-row items-center gap-2">
          <Icon name="alert-circle" size={16} color={colors.danger} />
          <Text weight="bold" className="text-sm">
            Couldn’t show this {part.name}
          </Text>
        </View>
        <Text muted className="text-xs">
          {part.error}
        </Text>
        <Text className="text-[15px] leading-6">{part.fallbackText}</Text>
      </View>
    );
  }

  const Component = registry[part.name as CatalogName];
  if (!Component) {
    return <Text className="text-[15px] leading-6">{part.fallbackText}</Text>;
  }

  return (
    <Animated.View entering={animateIn ? cardIn : undefined}>
      <Component
        props={part.props as GenProps<CatalogName>["props"]}
        events={events}
        busy={busy}
        live={messageStreaming}
        emit={(action, label, payload) =>
          emitUiEvent(threadId, {
            componentId: part.id,
            component: part.name,
            action,
            label,
            payload,
          })
        }
      />
    </Animated.View>
  );
}
