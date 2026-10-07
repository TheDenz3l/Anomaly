import { router } from "expo-router";
import { useMemo, useState, type ReactNode, useRef } from "react";
import {
  Keyboard,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  FlatList,
} from "react-native";
import Reanimated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FormSheet, GROUP_BG, floatingSheetBox, TOOLBAR_H } from "@/components/ui/FormSheet";
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

/** How much of what follows the Thinking row shows at the screen's edge before the sheet is pulled up. */
const PEEK = 22;

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

function contextShort(n: number) {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

function contextLabel(n: number) {
  return `${contextShort(n)} context`;
}

function Divider() {
  return <View pointerEvents="none" style={styles.divider} />;
}

/** A provider in the row pinned over the full list: its scope, and a filter when there are several. */
function ProviderChip({
  label,
  count,
  on,
  onPress,
}: {
  label: string;
  count: number;
  on: boolean;
  onPress?: () => void;
}) {
  return (
    <Tap
      haptic={Boolean(onPress)}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityState={onPress ? { selected: on } : undefined}
      accessibilityLabel={`${label}, ${count} models`}
      onPress={onPress}
      style={[styles.chip, on ? styles.chipOn : null]}
    >
      <Text weight="medium" className="text-[14px]" style={{ color: on ? "#000" : colors.text }}>
        {label}
      </Text>
      <Text className="text-[14px]" style={{ color: on ? "rgba(0,0,0,0.5)" : colors.textMuted }}>
        {count}
      </Text>
    </Tap>
  );
}

/**
 * A row of the full list. One line, so more of the list fits above the keyboard while searching;
 * the part of the name that matches the search is set in bold.
 */
function ModelRow({
  name,
  meta,
  query,
  selected,
  first,
  last,
  onPress,
}: {
  name: string;
  meta: string;
  query: string;
  selected: boolean;
  first: boolean;
  last: boolean;
  onPress: () => void;
}) {
  const at = query ? name.toLowerCase().indexOf(query) : -1;
  return (
    <Tap
      haptic
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${name}, ${meta}`}
      onPress={onPress}
      style={[styles.slim, first && styles.slimFirst, last && styles.slimLast]}
    >
      <Text className="flex-1 text-[17px] leading-[22px]" numberOfLines={1}>
        {at < 0 ? (
          name
        ) : (
          <>
            {name.slice(0, at)}
            <Text weight="bold" className="text-[17px] leading-[22px]">
              {name.slice(at, at + query.length)}
            </Text>
            {name.slice(at + query.length)}
          </>
        )}
      </Text>
      <Text muted className="text-[15px]" numberOfLines={1}>
        {meta}
      </Text>
      <View style={styles.check}>
        {selected ? <Icon name="checkmark" size={20} color={colors.primaryStrong} /> : null}
      </View>
      {last ? null : <Divider />}
    </Tap>
  );
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
  /** Where the Thinking row's group ends on the first page, gap included. */
  const [fold, setFold] = useState(0);
  /** Closing to open Settings: the keyboard stays down. */
  const [leaving, setLeaving] = useState(false);
  const mainScroll = useRef<ScrollView>(null);
  /** The provider the full list is narrowed to; null for all of them. */
  const [provider, setProvider] = useState<string | null>(null);
  const allList = useRef<FlatList<Model>>(null);
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
    setLeaving(false);
    setProvider(null);
    slide.set(0);
    mainScroll.current?.scrollTo({ y: 0, animated: false });
    allList.current?.scrollToOffset({ offset: 0, animated: false });
  };

  const reasoning = current?.profile.reasoning;
  const thinking = Boolean(
    level !== undefined && onLevel && reasoning && reasoning.style !== "none"
  );
  // "None" is what Off already sends to models that have it.
  const levels = reasoning
    ? ["auto", "off", ...reasoning.levels.filter((l) => !["off", "auto", "none"].includes(l))]
    : [];
  // The sheet is built at full height and rests lowered so that only what a page needs shows,
  // so nothing scrolls. With Thinking on offer the first page stops just past the Thinking row,
  // the top of the next group showing at the screen's edge, and pulls up for the rest; the
  // Thinking page shows whole. The full list stands at full height, room left above the keyboard.
  const bodyH = box.maxBody;
  /** Room under a page's last line for the home indicator, when the sheet rests lowered. */
  const clear = Math.max(0, insets.bottom - 20);
  const detent =
    page === "all"
      ? undefined
      : page === "thinking"
        ? TOOLBAR_H + thinkH + clear
        : thinking
          ? TOOLBAR_H + fold + PEEK
          : TOOLBAR_H + mainH + clear;

  const manage = () => {
    setLeaving(true);
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
          <View onLayout={(e) => setFold(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
            <Group>
              <Row
                title="Thinking"
                value={levelLabel(level)}
                chevron
                last
                onPress={() => go("thinking")}
              />
            </Group>
          </View>
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

  // The full list. The search field and the provider stay pinned above it and never scroll away;
  // with several providers they are filters. Results are one line each, so plenty stay in sight
  // above the keyboard.
  const q = query.trim().toLowerCase();
  const multi = providers.length > 1;
  const scope = multi ? provider : (providers[0]?.providerId ?? null);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of models) out.set(m.providerId, (out.get(m.providerId) ?? 0) + 1);
    return out;
  }, [models]);
  const results = useMemo(
    () =>
      models.filter(
        (m) =>
          (!scope || m.providerId === scope) &&
          (!q || `${m.name} ${m.id}`.toLowerCase().includes(q))
      ),
    [models, scope, q]
  );
  const inScope = scope ? (counts.get(scope) ?? 0) : models.length;
  const toTop = () => allList.current?.scrollToOffset({ offset: 0, animated: false });
  const search = (text: string) => {
    setQuery(text);
    toTop();
  };
  const narrow = (id: string | null) => {
    setProvider(id);
    toTop();
  };
  const allPage = (
    <View style={{ flex: 1 }}>
      <View style={styles.pinned}>
        <View style={styles.search}>
          <Icon name="search" size={16} color={colors.textFaint} />
          <TextInput
            value={query}
            onChangeText={search}
            placeholder={`Search ${inScope} models`}
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search models"
            style={styles.input}
          />
          {query ? (
            <Tap accessibilityLabel="Clear search" hitSlop={10} onPress={() => search("")}>
              <Icon name="close-circle" size={18} color={colors.textFaint} />
            </Tap>
          ) : null}
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.chips}
        >
          {multi ? (
            <ProviderChip
              label="All"
              count={models.length}
              on={scope === null}
              onPress={() => narrow(null)}
            />
          ) : null}
          {providers.map((p) => (
            <ProviderChip
              key={p.providerId}
              label={p.label}
              count={counts.get(p.providerId) ?? 0}
              on={scope === p.providerId}
              onPress={multi ? () => narrow(p.providerId) : undefined}
            />
          ))}
        </ScrollView>
      </View>
      <FlatList
        ref={allList}
        data={results}
        keyExtractor={(m) => modelRef(m)}
        renderItem={({ item, index }) => (
          <ModelRow
            name={item.name}
            meta={
              multi && !scope
                ? `${providerLabel(item.providerId)}, ${contextShort(item.contextWindow)}`
                : contextShort(item.contextWindow)
            }
            query={q}
            selected={modelRef(item) === value}
            first={index === 0}
            last={index === results.length - 1}
            onPress={() => pick(modelRef(item))}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text muted className="text-center text-[15px] leading-[21px]">
              {q ? `No models match \u201C${query.trim()}\u201D.` : "No models here yet."}
            </Text>
            {q ? (
              <Tap accessibilityRole="button" hitSlop={8} onPress={() => search("")}>
                <Text
                  weight="medium"
                  className="text-[15px]"
                  style={{ color: colors.primaryStrong }}
                >
                  Clear search
                </Text>
              </Tap>
            ) : null}
          </View>
        }
        style={styles.window}
        contentContainerStyle={styles.pageBody}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        initialNumToRender={16}
      />
    </View>
  );

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      fit
      bare
      keepMounted
      restoreFocus={!leaving}
      onHidden={reset}
      detent={detent}
      expandable={page === "main" && thinking}
      expandTo={TOOLBAR_H + mainH + clear}
      title={page === "thinking" ? "Thinking" : page === "all" ? "All models" : title}
      leading={
        page === "main"
          ? undefined
          : { label: "Back", icon: "chevron-back", onPress: () => go("main") }
      }
    >
      <View style={{ width: W, height: bodyH, overflow: "hidden" }}>
        <Reanimated.View
          accessibilityElementsHidden={page !== "main"}
          importantForAccessibility={page === "main" ? "auto" : "no-hide-descendants"}
          style={[styles.page, { width: W, height: bodyH }, firstStyle]}
        >
          <ScrollView
            ref={mainScroll}
            style={styles.window}
            scrollEnabled={mainH > bodyH}
            showsVerticalScrollIndicator={false}
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
                scrollEnabled={thinkH > bodyH}
                showsVerticalScrollIndicator={false}
              >
                <View
                  style={styles.pageBody}
                  onLayout={(e) => setThinkH(e.nativeEvent.layout.height)}
                >
                  {thinkingPage}
                </View>
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
  /**
   * The scroll window: rounded at the top, so a list scrolled under the toolbar keeps its corners,
   * and open at the bottom, where the list runs into the sheet's own rounded edge.
   */
  window: {
    flex: 1,
    marginHorizontal: 16,
    borderTopLeftRadius: LIST_RADIUS,
    borderTopRightRadius: LIST_RADIUS,
    overflow: "hidden",
  },
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
  /** Search and providers, held above the full list. */
  pinned: { paddingHorizontal: 16, paddingBottom: 10, gap: 10 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: GROUP_BG,
  },
  chips: { gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: GROUP_BG,
  },
  chipOn: { backgroundColor: "#F2F2F4" },
  slim: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: GROUP_BG,
  },
  slimFirst: { borderTopLeftRadius: LIST_RADIUS, borderTopRightRadius: LIST_RADIUS },
  slimLast: { borderBottomLeftRadius: LIST_RADIUS, borderBottomRightRadius: LIST_RADIUS },
  check: { width: 20, alignItems: "flex-end" },
  empty: { paddingTop: 36, paddingHorizontal: 24, alignItems: "center", gap: 14 },
  input: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.text,
    paddingVertical: 12,
  },
});
