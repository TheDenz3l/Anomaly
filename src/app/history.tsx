import { useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { Glass } from "@/components/ui/Glass";
import { Icon } from "@/components/ui/Icon";
import { Group, Page } from "@/components/ui/Page";
import { Sheet } from "@/components/ui/Sheet";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { ActionButton } from "@/genui/kit";
import { fadeIn, fadeOut, reflow } from "@/lib/motion";
import { goBack } from "@/lib/nav";
import { findModel, useApp } from "@/lib/store";
import { colors, fonts } from "@/lib/theme";
import type { Message, Thread } from "@/lib/types";

function preview(list: Message[] | undefined): string {
  const last = [...(list ?? [])].reverse().find((m) => m.role === "assistant");
  const texts = (last?.parts ?? []).filter((p) => p.type === "text");
  const text = texts[texts.length - 1];
  return text && text.type === "text"
    ? text.text.replace(/\*\*|###\s?|\[\d+\]/g, "").split("\n")[0]
    : "";
}

function when(ts: number): string {
  const d = new Date(ts);
  const b = bucket(ts);
  if (b === "Today" || b === "Yesterday")
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (b === "Previous 7 days") return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function bucket(ts: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ts >= start.getTime()) return "Today";
  if (ts >= start.getTime() - day) return "Yesterday";
  if (ts >= start.getTime() - 7 * day) return "Previous 7 days";
  return "Older";
}

export default function HistoryScreen() {
  const threads = useApp((s) => s.threads);
  const messages = useApp((s) => s.messages);
  const models = useApp((s) => s.models);
  const activeId = useApp((s) => s.activeThreadId);
  const openThread = useApp((s) => s.openThread);
  const newChat = useApp((s) => s.newChat);
  const deleteThread = useApp((s) => s.deleteThread);
  const showToast = useApp((s) => s.showToast);
  const { search } = useLocalSearchParams<{ search?: string }>();
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<Thread | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = Object.values(threads)
      .filter(
        (t) =>
          !q ||
          t.title.toLowerCase().includes(q) ||
          preview(messages[t.id]).toLowerCase().includes(q)
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const out: { label: string; items: Thread[] }[] = [];
    for (const t of list) {
      const label = bucket(t.updatedAt);
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(t);
      else out.push({ label, items: [t] });
    }
    return out;
  }, [threads, messages, query]);

  const open = (id: string) => {
    openThread(id);
    goBack();
  };

  return (
    <View className="flex-1 bg-background">
      <Page
        title="History"
        subtitle={`${Object.keys(threads).length} chats`}
        right={
          <Tap
            accessibilityLabel="New chat"
            onPress={() => {
              newChat();
              goBack();
            }}
          >
            <Glass radius={20} interactive>
              <View className="h-10 w-10 items-center justify-center">
                <Icon name="create-outline" size={19} />
              </View>
            </Glass>
          </Tap>
        }
      >
        <View className="mb-5 flex-row items-center gap-2 rounded-full bg-raised px-4">
          <Icon name="search" size={16} color={colors.textFaint} />
          <TextInput
            autoFocus={search === "1"}
            value={query}
            onChangeText={setQuery}
            placeholder="Search chats"
            placeholderTextColor={colors.textFaint}
            accessibilityLabel="Search chats"
            style={
              {
                flex: 1,
                fontFamily: fonts.body,
                fontSize: 16,
                color: colors.text,
                paddingVertical: 10,
                outlineStyle: "none",
              } as object
            }
          />
          {query ? (
            <Tap accessibilityLabel="Clear search" onPress={() => setQuery("")}>
              <Icon name="close-circle" size={16} color={colors.textFaint} />
            </Tap>
          ) : null}
        </View>

        {groups.length === 0 ? (
          <View className="items-center gap-2 py-16">
            <Icon name="chatbubbles-outline" size={28} color={colors.textFaint} />
            <Text muted className="text-center text-[15px]">
              {query ? `No chats match “${query}”.` : "No chats yet. Start one from the Chat tab."}
            </Text>
          </View>
        ) : null}

        {groups.map((g) => (
          <Group key={g.label} label={g.label}>
            {g.items.map((t, i) => {
              const model = findModel(models, t.modelRef);
              const icon =
                t.mode === "research"
                  ? "telescope-outline"
                  : t.incognito
                    ? "eye-off-outline"
                    : "chatbubble-outline";
              return (
                <Animated.View key={t.id} entering={fadeIn} exiting={fadeOut} layout={reflow}>
                <Tap
                  accessibilityRole="button"
                  accessibilityLabel={`${t.title}${t.id === activeId ? ", open" : ""}`}
                  onPress={() => open(t.id)}
                  onLongPress={() => setMenuFor(t)}
                  className={`flex-row items-center gap-3 px-4 py-3.5 ${i < g.items.length - 1 ? "border-b border-hairline" : ""}`}
                >
                  <Icon
                    name={icon}
                    size={18}
                    color={t.id === activeId ? colors.primary : colors.textMuted}
                  />
                  <View className="flex-1">
                    <View className="flex-row items-baseline gap-2">
                      <Text weight="bold" className="flex-1 text-base" numberOfLines={1}>
                        {t.title}
                      </Text>
                      <Text className="text-xs text-ink-faint">{when(t.updatedAt)}</Text>
                    </View>
                    <Text muted className="mt-0.5 text-sm leading-5" numberOfLines={1}>
                      {preview(messages[t.id]) || model.name}
                    </Text>
                  </View>
                  <Tap
                    accessibilityLabel={`Options for ${t.title}`}
                    hitSlop={8}
                    onPress={() => setMenuFor(t)}
                  >
                    <Icon name="ellipsis-horizontal" size={16} color={colors.textFaint} />
                  </Tap>
                </Tap>
                </Animated.View>
              );
            })}
          </Group>
        ))}
      </Page>

      <Sheet
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        title={menuFor?.title}
        subtitle={
          menuFor
            ? `${findModel(models, menuFor.modelRef).name}, ${messages[menuFor.id]?.length ?? 0} messages`
            : undefined
        }
      >
        <View className="gap-2">
          <ActionButton
            variant="secondary"
            icon="open-outline"
            label="Open chat"
            onPress={() => {
              if (menuFor) open(menuFor.id);
              setMenuFor(null);
            }}
          />
          <ActionButton
            variant="danger-soft"
            icon="trash-outline"
            label="Delete chat"
            onPress={() => {
              if (menuFor) deleteThread(menuFor.id);
              setMenuFor(null);
              showToast("Chat deleted");
            }}
          />
        </View>
      </Sheet>
    </View>
  );
}
