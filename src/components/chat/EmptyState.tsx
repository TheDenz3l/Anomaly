import Animated, { FadeIn } from "react-native-reanimated";
import { Orb } from "@/components/orb/Orb";
import { emptyOut } from "@/lib/motion";
import { colors } from "@/lib/theme";
import { useIsFocused } from "expo-router";
import { useDrawerOpen } from "@/components/navigation/SideDrawer";
import { useCovered } from "@/components/ui/Portal";

/** A new chat is just the Anomaly orb turning in the middle of the screen, waiting for you to ask. */
export function EmptyState() {
  const focused = useIsFocused();
  const drawerOpen = useDrawerOpen();
  const covered = useCovered();
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
        // Holds still under a sheet, the drawer or another screen, leaving those every frame.
        paused={!focused || drawerOpen || covered}
        label="Anomaly"
      />
    </Animated.View>
  );
}
