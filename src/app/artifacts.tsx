import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import Animated from "react-native-reanimated";
import { ArtifactActions } from "@/components/artifacts/ArtifactActions";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { Icon } from "@/components/ui/Icon";
import { Page } from "@/components/ui/Page";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ActionButton } from "@/genui/kit";
import { groupLabels, type Artifact, type ArtifactGroup } from "@/lib/artifacts";
import { fadeIn, fadeOut, reflow } from "@/lib/motion";
import { goBack } from "@/lib/nav";
import { useApp, useArtifacts } from "@/lib/store";
import { colors } from "@/lib/theme";

type Filter = "all" | ArtifactGroup;

const emptyCopy: Record<Filter, string> = {
  all: "Charts, tables, guides and research reports Anomaly makes in your chats collect here.",
  apps: "Calculators, checklists, guides and maps you can use again will show up here.",
  reports: "Deep Research reports land here. Turn on Research in the composer to start one.",
  data: "Tables, comparisons and timelines from your chats will show up here.",
};

function Grid({
  items,
  pinned,
  onOpen,
  onMore,
}: {
  items: Artifact[];
  pinned: string[];
  onOpen: (a: Artifact) => void;
  onMore: (a: Artifact) => void;
}) {
  return (
    <View className="flex-row flex-wrap justify-between gap-y-5">
      {items.map((a) => (
        <Animated.View
          key={a.id}
          entering={fadeIn}
          exiting={fadeOut}
          layout={reflow}
          style={{ width: "48%" }}
        >
          <ArtifactCard
            artifact={a}
            pinned={pinned.includes(a.id)}
            onOpen={() => onOpen(a)}
            onMore={() => onMore(a)}
          />
        </Animated.View>
      ))}
    </View>
  );
}

/** Everything Anomaly has made in your chats, in one place: pinned first, then most recently made or opened. */
export default function ArtifactsScreen() {
  const artifacts = useArtifacts();
  const pinned = useApp((s) => s.pinnedArtifacts);
  const views = useApp((s) => s.artifactViews);
  const markViewed = useApp((s) => s.markViewed);
  const newChat = useApp((s) => s.newChat);
  const [filter, setFilter] = useState<Filter>("all");
  const [menuFor, setMenuFor] = useState<Artifact | null>(null);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: artifacts.length, apps: 0, reports: 0, data: 0 };
    for (const a of artifacts) c[a.group] += 1;
    return c;
  }, [artifacts]);

  const shown = artifacts.filter((a) => filter === "all" || a.group === filter);
  const pinnedItems = pinned
    .map((id) => shown.find((a) => a.id === id))
    .filter((a): a is Artifact => Boolean(a));
  const recent = shown
    .filter((a) => !pinned.includes(a.id))
    .sort(
      (a, b) => Math.max(b.createdAt, views[b.id] ?? 0) - Math.max(a.createdAt, views[a.id] ?? 0)
    );

  const open = (a: Artifact) => {
    markViewed(a.id);
    router.push({ pathname: "/artifact/[id]", params: { id: a.id } });
  };

  const filters: Filter[] = ["all", "apps", "reports", "data"];

  return (
    <View className="flex-1">
      <Page
        title="Artifacts"
        subtitle={
          artifacts.length
            ? `${artifacts.length} things Anomaly made in your chats`
            : "Things Anomaly makes in your chats"
        }
      >
        <ScrollView
          key="filters"
          horizontal
          showsHorizontalScrollIndicator={false}
          className="-mx-4 mb-5"
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        >
          {filters.map((f) => {
            const on = filter === f;
            return (
              <Tap
                key={f}
                haptic
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setFilter(f)}
                className={`flex-row items-center gap-1.5 rounded-full px-3.5 py-2 ${on ? "bg-primary-soft" : "bg-raised"}`}
              >
                <Text
                  weight={on ? "bold" : "medium"}
                  className={`text-sm ${on ? "text-primary-strong" : ""}`}
                >
                  {f === "all" ? "All" : groupLabels[f]}
                </Text>
                <Text className={`text-xs ${on ? "text-primary-strong" : "text-ink-faint"}`}>
                  {counts[f]}
                </Text>
              </Tap>
            );
          })}
        </ScrollView>

        {shown.length === 0 ? (
          <View key="empty" className="items-center gap-4 px-6 py-14">
            <Icon name="shapes-outline" size={30} color={colors.textFaint} />
            <Text muted className="text-center text-[15px] leading-[22px]">
              {emptyCopy[filter]}
            </Text>
            <ActionButton
              size="sm"
              variant="secondary"
              icon="add"
              label="Start a chat"
              onPress={() => {
                newChat();
                goBack();
              }}
            />
          </View>
        ) : null}

        {pinnedItems.length > 0 ? (
          <View key="pinned" className="mb-7">
            <Text weight="bold" muted className="mb-3 text-[13px]">
              Pinned
            </Text>
            <Grid items={pinnedItems} pinned={pinned} onOpen={open} onMore={setMenuFor} />
          </View>
        ) : null}

        {recent.length > 0 ? (
          <View key="recent">
            {pinnedItems.length > 0 ? (
              <Text weight="bold" muted className="mb-3 text-[13px]">
                Recent
              </Text>
            ) : null}
            <Grid items={recent} pinned={pinned} onOpen={open} onMore={setMenuFor} />
          </View>
        ) : null}
      </Page>
      <ArtifactActions artifact={menuFor} onClose={() => setMenuFor(null)} />
    </View>
  );
}
