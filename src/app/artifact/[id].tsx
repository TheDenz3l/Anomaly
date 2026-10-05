import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { Share, View } from "react-native";
import { CitationProvider } from "@/components/chat/Citations";
import { Markdown } from "@/components/chat/Markdown";
import { SourceRow } from "@/components/chat/SourceRow";
import { Glass } from "@/components/ui/Glass";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Page } from "@/components/ui/Page";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ComponentRenderer } from "@/genui/ComponentRenderer";
import { ActionButton } from "@/genui/kit";
import { ago, artifactText, reportParts, type Artifact } from "@/lib/artifacts";
import { goBack } from "@/lib/nav";
import { useApp, useArtifacts, useComponentEvents } from "@/lib/store";
import { colors } from "@/lib/theme";

function BarButton({
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
    <Tap accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
      <Glass radius={20} interactive>
        <View className="h-10 w-10 items-center justify-center">
          <Icon name={icon} size={18} color={active ? colors.primaryStrong : colors.text} />
        </View>
      </Glass>
    </Tap>
  );
}

/** Tells you when acting on an artifact carried on the conversation it came from. */
function useContinuedToast(threadId: string, componentId: string) {
  const events = useComponentEvents(threadId, componentId);
  const showToast = useApp((s) => s.showToast);
  const seen = useRef(events.length);
  useEffect(() => {
    if (events.length > seen.current) showToast("Sent to the chat it came from");
    seen.current = events.length;
  }, [events.length, showToast]);
}

function ComponentBody({ artifact }: { artifact: Extract<Artifact, { type: "component" }> }) {
  useContinuedToast(artifact.threadId, artifact.part.id);
  return (
    <View key="body" className="mb-4">
      <ComponentRenderer
        part={artifact.part}
        threadId={artifact.threadId}
        messageStreaming={false}
      />
      <Text className="mt-3 px-1 text-xs leading-4 text-ink-faint">
        It works here just as it did in the chat. Anything you send from it continues that
        conversation.
      </Text>
    </View>
  );
}

function ReportBody({ artifact }: { artifact: Extract<Artifact, { type: "report" }> }) {
  return (
    <CitationProvider sources={artifact.sources}>
      <View className="gap-4">
        {reportParts(artifact.message).map((p) => {
          if (p.type === "text") return <Markdown key={p.id} text={p.text} />;
          if (p.type === "component" && p.name === "Table") {
            return (
              <ComponentRenderer
                key={p.id}
                part={p}
                threadId={artifact.threadId}
                messageStreaming={false}
              />
            );
          }
          return null;
        })}
      </View>
    </CitationProvider>
  );
}

/** One artifact, full size and live, with a way back to the chat that made it. */
export default function ArtifactScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const artifacts = useArtifacts();
  const artifact = artifacts.find((a) => a.id === id);
  const thread = useApp((s) => (artifact ? s.threads[artifact.threadId] : undefined));
  const pinned = useApp((s) => (artifact ? s.pinnedArtifacts.includes(artifact.id) : false));
  const togglePin = useApp((s) => s.togglePin);
  const markViewed = useApp((s) => s.markViewed);
  const openThread = useApp((s) => s.openThread);

  useEffect(() => {
    if (artifact) markViewed(artifact.id);
  }, [artifact?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!artifact) {
    return (
      <Page title="Artifact">
        <View key="gone" className="items-center gap-4 py-16">
          <Icon name="shapes-outline" size={30} color={colors.textFaint} />
          <Text muted className="text-center text-[15px] leading-[22px]">
            This artifact isn’t here any more. It was removed along with its chat.
          </Text>
          <ActionButton size="sm" variant="secondary" label="Back to Artifacts" onPress={goBack} />
        </View>
      </Page>
    );
  }

  const openChat = () => {
    openThread(artifact.threadId);
    router.navigate("/");
  };

  return (
    <Page
      title={artifact.title}
      kicker={`${artifact.kind}, ${ago(artifact.createdAt).toLowerCase()}`}
      plainTitle
      right={
        <>
          <BarButton
            icon={pinned ? "pin" : "pin-outline"}
            label={pinned ? "Unpin" : "Pin"}
            onPress={() => togglePin(artifact.id)}
            active={pinned}
          />
          <BarButton
            icon="share-outline"
            label="Share"
            onPress={() => void Share.share({ message: artifactText(artifact) })}
          />
        </>
      }
    >
      <Tap
        key="from"
        accessibilityRole="link"
        accessibilityLabel={`Open the chat ${thread?.title ?? ""}`}
        onPress={openChat}
        className="mb-5 flex-row items-center gap-2.5 self-start rounded-full bg-raised py-2 pl-3 pr-3.5"
      >
        <Icon name="chatbubble-outline" size={14} color={colors.textMuted} />
        <Text weight="medium" className="max-w-[260px] text-[13px]" numberOfLines={1}>
          {thread?.title ?? "Chat"}
        </Text>
        <Icon name="arrow-forward" size={13} color={colors.textMuted} />
      </Tap>

      {artifact.type === "report" ? (
        <View key="report" className="mb-8">
          <ReportBody artifact={artifact} />
        </View>
      ) : (
        <ComponentBody key="component" artifact={artifact} />
      )}

      {artifact.type === "report" && artifact.sources.length > 0 ? (
        <View key="sources">
          <Text weight="bold" muted className="mb-1 text-[13px]">
            {artifact.sources.length} sources
          </Text>
          {artifact.sources.map((s, i) => (
            <SourceRow key={s.id} source={s} index={i + 1} />
          ))}
        </View>
      ) : null}
    </Page>
  );
}
