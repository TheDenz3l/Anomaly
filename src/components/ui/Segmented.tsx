import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { springs } from "@/lib/motion";
import { Tap } from "./Tap";
import { Text } from "./Text";

type Option<T extends string> = { value: T; label: string };

const PAD = 4;

/** Pill segmented control. The selection thumb slides between options instead of jumping. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  accessibilityLabel?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const [width, setWidth] = useState(0);
  const position = useSharedValue(index);
  const reduced = useReducedMotion();
  const segment = width > 0 ? (width - PAD * 2) / options.length : 0;

  useEffect(() => {
    position.set(reduced ? index : withSpring(index, springs.glide));
  }, [index, reduced, position]);

  const thumb = useAnimatedStyle(() => ({
    width: segment,
    transform: [{ translateX: position.get() * segment }],
  }));

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      className="flex-row rounded-full bg-raised p-1"
    >
      {segment > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              top: PAD,
              bottom: PAD,
              left: PAD,
              borderRadius: 999,
              backgroundColor: "#3F3F46",
            },
            thumb,
          ]}
        />
      ) : null}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Tap
            key={o.value}
            haptic
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            className={`flex-1 items-center rounded-full px-1 py-1.5 ${active && segment === 0 ? "bg-[#3F3F46]" : ""}`}
          >
            <Text
              weight={active ? "bold" : "medium"}
              muted={!active}
              className="text-sm"
              numberOfLines={1}
            >
              {o.label}
            </Text>
          </Tap>
        );
      })}
    </View>
  );
}
