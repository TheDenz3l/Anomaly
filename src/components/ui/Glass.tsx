import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

const liquid = Platform.OS === "ios" && isLiquidGlassAvailable();

type Props = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  radius?: number;
  interactive?: boolean;
  tint?: string;
};

/**
 * Glass for chrome only — nav, composer, floating controls, sheets. Never message bubbles (PRD §2.4).
 * iOS 26 → Liquid Glass. Older iOS and web → blur with a solid-ish dark fill.
 */
export function Glass({ children, style, radius = 24, interactive, tint }: Props) {
  if (liquid) {
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="dark"
        isInteractive={interactive}
        tintColor={tint}
        style={[{ borderRadius: radius, overflow: "hidden" }, style]}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <BlurView
      intensity={48}
      tint="dark"
      style={[
        styles.fallback,
        { borderRadius: radius },
        tint ? { backgroundColor: tint } : null,
        style,
      ]}
    >
      {children}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  fallback: {
    overflow: "hidden",
    backgroundColor: "rgba(28, 28, 31, 0.72)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.10)",
  },
});
