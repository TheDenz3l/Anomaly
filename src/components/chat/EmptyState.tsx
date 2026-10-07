import { useIsFocused } from "expo-router";
import { useEffect } from "react";
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useDrawerOpen } from "@/components/navigation/SideDrawer";
import { Orb } from "@/components/orb/Orb";
import { useCoverTop } from "@/components/ui/Portal";
import { emptyOut, sheetMotion } from "@/lib/motion";
import { colors } from "@/lib/theme";

/** Off while testing how sheets perform with the orb still turning underneath them. */
const PAUSE_UNDER_SHEETS = false;
const ORB_SIZE = 96;
/**
 * How far below a sheet's top edge the orb's top tucks: past the sheet's toolbar and behind its
 * first list group, so none of it shows over the edge or through the glass.
 */
const TUCK = 72;

/**
 * A new chat is just the Anomaly orb turning in the middle of the screen, waiting for you to ask.
 * `restY` is the window y of the orb's centre when nothing moves it.
 */
export function EmptyState({ restY }: { restY: number }) {
  const focused = useIsFocused();
  const drawerOpen = useDrawerOpen();
  const coverTop = useCoverTop();
  const reduced = useReducedMotion();
  // A sheet rising over the empty chat takes the orb down with it, out of sight below its top.
  const tuckTo = coverTop === null ? 0 : Math.max(0, coverTop + TUCK + ORB_SIZE / 2 - restY);
  const tuck = useSharedValue(0);
  useEffect(() => {
    tuck.set(reduced ? tuckTo : withSpring(tuckTo, sheetMotion.open));
  }, [tuckTo, reduced, tuck]);
  const tucked = useAnimatedStyle(() => ({ transform: [{ translateY: tuck.get() }] }));

  return (
    // One animated view for both directions: a nested entering animation would replay inside the
    // exit snapshot on web and fight the fade-out.
    <Animated.View
      entering={FadeIn.duration(500)}
      exiting={emptyOut}
      className="flex-1 items-center justify-center"
    >
      <Animated.View style={tucked}>
        <Orb
          size={ORB_SIZE}
          density={0.42}
          dotSize={1.35}
          anomalyColor={colors.primary}
          speed={0.7}
          // Holds still under a sheet, the drawer or another screen, leaving those every frame.
          paused={!focused || drawerOpen || (PAUSE_UNDER_SHEETS && coverTop !== null)}
          label="Anomaly"
        />
      </Animated.View>
    </Animated.View>
  );
}
