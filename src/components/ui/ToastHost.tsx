import { useEffect, useState } from "react";
import { Animated, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "@/lib/store";
import { colors } from "@/lib/theme";
import { Glass } from "./Glass";
import { Icon } from "./Icon";
import { Text } from "./Text";

export function ToastHost() {
  const toast = useApp((s) => s.toast);
  const insets = useSafeAreaInsets();
  const [anim] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(anim, {
      toValue: toast ? 1 : 0,
      duration: 180,
      useNativeDriver: Platform.OS !== "web",
    }).start();
  }, [toast, anim]);

  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: insets.top + 8, left: 0, right: 0, alignItems: "center" }}
    >
      <Animated.View
        accessibilityLiveRegion="polite"
        style={{
          opacity: anim,
          transform: [
            { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) },
          ],
        }}
      >
        {toast ? (
          <Glass radius={999}>
            <View className="flex-row items-center gap-2 px-4 py-2.5">
              <Icon
                name={toast.tone === "danger" ? "alert-circle" : "checkmark-circle"}
                size={16}
                color={toast.tone === "danger" ? colors.danger : colors.success}
              />
              <Text weight="medium" className="text-sm">
                {toast.text}
              </Text>
            </View>
          </Glass>
        ) : null}
      </Animated.View>
    </View>
  );
}
