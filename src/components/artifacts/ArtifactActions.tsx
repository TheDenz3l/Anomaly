import { router } from "expo-router";
import { Share, View } from "react-native";
import { Sheet } from "@/components/ui/Sheet";
import { ActionButton } from "@/genui/kit";
import { artifactText, type Artifact } from "@/lib/artifacts";
import { useApp } from "@/lib/store";

/** Long-press menu for an artifact: pin, go back to the chat that made it, share. */
export function ArtifactActions({
  artifact,
  onClose,
}: {
  artifact: Artifact | null;
  onClose: () => void;
}) {
  const pinned = useApp((s) => (artifact ? s.pinnedArtifacts.includes(artifact.id) : false));
  const togglePin = useApp((s) => s.togglePin);
  const openThread = useApp((s) => s.openThread);
  return (
    <Sheet
      open={artifact !== null}
      onClose={onClose}
      title={artifact?.title}
      subtitle={artifact?.kind}
    >
      {artifact ? (
        <View className="gap-2">
          <ActionButton
            variant="secondary"
            icon={pinned ? "pin-outline" : "pin"}
            label={pinned ? "Unpin" : "Pin to top"}
            onPress={() => {
              togglePin(artifact.id);
              onClose();
            }}
          />
          <ActionButton
            variant="secondary"
            icon="chatbubble-outline"
            label="Open the chat it came from"
            onPress={() => {
              onClose();
              openThread(artifact.threadId);
              router.navigate("/");
            }}
          />
          <ActionButton
            variant="secondary"
            icon="share-outline"
            label="Share"
            onPress={() => {
              onClose();
              void Share.share({ message: artifactText(artifact) });
            }}
          />
        </View>
      ) : null}
    </Sheet>
  );
}
