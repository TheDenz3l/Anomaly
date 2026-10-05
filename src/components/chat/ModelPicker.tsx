import { router } from "expo-router";
import { View } from "react-native";
import { Icon } from "@/components/ui/Icon";
import { Sheet } from "@/components/ui/Sheet";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { Pill } from "@/genui/kit";
import { modelRef } from "@/lib/mock/models";
import { useApp } from "@/lib/store";
import { colors } from "@/lib/theme";
import type { Model } from "@/lib/types";

export function capabilityTags(m: Model): string[] {
  const f = m.profile.features;
  const tags: string[] = [];
  if (m.profile.reasoning.style !== "none") tags.push("Reasoning");
  if (f.vision) tags.push("Vision");
  if (f.tools) tags.push("Tools");
  else tags.push("JSON fallback");
  if (f.webSearch) tags.push("Web search");
  if (f.audio) tags.push("Audio");
  return tags;
}

function context(n: number) {
  return n >= 1_000_000 ? `${n / 1_000_000}M context` : `${Math.round(n / 1000)}k context`;
}

export function ModelPicker({
  open,
  onClose,
  value,
  onSelect,
  title = "Model",
}: {
  open: boolean;
  onClose: () => void;
  value: string;
  onSelect: (ref: string) => void;
  title?: string;
}) {
  const providers = useApp((s) => s.providers);
  const models = useApp((s) => s.models);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle="From your own endpoints. Tags come from each model's capability profile."
      footer={
        <Tap
          accessibilityRole="link"
          onPress={() => {
            onClose();
            router.push("/settings");
          }}
          className="flex-row items-center justify-center gap-2 rounded-full bg-raised py-3"
        >
          <Icon name="server-outline" size={16} color={colors.text} />
          <Text weight="bold" className="text-[15px]">
            Manage providers
          </Text>
        </Tap>
      }
    >
      <View className="gap-5">
        {providers.map((p) => {
          const list = models.filter((m) => m.providerId === p.providerId);
          if (list.length === 0) return null;
          return (
            <View key={p.providerId}>
              <View className="mb-1 flex-row items-center gap-2 px-1">
                <View
                  className={`h-1.5 w-1.5 rounded-full ${p.status === "connected" ? "bg-success" : "bg-danger"}`}
                />
                <Text weight="bold" muted className="text-[13px]">
                  {p.label}
                </Text>
              </View>
              <View className="overflow-hidden rounded-3xl bg-card">
                {list.map((m, i) => {
                  const ref = modelRef(m);
                  const on = ref === value;
                  return (
                    <Tap
                      key={ref}
                      haptic
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      onPress={() => {
                        onSelect(ref);
                        onClose();
                      }}
                      className={`flex-row items-center gap-3 px-4 py-3 ${i < list.length - 1 ? "border-b border-hairline" : ""}`}
                    >
                      <View className="flex-1 gap-1.5">
                        <View className="flex-row items-baseline gap-2">
                          <Text weight="bold" className="text-base">
                            {m.name}
                          </Text>
                          <Text className="text-xs text-ink-faint">{context(m.contextWindow)}</Text>
                        </View>
                        <View className="flex-row flex-wrap gap-1">
                          {capabilityTags(m).map((t) => (
                            <Pill
                              key={t}
                              label={t}
                              tone={t === "JSON fallback" ? "warning" : "neutral"}
                            />
                          ))}
                          {m.profile.confidence < 0.8 ? (
                            <Pill label="Unverified" tone="warning" icon="help-circle-outline" />
                          ) : null}
                        </View>
                      </View>
                      {on ? (
                        <Icon name="checkmark-circle" size={22} color={colors.primary} />
                      ) : null}
                    </Tap>
                  );
                })}
              </View>
            </View>
          );
        })}
      </View>
    </Sheet>
  );
}
