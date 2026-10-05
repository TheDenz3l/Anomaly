import { View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Orb } from "@/components/orb/Orb";
import { colors } from "@/lib/theme";

/** A new chat is just the Anomaly orb turning in the middle of the screen, waiting for you to ask. */
export function EmptyState() {
  return (
    <View className="flex-1 items-center justify-center">
      <Animated.View entering={FadeIn.duration(500)}>
        <Orb size={96} density={0.42} dotSize={1.35} anomalyColor={colors.primary} speed={0.7} label="Anomaly" />
      </Animated.View>
    </View>
  );
}
