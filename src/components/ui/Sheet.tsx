import { useEffect, useState, type ReactNode } from "react";
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "@/lib/theme";
import { Glass } from "./Glass";
import { Icon } from "./Icon";
import { Tap } from "./Tap";
import { Text } from "./Text";

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
};

const native = Platform.OS !== "web";

/** Bottom sheet on glass. Slides up; respects reduced motion. */
export function Sheet({ open, onClose, title, subtitle, children, footer, scroll = true }: Props) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [progress] = useState(() => new Animated.Value(0));
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();

  useEffect(() => {
    if (open) {
      if (reduced) progress.setValue(1);
      else
        Animated.spring(progress, {
          toValue: 1,
          damping: 24,
          stiffness: 260,
          mass: 0.9,
          useNativeDriver: native,
        }).start();
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: reduced ? 0 : 170,
        useNativeDriver: native,
      }).start(() => setMounted(false));
    }
  }, [open, reduced, progress]);

  if (!mounted) return null;

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [Math.min(520, height * 0.6), 0],
  });
  const Body = scroll ? ScrollView : View;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={{ flex: 1, opacity: progress, backgroundColor: "rgba(0,0,0,0.55)" }}>
        <Pressable accessibilityLabel="Close" style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={{
          position: "absolute",
          bottom: 0,
          alignSelf: "center",
          width: Math.min(width, 560),
          maxHeight: height * 0.88,
          transform: [{ translateY }],
        }}
      >
        <Glass
          radius={30}
          style={{
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
            backgroundColor: "rgba(20,20,23,0.92)",
            // Header and footer keep their size; only the body shrinks and scrolls.
            maxHeight: height * 0.88,
            flexShrink: 1,
          }}
        >
          <View className="items-center pt-2.5 pb-1">
            <View className="h-1 w-9 rounded-full bg-raised" />
          </View>
          {title ? (
            <View className="flex-row items-start px-5 pt-2 pb-3">
              <View className="flex-1 pr-3">
                <Text weight="bold" className="text-lg">
                  {title}
                </Text>
                {subtitle ? (
                  <Text muted className="mt-0.5 text-sm leading-5">
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <Tap
                accessibilityLabel="Close"
                onPress={onClose}
                hitSlop={10}
                className="h-8 w-8 items-center justify-center rounded-full bg-raised"
              >
                <Icon name="close" size={18} color={colors.textMuted} />
              </Tap>
            </View>
          ) : null}
          <Body
            style={scroll ? { flexGrow: 0, flexShrink: 1 } : undefined}
            contentContainerStyle={
              scroll
                ? { paddingHorizontal: 20, paddingBottom: footer ? 12 : insets.bottom + 20 }
                : undefined
            }
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </Body>
          {footer ? (
            <View
              style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 16 }}
            >
              {footer}
            </View>
          ) : null}
        </Glass>
      </Animated.View>
    </Modal>
  );
}
