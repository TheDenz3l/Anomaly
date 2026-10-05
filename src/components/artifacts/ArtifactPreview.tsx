import { useState, type ComponentType } from "react";
import { View } from "react-native";
import { Markdown } from "@/components/chat/Markdown";
import { Icon } from "@/components/ui/Icon";
import { Text } from "@/components/ui/Text";
import { catalogComponents } from "@/genui/components";
import type { GenProps } from "@/genui/kit";
import type { CatalogName } from "@/genui/schemas";
import { reportText, type Artifact } from "@/lib/artifacts";
import { useComponentEvents } from "@/lib/store";
import { colors } from "@/lib/theme";

const registry = catalogComponents as Record<CatalogName, ComponentType<GenProps<CatalogName>>>;

/** Previews render at phone width, then scale down to fit the card. */
const RENDER_W = 360;
const noop = () => {};

function ReportPage({ artifact }: { artifact: Extract<Artifact, { type: "report" }> }) {
  const body = reportText(artifact.message)
    .replace(/\s?\[\d+\]/g, "")
    .slice(0, 700);
  return (
    <View className="rounded-3xl bg-card px-5 pb-5 pt-5">
      <View className="mb-3 flex-row items-center gap-2">
        <Icon name="document-text-outline" size={18} color={colors.textMuted} />
        <Text muted weight="medium" className="text-[14px]">
          {artifact.sources.length} sources
        </Text>
      </View>
      <Text weight="bold" className="mb-3 text-[24px] leading-[30px]">
        {artifact.title}
      </Text>
      <Markdown text={body} />
    </View>
  );
}

function ComponentPage({ artifact }: { artifact: Extract<Artifact, { type: "component" }> }) {
  const events = useComponentEvents(artifact.threadId, artifact.part.id);
  const Component = registry[artifact.part.name as CatalogName];
  if (!Component) return null;
  return (
    <Component
      props={artifact.part.props as GenProps<CatalogName>["props"]}
      events={events}
      emit={noop}
      busy={false}
      live={false}
    />
  );
}

/**
 * A live miniature of the artifact: the real component rendered at phone width and scaled to the
 * card, so the library shows what you made rather than a generic icon. Never interactive.
 */
export function ArtifactPreview({ artifact, height }: { artifact: Artifact; height: number }) {
  const [width, setWidth] = useState(0);
  const scale = width / RENDER_W;
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height, overflow: "hidden", borderRadius: 18, backgroundColor: colors.surface }}
    >
      {width > 0 ? (
        <View style={{ width: RENDER_W, transform: [{ scale }], transformOrigin: "left top" }}>
          {artifact.type === "report" ? <ReportPage artifact={artifact} /> : <ComponentPage artifact={artifact} />}
        </View>
      ) : null}
    </View>
  );
}
