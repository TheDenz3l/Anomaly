import { Component as ReactComponent, useState, type ComponentType, type ReactNode } from "react";
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

  // While the call streams, the server sends the props written so far once they pass the schema;
  // until then a skeleton holds the place.
  const building = part.status === "streaming";
  const props = part.props as Record<string, unknown> | null;
  if (building && (!props || Object.keys(props).length === 0))
    return <GenSkeleton name={part.name} />;

  if (part.status === "invalid") {
    return <CardError name={part.name} error={part.error} fallbackText={part.fallbackText} />;
  }

  const Component = Object.prototype.hasOwnProperty.call(registry, part.name)
    ? registry[part.name as CatalogName]
    : undefined;
  if (!Component) {
    return <Text className="text-[15px] leading-6">{part.fallbackText}</Text>;
  }

  return (
    <Animated.View entering={animateIn ? cardIn : undefined}>
      <CardBoundary
        resetKey={part.props}
        fallback={
          <CardError
            name={part.name}
            error="Something in this card couldn’t be drawn."
            fallbackText={part.fallbackText}
          />
        }
      >
        <Component
          key={building && !GROWS_IN_PLACE.has(part.name) ? "building" : "ready"}
          building={building}
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
      </CardBoundary>
    </Animated.View>
  );
}

function CardError({
  name,
  error,
  fallbackText,
}: {
  name: string;
  error?: string;
  fallbackText: string;
}) {
  return (
    <View className="gap-2 rounded-3xl border border-[rgba(220,74,68,0.4)] bg-card p-4">
      <View className="flex-row items-center gap-2">
        <Icon name="alert-circle" size={16} color={colors.danger} />
        <Text weight="bold" className="text-sm">
          Couldn’t show this {name}
        </Text>
      </View>
      {error ? (
        <Text muted className="text-xs">
          {error}
        </Text>
      ) : null}
      <Text className="text-[15px] leading-6">{fallbackText}</Text>
    </View>
  );
}

/**
 * Keeps a card that throws while drawing (props the schema allowed but the component can't
 * handle) from taking the whole chat down with it. Tries again when the card's props change.
 */
class CardBoundary extends ReactComponent<
  { resetKey: unknown; fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("A card failed to render", error);
  }

  componentDidUpdate(prev: { resetKey: unknown }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
/**
 * Cards that take each new prop set in place while they stream. The rest remount once complete, so
 * state they derive from props when mounted (form values, slider positions) starts from the full set.
 */
const GROWS_IN_PLACE = new Set(["Blocks"]);
