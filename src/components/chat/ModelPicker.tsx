import { router } from "expo-router";
import { useMemo, useState, type ReactNode } from "react";
import {
  Keyboard,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import Reanimated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FormSheet, GROUP_BG, floatingSheetBox } from "@/components/ui/FormSheet";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { modelRef } from "@/lib/models";
import { findModel, useApp } from "@/lib/store";
import { colors, fonts, LIST_RADIUS } from "@/lib/theme";

import type { Model } from "@/lib/types";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { clampedOut } from "@/lib/motion";

/** Space between the bottom of a page's scroll window and the sheet's edge. */
const WINDOW_GAP = 12;

export function levelLabel(level: string): string {
  if (level === "auto") return "Auto";
  if (level === "off") return "Off";
  if (level === "on") return "On";
  if (level === "xhigh") return "Extra high";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** What each thinking level means for the person asking, not for the API. */
const LEVEL_HINT: Record<string, string> = {
  auto: "Chooses a level for each message",
  off: "Answers right away",
  on: "Thinks before answering",
  minimal: "A moment of thought",
  low: "Quick thinking for simple asks",
  medium: "Balanced depth and speed",
  high: "Thorough, takes longer",
  xhigh: "Very thorough, slow",
  max: "Deepest thinking, slowest",
  none: "No thinking at all",
};

function contextLabel(n: number) {
  return n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M context`
    : `${Math.round(n / 1000)}K context`;
}

function Divider() {
  return <View pointerEvents="none" style={styles.divider} />;
}

function Group({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <View className="mb-5">
      <View style={styles.group}>{children}</View>
      {footer ? <View className="mt-2 px-4">{footer}</View> : null}
    </View>
  );
}

function Row({
  title,
  subtitle,
  badge,
  value,
  selected,
  chevron,
  last,
  onPress,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  value?: string;
  selected?: boolean;
  chevron?: boolean;
  last?: boolean;
  onPress: () => void;
}) {
  return (
    <Tap
      haptic={selected !== undefined}
      accessibilityRole={selected === undefined ? "button" : "radio"}
      accessibilityState={selected === undefined ? undefined : { selected }}
      accessibilityLabel={[title, badge, value, subtitle].filter(Boolean).join(", ")}
      onPress={onPress}
      style={styles.row}
    >
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="shrink text-[17px] leading-[22px]" numberOfLines={1}>
            {title}
          </Text>
          {badge ? (
            <View style={styles.badge}>
              <Text weight="medium" className="text-xs" style={{ color: colors.textMuted }}>
                {badge}
              </Text>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Text muted className="text-[14px] leading-[19px]" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text muted className="text-[17px]" numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {selected ? <Icon name="checkmark" size={22} color={colors.primaryStrong} /> : null}
      {chevron ? <Icon name="chevron-forward" size={17} color={colors.textFaint} /> : null}
      {last ? null : <Divider />}
    </Tap>
  );
}

type Sub = "thinking" | "all";
type Page = "main" | Sub;

/** Push and pop between pages: a quick ease-out that settles without a bounce, as in iOS. */
const SLIDE = { duration: 380, easing: clampedOut };

/**
 * Model and thinking level in one sheet, the iOS way: the models you use on top, a Thinking row
 * that slides in its own page, and every model behind More models. Every page has the same height
 * (the taller of the first two), so the sheet holds still while pages slide; a swipe from the
 * left goes back. Without `level` (Settings) it only picks a model.
 */
export function ModelPicker({
  open,
  onClose,
  value: requested,
  onSelect,
  title = "Select model",
  level,
  onLevel,
}: {
  open: boolean;
  onClose: () => void;
  value: string;
  onSelect: (ref: string) => void;
  title?: string;
  level?: string;
  onLevel?: (level: string) => void;
}) {
  const providers = useApp((s) => s.providers);
  const models = useApp((s) => s.models);
  const threads = useApp((s) => s.threads);
  const settings = useApp((s) => s.settings);
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const box = floatingSheetBox(screen, insets.top);
  const W = box.width;
  const reduced = useReducedMotion();
  const [page, setPage] = useState<Page>("main");
  const [sub, setSub] = useState<Sub>("thinking");
  const [query, setQuery] = useState("");
  const [mainH, setMainH] = useState(0);
  const [thinkH, setThinkH] = useState(0);
  /** 0 shows the first page, 1 the page pushed on top of it. */
  const slide = useSharedValue(0);

  const go = (next: Page) => {
    Keyboard.dismiss();
    if (next !== "main") setSub(next);
    setPage(next);
    const to = next === "main" ? 0 : 1;
    slide.set(reduced ? to : withTiming(to, SLIDE));
  };
  const popped = () => {
    Keyboard.dismiss();
    setPage("main");
  };

  // Swipe right on a pushed page to go back, following the finger on the UI thread.
  const back = Gesture.Pan()
    .enabled(page !== "main")
    .activeOffsetX(12)
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      slide.set(Math.min(1, Math.max(0, 1 - e.translationX / W)));
    })
    .onEnd((e) => {
      if (e.translationX > W * 0.32 || e.velocityX > 600) {
        slide.set(withTiming(0, SLIDE));
        scheduleOnRN(popped);
      } else slide.set(withTiming(1, SLIDE));
    });

  const firstStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: -slide.get() * W }],
      opacity: interpolate(slide.get(), [0, 1], [1, 0.4]),
    }),
    [W]
  );
  const pushedStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: (1 - slide.get()) * W }],
      opacity: interpolate(slide.get(), [0, 1], [0.4, 1]),
    }),
    [W]
  );

  const pick = (ref: string) => {
    onSelect(ref);
    onClose();
  };
  const providerLabel = (id: string) => providers.find((p) => p.providerId === id)?.label ?? id;
  const describe = (m: Model) => `${providerLabel(m.providerId)}, ${contextLabel(m.contextWindow)}`;
  // An unset choice falls back to a model; mark that one, as the composer shows it.
  const resolved = findModel(models, requested);
  const value = resolved.providerId ? modelRef(resolved) : requested;

  // The models you reach for: this one, those of your latest chats, then your defaults.
  const recent = useMemo(() => {
    const byRef = new Map(models.map((m) => [modelRef(m), m]));
    const refs = [
      value,
      ...Object.values(threads)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((t) => t.modelRef),
      settings.defaultModelRef,
      settings.researchModelRef ?? "",
    ];
    const out: Model[] = [];
    for (const ref of refs) {
      const m = byRef.get(ref);
      if (m && !out.includes(m)) out.push(m);
      if (out.length === 5) break;
    }
    return out.length ? out : models.slice(0, 4);
  }, [models, threads, settings.defaultModelRef, settings.researchModelRef, value]);

  // What shapes the sheet is held from the moment it opens until it has slid away, so a pick
  // doesn't reorder the list or resize the sheet on its way out. Only the checkmark moves.
  const [held, setHeld] = useState<{ value: string; short: Model[] } | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setHeld({ value, short: recent });
  }
  const short = held?.short ?? recent;
  const current = models.find((m) => modelRef(m) === (held?.value ?? value));
  /** Back to the first page once out of sight, ready for the next open. */
  const reset = () => {
    setHeld(null);
    setPage("main");
    setQuery("");
    slide.set(0);
  };

  const reasoning = current?.profile.reasoning;
  const thinking = Boolean(
    level !== undefined && onLevel && reasoning && reasoning.style !== "none"
  );
  // "None" is what Off already sends to models that have it.
  const levels = reasoning
    ? ["auto", "off", ...reasoning.levels.filter((l) => !["off", "auto", "none"].includes(l))]
    : [];
  // Pages scroll inside a rounded window that ends WINDOW_GAP above the sheet's bottom edge.
  const bodyH = Math.min(box.maxBody, Math.max(mainH, thinking ? thinkH : 0) + WINDOW_GAP);
  const inner = W - 32;

  const manage = () => {
    onClose();
    router.push("/settings");
  };

  const thinkingPage =
    thinking && reasoning && onLevel ? (
      <Group
        footer={
          <Text muted className="text-[13px] leading-[18px]">
            {reasoning.noop
              ? "This endpoint accepted the setting but used no thinking in testing, so the level may make no difference."
              : "Higher levels think longer before answering: more thorough, but slower, and they use more tokens."}
          </Text>
        }
      >
        {levels.map((l, i) => (
          <Row
            key={l}
            title={levelLabel(l)}
            subtitle={LEVEL_HINT[l]}
            badge={l === reasoning.defaultLevel && l !== "auto" ? "Recommended" : undefined}
            selected={l === level}
            last={i === levels.length - 1}
            onPress={() => {
              onLevel(l);
              // Let the checkmark land before the page slides away.
              setTimeout(() => go("main"), 160);
            }}
          />
        ))}
      </Group>
    ) : null;

  const firstPage =
    models.length === 0 ? (
      <Group
        footer={
          <Text muted className="text-[13px] leading-[18px]">
            Models come from your own endpoints. Add one to start chatting.
          </Text>
        }
      >
        <Row title="Add a provider" chevron last onPress={manage} />
      </Group>
    ) : (
      <>
        <Group>
          {short.map((m, i) => (
            <Row
              key={modelRef(m)}
              title={m.name}
              subtitle={describe(m)}
              selected={modelRef(m) === value}
              last={i === short.length - 1}
              onPress={() => pick(modelRef(m))}
            />
          ))}
        </Group>
        {thinking && level !== undefined ? (
          <Group>
            <Row
              title="Thinking"
              value={levelLabel(level)}
              chevron
              last
              onPress={() => go("thinking")}
            />
          </Group>
        ) : null}
        <Group>
          <Row
            title="More models"
            value={String(models.length)}
            chevron
            onPress={() => go("all")}
          />
          <Row title="Manage providers" chevron last onPress={manage} />
        </Group>
      </>
    );

  const q = query.trim().toLowerCase();
  const LIMIT = 40;
  const allPage = (
    <View style={{ flex: 1 }}>
      <View style={[styles.search, { marginHorizontal: 16 }]}>
        <Icon name="search" size={16} color={colors.textFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={`Search ${models.length} models`}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search models"
          style={styles.input}
        />
      </View>
      <ScrollView
        style={styles.window}
        contentContainerStyle={styles.pageBody}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        {providers.map((p) => {
          const matching = models.filter(
            (m) =>
              m.providerId === p.providerId && (!q || `${m.name} ${m.id}`.toLowerCase().includes(q))
          );
          const list = matching.slice(0, LIMIT);
          if (list.length === 0) return null;
          return (
            <View key={p.providerId}>
              <Text weight="medium" muted className="mb-2 px-4 text-[13px]">
                {p.label}
              </Text>
              <Group
                footer={
                  matching.length > LIMIT ? (
                    <Text muted className="text-[13px]">
                      {`${matching.length - LIMIT} more. Search to find them.`}
                    </Text>
                  ) : undefined
                }
              >
                {list.map((m, i) => (
                  <Row
                    key={modelRef(m)}
                    title={m.name}
                    subtitle={contextLabel(m.contextWindow)}
                    selected={modelRef(m) === value}
                    last={i === list.length - 1}
                    onPress={() => pick(modelRef(m))}
                  />
                ))}
              </Group>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      fit
      bare
      keepMounted
      onHidden={reset}
      title={page === "thinking" ? "Thinking" : page === "all" ? "All models" : title}
      leading={
        page === "main"
          ? undefined
          : { label: "Back", icon: "chevron-back", onPress: () => go("main") }
      }
    >
      <View style={{ width: W, height: bodyH, overflow: "hidden" }}>
        {/* Sizes the sheet: the thinking page is measured even before it is shown. */}
        {thinkingPage ? (
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onLayout={(e) => setThinkH(e.nativeEvent.layout.height)}
            style={[styles.measure, styles.pageBody, { width: inner }]}
          >
            {thinkingPage}
          </View>
        ) : null}
        <Reanimated.View
          accessibilityElementsHidden={page !== "main"}
          importantForAccessibility={page === "main" ? "auto" : "no-hide-descendants"}
          style={[styles.page, { width: W, height: bodyH }, firstStyle]}
        >
          <ScrollView
            style={styles.window}
            showsVerticalScrollIndicator={false}
            bounces={mainH + WINDOW_GAP > bodyH}
          >
            <View style={styles.pageBody} onLayout={(e) => setMainH(e.nativeEvent.layout.height)}>
              {firstPage}
            </View>
          </ScrollView>
        </Reanimated.View>
        <GestureDetector gesture={back}>
          <Reanimated.View
            accessibilityElementsHidden={page === "main"}
            importantForAccessibility={page === "main" ? "no-hide-descendants" : "auto"}
            style={[styles.page, { width: W, height: bodyH }, pushedStyle]}
          >
            {sub === "all" ? (
              allPage
            ) : (
              <ScrollView
                style={styles.window}
                showsVerticalScrollIndicator={false}
                bounces={thinkH + WINDOW_GAP > bodyH}
              >
                <View style={styles.pageBody}>{thinkingPage}</View>
              </ScrollView>
            )}
          </Reanimated.View>
        </GestureDetector>
      </View>
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  page: { position: "absolute", top: 0, left: 0 },
  pageBody: { paddingTop: 6, paddingBottom: 8 },
  /** A rounded scroll window: a long list scrolled under the toolbar keeps its corners. */
  window: {
    flex: 1,
    marginHorizontal: 16,
    marginBottom: WINDOW_GAP,
    borderRadius: LIST_RADIUS,
    overflow: "hidden",
  },
  measure: { position: "absolute", top: 0, left: 0, opacity: 0 },
  group: { backgroundColor: GROUP_BG, borderRadius: LIST_RADIUS, overflow: "hidden" },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  divider: {
    position: "absolute",
    left: 18,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    marginBottom: 16,
    borderRadius: 16,
    backgroundColor: GROUP_BG,
  },
  input: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.text,
    paddingVertical: 12,
  },
});
