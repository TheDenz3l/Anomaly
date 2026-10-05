import { useRef, useState } from "react";
import { View } from "react-native";
import { colors } from "@/lib/theme";

type Props = {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  accessibilityLabel: string;
  format?: (v: number) => string;
};

const HANDLE = 28;

function snap(x: number, width: number, min: number, max: number, step: number): number {
  const w = Math.max(1, width - HANDLE);
  const ratio = Math.min(1, Math.max(0, (x - HANDLE / 2) / w));
  const raw = min + ratio * (max - min);
  return Math.min(max, Math.max(min, Math.round(raw / step) * step));
}

/** Draggable track. Snaps to `step`; keyboard/VoiceOver adjust via accessibility actions. */
export function Slider({ value, min, max, step, onChange, accessibilityLabel, format }: Props) {
  const [width, setWidth] = useState(0);
  const start = useRef({ pageX: 0, x: 0 });

  const update = (x: number) => {
    const v = snap(x, width, min, max, step);
    if (v !== value) onChange(v);
  };

  const ratio = (value - min) / (max - min || 1);
  const left = ratio * Math.max(0, width - HANDLE);

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min, max, now: value, text: format?.(value) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "increment") onChange(Math.min(max, value + step));
        if (e.nativeEvent.actionName === "decrement") onChange(Math.max(min, value - step));
      }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height: 36, justifyContent: "center", cursor: "pointer" } as object}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponderCapture={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        start.current = { pageX: e.nativeEvent.pageX, x: e.nativeEvent.locationX };
        update(e.nativeEvent.locationX);
      }}
      onResponderMove={(e) => update(start.current.x + e.nativeEvent.pageX - start.current.pageX)}
    >
      <View
        pointerEvents="none"
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: colors.raised,
          marginHorizontal: HANDLE / 2,
        }}
      >
        <View
          style={{ width: left, height: 6, borderRadius: 3, backgroundColor: colors.primary }}
        />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left,
          width: HANDLE,
          height: HANDLE,
          borderRadius: HANDLE / 2,
          backgroundColor: "#FFFFFF",
          borderWidth: 4,
          borderColor: colors.primary,
        }}
      />
    </View>
  );
}
