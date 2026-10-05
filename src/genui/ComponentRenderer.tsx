import { useEffect, useRef, useState, type ComponentType } from "react";
import { Animated, Platform, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { Icon } from "@/components/ui/Icon";
import { Text } from "@/components/ui/Text";
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
  const reduced = useReducedMotion();
  const [fade] = useState(
    () => new Animated.Value(part.status === "streaming" || !messageStreaming ? 1 : 0)
  );
  const wasStreaming = useRef(part.status === "streaming");

  useEffect(() => {
    if (wasStreaming.current && part.status !== "streaming") {
      wasStreaming.current = false;
      fade.setValue(reduced ? 1 : 0);
      Animated.timing(fade, {
        toValue: 1,
        duration: 320,
        useNativeDriver: Platform.OS !== "web",
      }).start();
    }
  }, [part.status, fade, reduced]);

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
    <Animated.View
      style={{
        opacity: fade,
        transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
      }}
    >
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
