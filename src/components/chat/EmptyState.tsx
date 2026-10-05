import Animated, { FadeIn } from "react-native-reanimated";
import { Orb } from "@/components/orb/Orb";
import { emptyOut } from "@/lib/motion";
import { colors } from "@/lib/theme";

/** A new chat is just the Anomaly orb turning in the middle of the screen, waiting for you to ask. */
export function EmptyState() {
  return (
    // One animated view for both directions: a nested entering animation would replay inside the
    // exit snapshot on web and fight the fade-out.
    <Animated.View
      entering={FadeIn.duration(500)}
      exiting={emptyOut}
      className="flex-1 items-center justify-center"
    >
      <Orb
        size={96}
        density={0.42}
        dotSize={1.35}
        anomalyColor={colors.primary}
        speed={0.7}
        label="Anomaly"
      />
    </Animated.View>
  );
}
