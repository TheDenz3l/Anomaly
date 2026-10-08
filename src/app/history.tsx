import { useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { useMemo, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { Glass } from "@/components/ui/Glass";
import { Icon } from "@/components/ui/Icon";
import { Group, Page } from "@/components/ui/Page";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import {
  ThreadMenu,
  type RowLook,
  type ThreadMenuTarget,
} from "@/components/navigation/ThreadMenu";
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
  const { search } = useLocalSearchParams<{ search?: string }>();
  const [query, setQuery] = useState("");
  const rows = useRef(new Map<string, View>());
  const [menu, setMenu] = useState<ThreadMenuTarget | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = Object.values(threads)
      .filter((t) => !t.incognito)
      .filter(
        (t) =>
          !q ||
          t.title.toLowerCase().includes(q) ||
          (preview(messages[t.id]) || t.preview || "").toLowerCase().includes(q)
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

  /**
   * Long press lifts the row into the same menu the side drawer's recents use (pin, rename,
   * delete), drawn exactly as the row looks in its card so nothing changes shape.
   */
  const openMenu = (t: Thread, look: RowLook) => {
    if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    rows.current
      .get(t.id)
      ?.measureInWindow((x, y, width, height) =>
        setMenu({ thread: t, anchor: { x, y, width, height }, look })
      );
  };

  return (
    <View className="flex-1 bg-background">
      <Page
        title="History"
        subtitle={`${Object.values(threads).filter((t) => !t.incognito).length} chats`}
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
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
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
              const look: RowLook = {
                kind: "history",
                detail: preview(messages[t.id]) || t.preview || model.name,
                time: when(t.updatedAt),
                active: t.id === activeId,
                first: i === 0,
                last: i === g.items.length - 1,
              };
              return (
                <Animated.View key={t.id} entering={fadeIn} exiting={fadeOut} layout={reflow}>
                  <View
                    collapsable={false}
                    ref={(node) => {
                      if (!node) return;
                      rows.current.set(t.id, node);
                      return () => {
                        rows.current.delete(t.id);
                      };
                    }}
                  >
                    <Tap
                      accessibilityRole="button"
                      accessibilityLabel={`${t.title}${t.id === activeId ? ", open" : ""}`}
                      accessibilityHint="Long press to pin, rename or delete"
                      accessibilityActions={[{ name: "longpress", label: "Chat options" }]}
                      onAccessibilityAction={() => openMenu(t, look)}
                      onPress={() => open(t.id)}
                      onLongPress={() => openMenu(t, look)}
                      delayLongPress={380}
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
                          {t.pinnedAt ? (
                            <Icon name="pin" size={12} color={colors.textFaint} />
                          ) : null}
                          <Text className="text-xs text-ink-faint">{look.time}</Text>
                        </View>
                        <Text muted className="mt-0.5 text-sm leading-5" numberOfLines={1}>
                          {look.detail}
                        </Text>
                      </View>
                    </Tap>
                  </View>
                </Animated.View>
              );
            })}
          </Group>
        ))}
      </Page>
      <ThreadMenu target={menu} onClose={() => setMenu(null)} />
    </View>
  );
}
