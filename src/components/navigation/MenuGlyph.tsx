import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { colors } from "@/lib/theme";
import { useDrawer } from "./SideDrawer";

const GAP = 6.5;

/** Three lines that fold into an X as the side menu opens — following the drag, not a timer. */
export function MenuGlyph() {
  const { progress } = useDrawer();
  const top = useAnimatedStyle(() => ({
    transform: [{ translateY: progress.get() * GAP }, { rotate: `${progress.get() * 45}deg` }],
  }));
  const middle = useAnimatedStyle(() => ({
    opacity: 1 - progress.get(),
    transform: [{ scaleX: 1 - progress.get() * 0.6 }],
  }));
  const bottom = useAnimatedStyle(() => ({
    transform: [{ translateY: -progress.get() * GAP }, { rotate: `${-progress.get() * 45}deg` }],
  }));
  return (
    <View style={styles.box}>
      <Animated.View style={[styles.line, top]} />
      <Animated.View style={[styles.line, styles.short, middle]} />
      <Animated.View style={[styles.line, bottom]} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 18, height: 14.5, justifyContent: "space-between" },
  line: { width: 18, height: 1.5, borderRadius: 1, backgroundColor: colors.text },
  short: { width: 13, transformOrigin: "left center" },
});
