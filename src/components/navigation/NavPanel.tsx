import * as Haptics from "expo-haptics";
import { router, type Href } from "expo-router";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, ScrollView, View } from "react-native";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass } from "@/components/ui/Glass";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Display, Text } from "@/components/ui/Text";
import { reflow } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { colors } from "@/lib/theme";
import type { Thread } from "@/lib/types";
import { useDrawer } from "./SideDrawer";
import { threadIcon, ThreadMenu, type ThreadMenuTarget } from "./ThreadMenu";

const destinations: { label: string; icon: IconName; href: Href }[] = [
  { label: "Artifacts", icon: "shapes-outline", href: "/artifacts" },
  { label: "Memory", icon: "sparkles-outline", href: "/memory" },
];

/**
 * Menu rows slide in one after another as the drawer opens. Driven by drawer progress, so a slow
 * drag reveals them slowly and a fast flick snaps them all in.
 */
function Stagger({
  index,
  children,
  reorder,
}: {
  index: number;
  children: ReactNode;
  reorder?: boolean;
}) {
  const { progress } = useDrawer();
  const style = useAnimatedStyle(() => {
    const start = 0.12 + Math.min(index, 12) * 0.03;
    const p = interpolate(progress.get(), [start, start + 0.42], [0, 1], "clamp");
    return { opacity: p, transform: [{ translateX: (1 - p) * -22 }] };
  });
  return (
    <Animated.View layout={reorder ? reflow : undefined}>
      <Animated.View style={style}>{children}</Animated.View>
    </Animated.View>
  );
}

/** Drawer contents: destinations, recent chats, then settings and a new-chat button pinned to the bottom. */
export function NavPanel() {
  const insets = useSafeAreaInsets();
  const { close } = useDrawer();
  const threads = useApp((s) => s.threads);
  const activeId = useApp((s) => s.activeThreadId);
  const streamingId = useApp((s) => s.streaming?.threadId);
  const openThread = useApp((s) => s.openThread);
  const newChat = useApp((s) => s.newChat);
  const rows = useRef(new Map<string, View>());
  const [menu, setMenu] = useState<ThreadMenuTarget | null>(null);

  // Pinned chats stay at the top (latest pin first); the six most recent of the rest follow.
  const recents = useMemo(() => {
    // Incognito chats are never kept, so they never appear here.
    const all = Object.values(threads).filter((t) => !t.incognito);
    const pinned = all.filter((t) => t.pinnedAt).sort((a, b) => b.pinnedAt! - a.pinnedAt!);
    const rest = all
      .filter((t) => !t.pinnedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6);
    return [...pinned, ...rest];
  }, [threads]);

  /** Lifts the pressed row into the context menu, anchored to where it sits on screen. */
  const openMenu = (t: Thread) => {
    if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    rows.current
      .get(t.id)
      ?.measureInWindow((x, y, width, height) =>
        setMenu({ thread: t, anchor: { x, y, width, height } })
      );
  };

  // The screen slides over the open drawer, which shuts once covered (see SideDrawer): one motion
  // instead of the drawer closing while the screen pushes. Web has no native transition to wait for.
  const go = (href: Href) => {
    if (Platform.OS === "web") close();
    router.push(href);
  };

  return (
    <View className="flex-1" style={{ paddingTop: insets.top + 10 }}>
      <Stagger index={0}>
        <View className="flex-row items-center justify-between pl-5 pr-4">
          <Display className="text-[26px] leading-8">Anomaly</Display>
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Search chats"
            onPress={() => go("/history?search=1")}
          >
            <Glass radius={24} interactive>
              <View className="h-12 w-12 items-center justify-center">
                <Icon name="search" size={21} />
              </View>
            </Glass>
          </Tap>
        </View>
      </Stagger>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 20, paddingBottom: 16 }}
      >
        {destinations.map((d, i) => (
          <Stagger key={d.label} index={i + 1}>
            <Tap
              accessibilityRole="link"
              onPress={() => go(d.href)}
              className="flex-row items-center gap-4 rounded-2xl px-3 py-3"
            >
              <Icon name={d.icon} size={22} color={colors.text} />
              <Text className="text-[18px] leading-6">{d.label}</Text>
            </Tap>
          </Stagger>
        ))}

        <Stagger index={3}>
          <Text muted weight="medium" className="mb-1.5 mt-6 px-3 text-[15px]">
            Recents
          </Text>
        </Stagger>
        {recents.length === 0 ? (
          <Text className="px-3 py-2 text-[15px] text-ink-faint">
            Your chats will show up here.
          </Text>
        ) : null}
        {recents.map((t, i) => {
          const active = t.id === activeId;
          return (
            <Stagger key={t.id} index={4 + i} reorder>
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
                  accessibilityState={{ selected: active }}
                  accessibilityHint="Long press to pin, rename or delete"
                  accessibilityActions={[{ name: "longpress", label: "Chat options" }]}
                  onAccessibilityAction={() => openMenu(t)}
                  onPress={() => {
                    openThread(t.id);
                    close();
                  }}
                  onLongPress={() => openMenu(t)}
                  delayLongPress={380}
                  className={`flex-row items-center gap-4 rounded-2xl px-3 py-3 ${active ? "bg-white/10" : ""}`}
                >
                  <Icon
                    name={threadIcon(t)}
                    size={20}
                    color={active ? colors.text : colors.textMuted}
                  />
                  <Text className="flex-1 text-[17px] leading-6" numberOfLines={1}>
                    {t.title}
                  </Text>
                  {streamingId === t.id ? (
                    <View
                      accessibilityLabel="Replying"
                      className="h-2 w-2 rounded-full bg-primary"
                    />
                  ) : t.pinnedAt ? (
                    <View accessibilityLabel="Pinned">
                      <Icon name="pin" size={15} color={colors.textFaint} />
                    </View>
                  ) : null}
                </Tap>
              </View>
            </Stagger>
          );
        })}
        <Stagger index={4 + recents.length}>
          <Tap
            accessibilityRole="link"
            onPress={() => go("/history")}
            className="flex-row items-center gap-1 self-start rounded-2xl px-3 py-3"
          >
            <Text muted className="text-[16px]">
              View all
            </Text>
            <Icon name="chevron-forward" size={16} color={colors.textMuted} />
          </Tap>
        </Stagger>
      </ScrollView>

      <Stagger index={12}>
        <View
          className="flex-row items-center justify-between px-4"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 4 }}
        >
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={() => go("/settings")}
            className="h-[52px] w-[52px] items-center justify-center rounded-full bg-raised"
          >
            <Icon name="settings-outline" size={22} />
          </Tap>
          <Tap
            haptic
            accessibilityRole="button"
            onPress={() => {
              newChat();
              close();
            }}
            className="h-[52px] flex-row items-center gap-2 rounded-full bg-ink pl-5 pr-6"
          >
            <Icon name="add" size={22} color="#000" />
            <Text weight="bold" className="text-[17px] text-black">
              New chat
            </Text>
          </Tap>
        </View>
      </Stagger>

      <ThreadMenu target={menu} onClose={() => setMenu(null)} />
    </View>
  );
}
