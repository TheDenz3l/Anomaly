import { Children, isValidElement, type ReactNode } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  interpolate,
  LayoutAnimationConfig,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { enterUp, fadeOut, reflow } from "@/lib/motion";
import { goBack } from "@/lib/nav";
import { LIST_RADIUS } from "@/lib/theme";
import { Glass } from "./Glass";
import { Icon } from "./Icon";
import { Tap } from "./Tap";
import { Display, Text } from "./Text";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

const BAR = 56;

/**
 * Page opened from the side menu. Sections rise in one after another on open; as you scroll,
 * the large title hands off to a compact one in the top bar (iOS large-title behaviour).
 */
export function Page({
  title,
  subtitle,
  kicker,
  plainTitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Small line above the title, e.g. what kind of thing the page shows. */
  kicker?: string;
  /** Set the title in Satoshi instead of the Moderniz display face — for long, user-made titles. */
  plainTitle?: boolean;
  right?: ReactNode;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    y.set(e.contentOffset.y);
  });

  const compactTitle = useAnimatedStyle(() => ({
    opacity: interpolate(y.get(), [44, 76], [0, 1], "clamp"),
    transform: [{ translateY: interpolate(y.get(), [44, 76], [8, 0], "clamp") }],
  }));
  const largeTitle = useAnimatedStyle(() => ({
    opacity: interpolate(y.get(), [0, 56], [1, 0], "clamp"),
    transform: [{ scale: interpolate(y.get(), [-120, 0], [1.14, 1], "clamp") }],
  }));

  const sections = Children.toArray(children).filter(isValidElement);

  return (
    <View className="flex-1 bg-background">
      {/* The page scrolls inside a rounded window under the bar, so its grouped lists never get
          cut straight as they scroll away. */}
      <View
        style={[styles.window, { marginTop: insets.top + BAR, width: Math.min(width - 32, 720) }]}
      >
        <KeyboardAwareScrollView
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          bottomOffset={48}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 32 }}
        >
          <Animated.View entering={enterUp(0)}>
            <Animated.View
              style={[{ transformOrigin: "left center", paddingBottom: 18 }, largeTitle]}
            >
              {kicker ? (
                <Text muted weight="medium" className="mb-1 text-[13px]">
                  {kicker}
                </Text>
              ) : null}
              {plainTitle ? (
                <Text
                  accessibilityRole="header"
                  weight="bold"
                  className="text-[26px] leading-[32px]"
                >
                  {title}
                </Text>
              ) : (
                <Display accessibilityRole="header" className="text-[30px] leading-[38px]">
                  {title}
                </Display>
              )}
              {subtitle ? (
                <Text muted className="mt-0.5 text-sm leading-5">
                  {subtitle}
                </Text>
              ) : null}
            </Animated.View>
          </Animated.View>
          {sections.map((section, i) => (
            <Animated.View
              key={section.key ?? i}
              entering={enterUp(i + 1)}
              exiting={fadeOut}
              layout={reflow}
            >
              <LayoutAnimationConfig skipEntering>{section}</LayoutAnimationConfig>
            </Animated.View>
          ))}
        </KeyboardAwareScrollView>
      </View>

      <View
        pointerEvents="box-none"
        style={[styles.bar, { paddingTop: insets.top, height: insets.top + BAR }]}
      >
        <Tap accessibilityRole="button" accessibilityLabel="Back" onPress={goBack}>
          <Glass radius={20} interactive>
            <View className="h-10 w-10 items-center justify-center">
              <Icon name="chevron-back" size={20} />
            </View>
          </Glass>
        </Tap>
        <Animated.View pointerEvents="none" style={[styles.compact, compactTitle]}>
          <Text weight="bold" className="text-[15px]" numberOfLines={1}>
            {title}
          </Text>
        </Animated.View>
        <View className="flex-row gap-2">{right}</View>
      </View>
    </View>
  );
}

/** Inset grouped list section — the iOS Settings pattern on `surface`. */
export function Group({
  label,
  footer,
  children,
}: {
  label?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <View className="mb-6">
      {label ? (
        <Text weight="bold" muted className="mb-2 px-4 text-[13px]">
          {label}
        </Text>
      ) : null}
      <View className="overflow-hidden rounded-3xl bg-card">{children}</View>
      {footer ? <Text className="mt-2 px-4 text-xs leading-4 text-ink-faint">{footer}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
  },
  window: {
    flex: 1,
    alignSelf: "center",
    borderTopLeftRadius: LIST_RADIUS,
    borderTopRightRadius: LIST_RADIUS,
    overflow: "hidden",
  },
  compact: {
    position: "absolute",
    left: 72,
    right: 72,
    bottom: 0,
    height: BAR,
    alignItems: "center",
    justifyContent: "center",
  },
});
