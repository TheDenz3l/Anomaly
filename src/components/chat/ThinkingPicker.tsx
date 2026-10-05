import { View } from "react-native";
import { Icon } from "@/components/ui/Icon";
import { Sheet } from "@/components/ui/Sheet";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { colors } from "@/lib/theme";
import type { Model } from "@/lib/types";

export function levelLabel(level: string): string {
  if (level === "auto") return "Auto";
  if (level === "off") return "Off";
  if (level === "on") return "On";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function describe(model: Model, level: string): string {
  const r = model.profile.reasoning;
  if (level === "auto") return "Picks a level per message from how hard it looks.";
  if (level === "off")
    return r.style === "toggle"
      ? `Sends ${r.field} = false.`
      : "Answers straight away, no extra reasoning.";
  if (r.style === "effort") return `Sends ${r.field}: "${level}".`;
  if (r.style === "budget")
    return `Sends ${r.field}: ${(r.budgets?.[level] ?? 0).toLocaleString("en-US")} tokens.`;
  return `Sends ${r.field} = true.`;
}

/** Thinking control: Auto / Off / whatever this endpoint supports (PRD §3.5). */
export function ThinkingPicker({
  open,
  onClose,
  model,
  value,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  model: Model;
  value: string;
  onSelect: (level: string) => void;
}) {
  const options = ["auto", "off", ...model.profile.reasoning.levels.filter((l) => l !== "off")];
  const p = model.profile;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Thinking"
      subtitle={`${model.name} supports ${p.reasoning.style === "toggle" ? "on or off" : p.reasoning.levels.join(", ")}. Profile from ${p.source}, ${Math.round(p.confidence * 100)}% confidence.`}
    >
      <View className="overflow-hidden rounded-3xl bg-card">
        {options.map((o, i) => {
          const on = o === value;
          return (
            <Tap
              key={o}
              haptic
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              onPress={() => {
                onSelect(o);
                onClose();
              }}
              className={`flex-row items-center gap-3 px-4 py-3 ${i < options.length - 1 ? "border-b border-hairline" : ""}`}
            >
              <View className="flex-1">
                <Text weight="bold" className="text-base">
                  {levelLabel(o)}
                </Text>
                <Text muted className="text-[13px] leading-[18px]">
                  {describe(model, o)}
                </Text>
              </View>
              {on ? <Icon name="checkmark-circle" size={22} color={colors.primary} /> : null}
            </Tap>
          );
        })}
      </View>
      {p.reasoning.noop ? (
        <Text muted className="mt-3 px-1 text-xs leading-4">
          This endpoint accepted the setting but used no reasoning tokens in testing, so levels may
          have no effect.
        </Text>
      ) : null}
    </Sheet>
  );
}
