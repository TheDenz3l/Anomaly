import { useState } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import { Text } from "@/components/ui/Text";
import { fadeIn, fadeOut } from "@/lib/motion";
import type { ThinkingPart } from "@/lib/types";
import { ActivityRow, Rail } from "./Activity";

/** Collapsible reasoning — shown only when the endpoint actually returns reasoning text (PRD §3.5). */
export function ThinkingBlock({ part }: { part: ThinkingPart }) {
  const [open, setOpen] = useState(false);
  const secs = Math.max(1, Math.round((part.durationMs ?? 0) / 1000));
  const live = !part.done;

  return (
    <View>
      <ActivityRow
        orb="reasoning"
        live={live}
        label={live ? "Thinking" : `Thought for ${secs}s`}
        expanded={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {/* Reasoning stays behind the toggle while it streams: a preview line that pops in and out
          moved everything below it, and short reasoning made it flash. */}
      {open ? (
        <Animated.View entering={fadeIn} exiting={fadeOut}>
          <Rail>
            <Text className="py-1 text-sm leading-[21px] text-ink-faint">
              {part.text || "Reasoning will appear here as the model shares it."}
            </Text>
          </Rail>
        </Animated.View>
      ) : null}
    </View>
  );
}
