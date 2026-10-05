import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Icon } from "@/components/ui/Icon";
import { Text } from "@/components/ui/Text";
import { ago, type Artifact } from "@/lib/artifacts";
import { springs } from "@/lib/motion";
import { colors } from "@/lib/theme";
import { ArtifactPreview } from "./ArtifactPreview";

/**
 * Library card: a live miniature of the artifact, its title and what kind of thing it is. The press
 * target sits over the card rather than around it, so the preview's own buttons are never nested
 * inside another button.
 */
export function ArtifactCard({
  artifact,
  pinned,
  onOpen,
  onMore,
}: {
  artifact: Artifact;
  pinned: boolean;
  onOpen: () => void;
  onMore: () => void;
}) {
  const pressed = useSharedValue(0);
  const reduced = useReducedMotion();
  const feedback = useAnimatedStyle(() => ({
    opacity: 1 - pressed.get() * 0.2,
    transform: [{ scale: 1 - pressed.get() * (reduced ? 0 : 0.035) }],
  }));

  return (
    <Animated.View style={feedback}>
      <View>
        <ArtifactPreview artifact={artifact} height={148} />
        {pinned ? (
          <View className="absolute right-2 top-2 h-6 w-6 items-center justify-center rounded-full bg-black/75">
            <Icon name="pin" size={12} color={colors.text} />
          </View>
        ) : null}
      </View>
      <Text weight="bold" className="mt-2 text-[14px] leading-[18px]" numberOfLines={2}>
        {artifact.title}
      </Text>
      <View className="mt-0.5 flex-row items-center justify-between">
        <Text muted className="text-xs">
          {artifact.kind}
        </Text>
        <Text className="text-xs text-ink-faint">{ago(artifact.createdAt)}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${artifact.title}, ${artifact.kind}${pinned ? ", pinned" : ""}`}
        accessibilityHint="Opens it. Long press for more."
        onPress={onOpen}
        onLongPress={onMore}
        delayLongPress={350}
        onPressIn={() => pressed.set(withTiming(1, { duration: 80 }))}
        onPressOut={() => pressed.set(withSpring(0, springs.snappy))}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}
