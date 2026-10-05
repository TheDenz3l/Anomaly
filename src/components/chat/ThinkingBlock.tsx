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
  const preview = part.text.slice(-120);

  return (
    <View>
      <ActivityRow
        orb="reasoning"
        live={live}
        label={live ? "Thinking" : `Thought for ${secs}s`}
        expanded={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open ? (
        <Animated.View entering={fadeIn} exiting={fadeOut}>
          <Rail>
            <Text className="py-1 text-sm leading-[21px] text-ink-faint">{part.text}</Text>
          </Rail>
        </Animated.View>
      ) : live && preview ? (
        <Rail>
          <Text numberOfLines={1} className="py-0.5 text-[13px] text-ink-faint">
            {preview}
          </Text>
        </Rail>
      ) : null}
    </View>
  );
}
