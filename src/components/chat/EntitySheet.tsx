import { useQuery } from "convex/react";
import { Image } from "expo-image";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Reanimated, {
  FadeIn,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import { Glass } from "@/components/ui/Glass";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Portal, useFocusHandoff } from "@/components/ui/Portal";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { api, convex, errorText, type Id } from "@/lib/convex";
import { KIND_LABEL, type EntityKind, type EntityRef } from "@/lib/entities";
import { sheetMotion } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { colors, fonts, hsl, hueFrom } from "@/lib/theme";
import type { Message, Source } from "@/lib/types";
import { CitationProvider } from "./Citations";
import { AskTarget, EntityOpener } from "./entityContext";
import { Markdown } from "./Markdown";
import { AssistantMessage, UserMessage } from "./Messages";

/**
 * Profile sheets. A name marked in a reply opens a sheet about it: photos across the top, the
 * name set over their fade, Wikipedia's overview, then a profile the user's own model writes
 * (convex/engine/profile.ts) with the chat's usual cards and citations, and a box for questions
 * about it. Names inside a profile open the next one, with a way back.
 *
 * The sheet rests at about 60% of the screen. Pulling it up (or scrolling the profile) takes it
 * to full height, where the profile scrolls; pulling down from the top lowers or dismisses it.
 */

type Item = {
  id: string;
  entity: EntityRef;
  /** The profile's chat, once the server has opened it. */
  threadId: Id<"threads"> | null;
  error?: string;
};

const SHEET_BG = "#121214";
const STRIP_H = 296;
const TOP_GAP = 8;
/** How much of the screen the sheet shows at rest. */
const REST = 0.6;
const MARGIN = 30;

const KIND_ICON: Record<EntityKind, IconName> = {
  person: "person",
  place: "location",
  organization: "business",
  work: "albums",
  product: "pricetag",
  event: "calendar",
  thing: "sparkles",
};

let nextId = 0;

/** Holds the stack of open profiles for the chat it wraps, and the sheet that shows them. */
export function EntityProvider({
  threadId,
  children,
}: {
  threadId: string | null;
  children: ReactNode;
}) {
  const [stack, setStack] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);

  const start = useCallback((entity: EntityRef, from: string) => {
    const id = `ent${++nextId}`;
    const patch = (p: Partial<Item>) =>
      setStack((s) => s.map((it) => (it.id === id ? { ...it, ...p } : it)));
    convex
      .mutation(api.entities.open, {
        threadId: from as Id<"threads">,
        name: entity.name,
        kind: entity.kind,
        hint: entity.hint,
      })
      .then((r) => patch({ threadId: r.threadId }))
      .catch((e) => patch({ error: errorText(e) }));
    return { id, entity, threadId: null } satisfies Item;
  }, []);

  const openRoot = useCallback(
    (entity: EntityRef) => {
      if (!threadId || threadId.startsWith("pending_")) return;
      if (Platform.OS === "ios") void Haptics.selectionAsync();
      Keyboard.dismiss();
      setStack([start(entity, threadId)]);
      setOpen(true);
    },
    [threadId, start]
  );

  const push = useCallback(
    (entity: EntityRef, from: string) => {
      const top = stack[stack.length - 1];
      if (top && top.entity.name.toLowerCase() === entity.name.toLowerCase()) return;
      if (Platform.OS === "ios") void Haptics.selectionAsync();
      const next = start(entity, from);
      setStack((s) => [...s, next]);
    },
    [stack, start]
  );

  return (
    <EntityOpener.Provider value={threadId ? openRoot : null}>
      {children}
      <EntitySheet
        open={open}
        stack={stack}
        onClose={() => setOpen(false)}
        onHidden={() => setStack([])}
        onBack={() => setStack((s) => s.slice(0, -1))}
        onPush={push}
      />
    </EntityOpener.Provider>
  );
}

function EntitySheet(props: {
  open: boolean;
  stack: Item[];
  onClose: () => void;
  onHidden: () => void;
  onBack: () => void;
  onPush: (entity: EntityRef, from: string) => void;
}) {
  return (
    <Portal>
      <SheetLayer {...props} />
    </Portal>
  );
}

function SheetLayer({
  open,
  stack,
  onClose,
  onHidden,
  onBack,
  onPush,
}: {
  open: boolean;
  stack: Item[];
  onClose: () => void;
  onHidden: () => void;
  onBack: () => void;
  onPush: (entity: EntityRef, from: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const handoff = useFocusHandoff();
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [expanded, setExpanded] = useState(false);
  // Each opening starts at the resting height.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setExpanded(false);
  }
  const scroller = useRef<Reanimated.ScrollView>(null);

  const sheetH = height - insets.top - TOP_GAP;
  const mid = Math.max(0, sheetH - Math.round(height * REST));
  const gone = sheetH + MARGIN;

  const y = useSharedValue(gone);
  const scrollY = useSharedValue(0);
  const dragStart = useSharedValue(0);
  /** Finger travel spent scrolling the profile, before it reached the top and began to pull. */
  const slack = useSharedValue(0);
  const midY = useSharedValue(mid);
  const goneY = useSharedValue(gone);
  const isExpanded = useSharedValue(false);
  useEffect(() => {
    midY.set(mid);
    goneY.set(gone);
  }, [mid, gone, midY, goneY]);

  const top = stack[stack.length - 1];
  const item = top ? top.id : null;

  /** After a question, the sheet follows the answer down until the user scrolls. */
  const following = useRef(false);
  const asked = () => {
    Keyboard.dismiss();
    settle("full");
    following.current = true;
    scroller.current?.scrollToEnd({ animated: true });
  };

  const settle = (to: "full" | "mid") => {
    const target = to === "full" ? 0 : mid;
    isExpanded.set(to === "full");
    setExpanded(to === "full");
    y.set(reduced ? withTiming(target, { duration: 0 }) : withSpring(target, sheetMotion.open));
  };

  useEffect(() => {
    if (!mounted) return;
    if (open) {
      handoff.take();
      y.set(gone);
      isExpanded.set(false);
      y.set(reduced ? withTiming(mid, { duration: 0 }) : withSpring(mid, sheetMotion.open));
      return;
    }
    handoff.giveBack(false);
    const done = (finished?: boolean) => {
      "worklet";
      if (finished) {
        scheduleOnRN(setMounted, false);
        scheduleOnRN(onHidden);
      }
    };
    y.set(
      reduced
        ? withTiming(gone, { duration: 0 }, done)
        : withSpring(gone, { ...sheetMotion.close }, done)
    );
    // Runs on open/close only; the motion values and setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  // A new profile starts at its top.
  useEffect(() => {
    scroller.current?.scrollTo({ y: 0, animated: false });
    scrollY.set(0);
    following.current = false;
  }, [item, scrollY]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (stack.length > 1) onBack();
      else onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, stack.length, onBack, onClose]);

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.set(e.contentOffset.y);
  });

  const native = Gesture.Native();
  const pan = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .failOffsetX([-14, 14])
    .simultaneousWithExternalGesture(native)
    .onBegin(() => {
      dragStart.set(y.get());
      slack.set(0);
    })
    .onUpdate((e) => {
      // At full height the profile scrolls; the sheet only follows a pull down from its top.
      if (isExpanded.get() && dragStart.get() <= 0.5) {
        if (scrollY.get() > 0.5 || e.translationY - slack.get() < 0) {
          slack.set(e.translationY);
          return;
        }
        y.set(Math.max(0, e.translationY - slack.get()));
        return;
      }
      const raw = dragStart.get() + e.translationY;
      // Above full height the sheet gives a little, like a rubber band.
      y.set(raw < 0 ? raw * 0.2 : raw);
    })
    .onEnd((e) => {
      const at = y.get();
      const rest = midY.get();
      if (at < 1 && isExpanded.get()) return;
      if (at > rest + 110 || (e.velocityY > 900 && at > rest - 40)) {
        y.set(withSpring(goneY.get(), { ...sheetMotion.close, velocity: e.velocityY }));
        scheduleOnRN(onClose);
      } else if (e.velocityY < -450 || (e.velocityY < 450 && at < rest / 2)) {
        isExpanded.set(true);
        scheduleOnRN(setExpanded, true);
        y.set(withSpring(0, { ...sheetMotion.settle, velocity: e.velocityY }));
      } else {
        isExpanded.set(false);
        scheduleOnRN(setExpanded, false);
        y.set(withSpring(rest, { ...sheetMotion.settle, velocity: e.velocityY }));
      }
    });

  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));
  const dim = useAnimatedStyle(() => ({
    opacity: interpolate(y.get(), [midY.get(), goneY.get()], [1, 0], "clamp"),
  }));

  if (!mounted || !top) return null;

  return (
    <View
      accessibilityViewIsModal={open}
      style={[StyleSheet.absoluteFill, { pointerEvents: open ? "auto" : "none" }]}
    >
      <Reanimated.View style={[StyleSheet.absoluteFill, styles.backdrop, dim]}>
        <Pressable accessibilityLabel="Close" style={{ flex: 1 }} onPress={onClose} />
      </Reanimated.View>
      <GestureDetector gesture={pan}>
        <Reanimated.View
          style={[
            styles.sheet,
            { top: insets.top + TOP_GAP, width: Math.min(width, 640), height: sheetH },
            slide,
          ]}
        >
          <GestureDetector gesture={native}>
            <Reanimated.ScrollView
              ref={scroller}
              onScroll={onScroll}
              scrollEventThrottle={16}
              scrollEnabled={expanded}
              bounces={false}
              showsVerticalScrollIndicator={expanded}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
              onScrollBeginDrag={() => {
                following.current = false;
              }}
              onContentSizeChange={() => {
                if (following.current) scroller.current?.scrollToEnd({ animated: true });
              }}
            >
              <Profile
                key={top.id}
                item={top}
                width={Math.min(width, 640)}
                onPush={onPush}
                onAsked={asked}
              />
            </Reanimated.ScrollView>
          </GestureDetector>
          <View pointerEvents="none" style={styles.grabberWrap}>
            <View style={styles.grabber} />
          </View>
          <View pointerEvents="box-none" style={styles.chrome}>
            {stack.length > 1 ? (
              <ChromeButton icon="chevron-back" label="Back" onPress={onBack} />
            ) : (
              <View />
            )}
            <ChromeButton icon="close" label="Close" onPress={onClose} />
          </View>
        </Reanimated.View>
      </GestureDetector>
      <AskBar
        key={top.id}
        item={top}
        y={y}
        mid={mid}
        bottomInset={insets.bottom}
        onFocus={() => settle("full")}
        onAsked={asked}
      />
    </View>
  );
}

function ChromeButton({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Tap accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8}>
      <Glass radius={18} interactive>
        <View style={styles.chromeButton}>
          <Icon name={icon} size={19} color={colors.text} />
        </View>
      </Glass>
    </Tap>
  );
}

/** "Wikipedia" under the overview: the article the sheet's first lines come from. */
function wikiSource(url: string, title: string): Source {
  return { id: "src_wiki", url, title: `${title} - Wikipedia`, snippet: "", origin: "app" };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One profile: photos, name, overview, the model's profile and any questions asked about it. */
function Profile({
  item,
  width,
  onPush,
  onAsked,
}: {
  item: Item;
  width: number;
  onPush: (entity: EntityRef, from: string) => void;
  onAsked: () => void;
}) {
  const data = useQuery(api.entities.sheet, item.threadId ? { threadId: item.threadId } : "skip");
  const card = data?.entity.card;
  const messages = (data?.messages ?? []) as unknown as Message[];
  // The chat opens with the app's request for the profile; the sheet starts at its answer.
  const first = messages.findIndex((m) => m.role === "assistant");
  const profile = first >= 0 ? messages[first] : undefined;
  const after = first >= 0 ? messages.slice(first + 1) : [];
  const name = card?.title || item.entity.name;
  const about = card?.description
    ? capitalize(card.description)
    : item.entity.hint
      ? capitalize(item.entity.hint)
      : KIND_LABEL[item.entity.kind];
  const looking = !item.error && card === undefined;
  const photos = card?.images ?? [];
  const threadId = item.threadId;

  const openHere = useMemo(
    () => (threadId ? (e: EntityRef) => onPush(e, threadId) : null),
    [threadId, onPush]
  );
  const ask = useMemo(
    () =>
      threadId
        ? (text: string) => {
            onAsked();
            void convex
              .mutation(api.messages.send, { threadId, text })
              .catch((e) => useApp.getState().showToast(errorText(e), "danger"));
          }
        : null,
    [threadId, onAsked]
  );
  const regenerate = useCallback((messageId: string) => {
    void convex
      .mutation(api.messages.regenerate, { messageId: messageId as Id<"messages"> })
      .catch((e) => useApp.getState().showToast(errorText(e), "danger"));
  }, []);
  const overview = useMemo(
    () => (card?.url && card.extract ? [wikiSource(card.url, card.title)] : []),
    [card]
  );
  const text = profile?.parts.some((p) => p.type === "text" && p.text.trim()) ?? false;

  return (
    <EntityOpener.Provider value={openHere}>
      <AskTarget.Provider value={ask}>
        <Reanimated.View entering={FadeIn.duration(220)}>
          {looking ? (
            <StripSkeleton width={width} />
          ) : photos.length ? (
            <PhotoStrip images={photos} width={width} name={name} />
          ) : (
            <View style={{ height: 76 }} />
          )}
          <View style={[styles.head, photos.length || looking ? styles.headOver : null]}>
            {!looking && !photos.length ? <KindBadge kind={item.entity.kind} name={name} /> : null}
            <Text accessibilityRole="header" style={styles.name}>
              {name}
            </Text>
            <Text muted style={styles.about} numberOfLines={2}>
              {about}
            </Text>
          </View>
          <View style={styles.body}>
            {item.error ? (
              <Text muted className="text-base leading-6">
                {`Couldn't open this profile. ${item.error}`}
              </Text>
            ) : null}
            {overview.length && card?.extract ? (
              <CitationProvider sources={overview}>
                <Markdown text={`${card.extract} [1]`} />
              </CitationProvider>
            ) : null}
            {profile ? (
              <AssistantMessage message={profile} last={!after.length} onRegenerate={regenerate} />
            ) : null}
            {!item.error && !text ? <BodySkeleton /> : null}
            {after.map((m, i) => (
              <View key={m.id} style={{ marginTop: m.role === "user" ? 10 : 0 }}>
                {m.role === "user" ? (
                  <UserMessage message={m} />
                ) : (
                  <AssistantMessage
                    message={m}
                    last={i === after.length - 1}
                    onRegenerate={regenerate}
                  />
                )}
              </View>
            ))}
          </View>
        </Reanimated.View>
      </AskTarget.Provider>
    </EntityOpener.Provider>
  );
}

/** With no photo to show, the sheet leads with a mark for what kind of thing it is. */
function KindBadge({ kind, name }: { kind: EntityKind; name: string }) {
  const hue = hueFrom(name);
  return (
    <View style={[styles.badge, { backgroundColor: hsl(hue, 42, 22) }]}>
      <Icon name={KIND_ICON[kind]} size={24} color={hsl(hue, 70, 78)} />
    </View>
  );
}

/**
 * Photos edge to edge across the top, each at its own shape, fading into the sheet at the bottom
 * so the name can sit over them. One photo fills the width.
 */
function PhotoStrip({ images, width, name }: { images: string[]; width: number; name: string }) {
  return (
    <View style={{ height: STRIP_H }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        contentContainerStyle={{ gap: 3 }}
      >
        {images.map((url, i) => (
          <StripPhoto
            key={url}
            url={url}
            index={i}
            alone={images.length === 1}
            width={width}
            label={i === 0 ? `Photo of ${name}` : `Photo ${i + 1} of ${name}`}
          />
        ))}
      </ScrollView>
      <View pointerEvents="none" style={styles.fade}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={SHEET_BG} stopOpacity={0} />
              <Stop offset="0.62" stopColor={SHEET_BG} stopOpacity={0.78} />
              <Stop offset="1" stopColor={SHEET_BG} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#fade)" />
        </Svg>
      </View>
    </View>
  );
}

function StripPhoto({
  url,
  index,
  alone,
  width,
  label,
}: {
  url: string;
  index: number;
  alone: boolean;
  width: number;
  label: string;
}) {
  const [ratio, setRatio] = useState(0.78);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const w = alone ? width : Math.min(width * 0.84, Math.max(STRIP_H * 0.6, STRIP_H * ratio));
  return (
    <Reanimated.View entering={FadeIn.duration(360).delay(index * 70)}>
      <Image
        source={{ uri: url }}
        accessibilityLabel={label}
        style={{ width: w, height: STRIP_H, backgroundColor: colors.surface }}
        contentFit="cover"
        contentPosition="top"
        transition={240}
        onLoad={(e) => {
          const { width: iw, height: ih } = e.source;
          if (iw > 0 && ih > 0) setRatio(iw / ih);
        }}
        onError={() => setFailed(true)}
      />
    </Reanimated.View>
  );
}

/** A soft pulse for what's still on its way. */
function usePulse() {
  const reduced = useReducedMotion();
  const o = useSharedValue(0.5);
  useEffect(() => {
    if (reduced) return;
    o.set(
      withRepeat(
        withSequence(withTiming(0.85, { duration: 700 }), withTiming(0.5, { duration: 700 })),
        -1
      )
    );
  }, [o, reduced]);
  return useAnimatedStyle(() => ({ opacity: o.get() }));
}

function StripSkeleton({ width }: { width: number }) {
  const pulse = usePulse();
  return (
    <Reanimated.View style={[{ height: STRIP_H, flexDirection: "row", gap: 3 }, pulse]}>
      <View style={{ width: width * 0.66, backgroundColor: colors.raised }} />
      <View style={{ flex: 1, backgroundColor: colors.surface }} />
    </Reanimated.View>
  );
}

function BodySkeleton() {
  const pulse = usePulse();
  return (
    <Reanimated.View style={[{ gap: 11, paddingTop: 4 }, pulse]}>
      {[1, 0.94, 0.98, 0.62].map((w, i) => (
        <View key={i} style={[styles.line, { width: `${w * 100}%` }]} />
      ))}
    </Reanimated.View>
  );
}

/**
 * Questions about the profile, asked in its own chat. It stays at the bottom of the screen
 * whichever height the sheet rests at, and leaves with it.
 */
function AskBar({
  item,
  y,
  mid,
  bottomInset,
  onFocus,
  onAsked,
}: {
  item: Item;
  y: SharedValue<number>;
  mid: number;
  bottomInset: number;
  onFocus: () => void;
  onAsked: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const keyboard = useReanimatedKeyboardAnimation();
  const data = useQuery(api.entities.sheet, item.threadId ? { threadId: item.threadId } : "skip");
  const busy = (data?.messages ?? []).some((m) => m.status === "streaming");
  const ready = Boolean(item.threadId) && !busy && !sending;
  const canSend = ready && Boolean(text.trim());
  const pad = Math.max(bottomInset, 12);
  const ride = useAnimatedStyle(
    () => ({
      opacity: interpolate(y.get(), [mid, mid + 160], [1, 0], "clamp"),
      transform: [
        {
          translateY:
            Math.max(0, y.get() - mid) +
            Math.min(0, keyboard.height.value + (pad - 8) * keyboard.progress.value),
        },
      ],
    }),
    [mid, pad]
  );
  const send = () => {
    const q = text.trim();
    if (!q || !ready || !item.threadId) return;
    setText("");
    setSending(true);
    onAsked();
    convex
      .mutation(api.messages.send, { threadId: item.threadId, text: q })
      .catch((e) => {
        setText(q);
        useApp.getState().showToast(errorText(e), "danger");
      })
      .finally(() => setSending(false));
  };
  return (
    <Reanimated.View
      pointerEvents="box-none"
      style={[styles.askWrap, { paddingBottom: pad }, ride]}
    >
      <Glass radius={26} tint="rgba(24,24,27,0.6)">
        <View style={styles.ask}>
          <TextInput
            value={text}
            onChangeText={setText}
            onFocus={onFocus}
            onSubmitEditing={send}
            placeholder={`Ask about ${item.entity.name}`}
            placeholderTextColor={colors.textFaint}
            returnKeyType="send"
            submitBehavior="blurAndSubmit"
            style={styles.askInput}
            accessibilityLabel={`Ask about ${item.entity.name}`}
          />
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Ask"
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={send}
            hitSlop={6}
            style={[styles.askSend, { backgroundColor: canSend ? colors.text : colors.raised }]}
          >
            <Icon name="arrow-up" size={18} color={canSend ? "#000" : colors.textFaint} />
          </Tap>
        </View>
      </Glass>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    position: "absolute",
    alignSelf: "center",
    backgroundColor: SHEET_BG,
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.10)",
    overflow: "hidden",
  },
  grabberWrap: { position: "absolute", top: 7, left: 0, right: 0, alignItems: "center" },
  grabber: { width: 38, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.55)" },
  chrome: {
    position: "absolute",
    top: 14,
    left: 14,
    right: 14,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  chromeButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 128 },
  head: { paddingHorizontal: 20, gap: 4 },
  headOver: { marginTop: -54 },
  badge: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  name: { fontFamily: fonts.bold, fontSize: 30, lineHeight: 35, color: colors.text, letterSpacing: -0.4 },
  about: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 20 },
  body: { paddingHorizontal: 20, paddingTop: 18, gap: 14 },
  line: { height: 12, borderRadius: 6, backgroundColor: colors.raised },
  askWrap: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 14 },
  ask: { flexDirection: "row", alignItems: "center", paddingLeft: 18, paddingRight: 6, height: 52 },
  askInput: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.text,
    paddingVertical: 0,
  },
  askSend: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
});
