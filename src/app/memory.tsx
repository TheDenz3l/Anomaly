import * as Clipboard from "expo-clipboard";
import { Switch } from "heroui-native";
import { useMemo, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { Glass } from "@/components/ui/Glass";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Group, Page } from "@/components/ui/Page";
import { Segmented } from "@/components/ui/Segmented";
import { Sheet } from "@/components/ui/Sheet";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ActionButton } from "@/genui/kit";
import { fadeIn, fadeOut, reflow } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { colors, fonts } from "@/lib/theme";
import type { Memory, MemoryCategory } from "@/lib/types";

const categories: { value: MemoryCategory; label: string; icon: IconName }[] = [
  { value: "preference", label: "Preferences", icon: "heart-outline" },
  { value: "fact", label: "Facts", icon: "information-circle-outline" },
  { value: "person", label: "People", icon: "people-outline" },
  { value: "place", label: "Places", icon: "location-outline" },
  { value: "work", label: "Work", icon: "briefcase-outline" },
];

type Draft = Pick<Memory, "text" | "category" | "scope"> & { id?: string };

function HeaderButton({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Tap accessibilityLabel={label} onPress={onPress}>
      <Glass radius={20} interactive>
        <View className="h-10 w-10 items-center justify-center">
          <Icon name={icon} size={19} />
        </View>
      </Glass>
    </Tap>
  );
}

export default function MemoryScreen() {
  const memories = useApp((s) => s.memories);
  const enabled = useApp((s) => s.settings.memoryEnabled);
  const updateSettings = useApp((s) => s.updateSettings);
  const addMemory = useApp((s) => s.addMemory);
  const updateMemory = useApp((s) => s.updateMemory);
  const deleteMemory = useApp((s) => s.deleteMemory);
  const showToast = useApp((s) => s.showToast);
  const [filter, setFilter] = useState<MemoryCategory | "all">("all");
  const [draft, setDraft] = useState<Draft | null>(null);

  const shown = useMemo(
    () => memories.filter((m) => filter === "all" || m.category === filter),
    [memories, filter]
  );

  const exportAll = async () => {
    await Clipboard.setStringAsync(
      JSON.stringify(
        memories.map(({ text, category, scope, confidence, createdAt }) => ({
          text,
          category,
          scope,
          confidence,
          createdAt: new Date(createdAt).toISOString(),
        })),
        null,
        2
      )
    );
    showToast(`Copied ${memories.length} memories as JSON`);
  };

  const save = () => {
    if (!draft || !draft.text.trim()) return;
    if (draft.id)
      updateMemory(draft.id, {
        text: draft.text.trim(),
        category: draft.category,
        scope: draft.scope,
        confidence: 1,
      });
    else
      addMemory({
        text: draft.text.trim(),
        category: draft.category,
        scope: draft.scope,
        confidence: 1,
      });
    showToast(draft.id ? "Memory updated" : "Memory added");
    setDraft(null);
  };

  return (
    <View className="flex-1 bg-background">
      <Page
        title="Memory"
        subtitle="What Anomaly keeps between chats"
        right={
          <View className="flex-row gap-2">
            <HeaderButton icon="download-outline" label="Export all memories" onPress={exportAll} />
            <HeaderButton
              icon="add"
              label="Add memory"
              onPress={() => setDraft({ text: "", category: "preference", scope: "global" })}
            />
          </View>
        }
      >
        <Group footer="Only durable facts are saved. High-confidence ones save automatically with an undo; others ask first. Incognito chats never read or write memory.">
          <View className="flex-row items-center gap-3 px-4 py-3.5">
            <Icon name="sparkles" size={20} color={enabled ? colors.primary : colors.textMuted} />
            <View className="flex-1">
              <Text weight="bold" className="text-base">
                Use memory
              </Text>
              <Text muted className="text-[13px]">
                {enabled
                  ? `${memories.length} memories, used across chats`
                  : "Off. Nothing is saved or recalled."}
              </Text>
            </View>
            <Switch
              isSelected={enabled}
              onSelectedChange={(v) => updateSettings({ memoryEnabled: v })}
            />
          </View>
        </Group>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="-mx-4 mb-4"
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        >
          {[
            { value: "all" as const, label: "All", icon: "albums-outline" as IconName },
            ...categories,
          ].map((c) => {
            const on = filter === c.value;
            const n =
              c.value === "all"
                ? memories.length
                : memories.filter((m) => m.category === c.value).length;
            return (
              <Tap
                key={c.value}
                haptic
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setFilter(c.value)}
                className={`flex-row items-center gap-1.5 rounded-full px-3.5 py-2 ${on ? "bg-primary-soft" : "bg-raised"}`}
              >
                <Text
                  weight={on ? "bold" : "medium"}
                  className={`text-sm ${on ? "text-primary-strong" : ""}`}
                >
                  {c.label}
                </Text>
                <Text className={`text-xs ${on ? "text-primary-strong" : "text-ink-faint"}`}>
                  {n}
                </Text>
              </Tap>
            );
          })}
        </ScrollView>

        {shown.length === 0 ? (
          <View className="items-center gap-3 py-12">
            <Text muted className="text-center text-[15px]">
              Nothing here yet. Tell Anomaly something like “Remember that I’m vegetarian”, or add
              one yourself.
            </Text>
            <ActionButton
              size="sm"
              variant="secondary"
              icon="add"
              label="Add memory"
              onPress={() =>
                setDraft({
                  text: "",
                  category: filter === "all" ? "preference" : filter,
                  scope: "global",
                })
              }
            />
          </View>
        ) : (
          <Group>
            {shown.map((m, i) => {
              const cat = categories.find((c) => c.value === m.category)!;
              return (
                <Animated.View key={m.id} entering={fadeIn} exiting={fadeOut} layout={reflow}>
                  <Tap
                    accessibilityRole="button"
                    accessibilityHint="Edit memory"
                    onPress={() =>
                      setDraft({ id: m.id, text: m.text, category: m.category, scope: m.scope })
                    }
                    className={`flex-row items-start gap-3 px-4 py-3.5 ${i < shown.length - 1 ? "border-b border-hairline" : ""}`}
                  >
                    <View className="pt-0.5">
                      <Icon name={cat.icon} size={18} color={colors.textMuted} />
                    </View>
                    <View className="flex-1">
                      <Text weight="medium" className="text-base leading-[22px]">
                        {m.text}
                      </Text>
                      <Text className="mt-0.5 text-xs text-ink-faint">
                        {m.scope === "global" ? "All chats" : "One chat"},{" "}
                        {Math.round(m.confidence * 100)}% confidence,{" "}
                        {new Date(m.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </Text>
                    </View>
                    <Icon name="chevron-forward" size={16} color={colors.textFaint} />
                  </Tap>
                </Animated.View>
              );
            })}
          </Group>
        )}
      </Page>

      <Sheet
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit memory" : "New memory"}
        footer={
          <View className="flex-row gap-2">
            {draft?.id ? (
              <View className="flex-1">
                <ActionButton
                  variant="danger-soft"
                  icon="trash-outline"
                  label="Delete"
                  onPress={() => {
                    if (draft.id) deleteMemory(draft.id);
                    setDraft(null);
                    showToast("Memory deleted");
                  }}
                />
              </View>
            ) : null}
            <View className="flex-1">
              <ActionButton label="Save" disabled={!draft?.text.trim()} onPress={save} />
            </View>
          </View>
        }
      >
        {draft ? (
          <View className="gap-4">
            <TextInput
              value={draft.text}
              onChangeText={(text) => setDraft({ ...draft, text })}
              multiline
              autoFocus={!draft.id}
              placeholder="Prefers window seats on flights"
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="Memory text"
              style={{
                fontFamily: fonts.body,
                fontSize: 16,
                lineHeight: 22,
                color: colors.text,
                backgroundColor: colors.raised,
                borderRadius: 18,
                padding: 14,
                minHeight: 88,
                textAlignVertical: "top",
              }}
            />
            <View className="gap-2">
              <Text weight="medium" muted className="text-[13px]">
                Category
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {categories.map((c) => {
                  const on = draft.category === c.value;
                  return (
                    <Tap
                      key={c.value}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      onPress={() => setDraft({ ...draft, category: c.value })}
                      className={`flex-row items-center gap-1.5 rounded-full px-3 py-2 ${on ? "bg-primary-soft" : "bg-raised"}`}
                    >
                      <Icon
                        name={c.icon}
                        size={14}
                        color={on ? colors.primaryStrong : colors.textMuted}
                      />
                      <Text
                        weight={on ? "bold" : "medium"}
                        className={`text-sm ${on ? "text-primary-strong" : ""}`}
                      >
                        {c.label}
                      </Text>
                    </Tap>
                  );
                })}
              </View>
            </View>
            <View className="gap-2">
              <Text weight="medium" muted className="text-[13px]">
                Applies to
              </Text>
              <Segmented
                accessibilityLabel="Memory scope"
                value={draft.scope}
                onChange={(scope) => setDraft({ ...draft, scope })}
                options={[
                  { value: "global", label: "All chats" },
                  { value: "thread", label: "One chat" },
                ]}
              />
            </View>
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}
