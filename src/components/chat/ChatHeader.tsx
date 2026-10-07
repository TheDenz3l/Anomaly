import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Glass } from "@/components/ui/Glass";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Display, Text } from "@/components/ui/Text";
import { MenuGlyph } from "@/components/navigation/MenuGlyph";
import { useDrawer } from "@/components/navigation/SideDrawer";
import { incognitoToggled } from "@/lib/haptics";
import { fadeIn } from "@/lib/motion";
import { findModel, useApp } from "@/lib/store";
import { colors } from "@/lib/theme";

/** Incognito presses in and lights up; a little give, so it lands like a physical switch. */
const PRESS = { damping: 16, stiffness: 420, mass: 0.6 };
/** Incognito turning into New chat as the conversation starts, and back. */
const MORPH = { damping: 18, stiffness: 240, mass: 0.8 };

/**
 * The top-right control. Before anything is sent it is the incognito switch: on, it sits pressed
 * in and lit. Once the chat starts it morphs into New chat.
 */
function CornerButton({
  started,
  incognito,
  onIncognito,
  onNewChat,
}: {
  started: boolean;
  incognito: boolean;
  onIncognito: (on: boolean) => void;
  onNewChat: () => void;
}) {
  const reduced = useReducedMotion();
  const lit = incognito && !started;
  const morph = useSharedValue(started ? 1 : 0);
  const on = useSharedValue(lit ? 1 : 0);
  useEffect(() => {
    const to = started ? 1 : 0;
    morph.set(reduced ? to : withSpring(to, MORPH));
  }, [started, reduced, morph]);
  useEffect(() => {
    const to = lit ? 1 : 0;
    on.set(reduced ? to : withSpring(to, PRESS));
  }, [lit, reduced, on]);

  const held = useAnimatedStyle(() => ({ transform: [{ scale: 1 - on.get() * 0.08 }] }));
  const fill = useAnimatedStyle(() => ({ opacity: on.get() }));
  const eye = useAnimatedStyle(() => ({
    opacity: 1 - morph.get(),
    transform: [{ scale: 1 - morph.get() * 0.5 }, { rotate: `${-90 * morph.get()}deg` }],
  }));
  const eyeLit = useAnimatedStyle(() => ({ opacity: on.get() }));
  const pen = useAnimatedStyle(() => ({
    opacity: morph.get(),
    transform: [{ scale: 0.5 + morph.get() * 0.5 }, { rotate: `${90 * (1 - morph.get())}deg` }],
  }));

  const press = () => {
    if (started) return onNewChat();
    incognitoToggled(!incognito);
    onIncognito(!incognito);
  };

  return (
    <Tap
      accessibilityRole={started ? "button" : "switch"}
      accessibilityLabel={started ? "New chat" : "Incognito"}
      accessibilityState={started ? undefined : { checked: incognito }}
      accessibilityHint={
        started ? undefined : "Nothing from this chat is saved to or read from memory"
      }
      onPress={press}
    >
      <Animated.View style={held}>
        <Glass radius={20} interactive>
          <View className="h-10 w-10 items-center justify-center">
            <Animated.View pointerEvents="none" style={[styles.lit, fill]} />
            <Animated.View pointerEvents="none" style={[styles.glyph, eye]}>
              <Icon name="eye-off-outline" size={19} />
              <Animated.View style={[styles.glyph, eyeLit]}>
                <Icon name="eye-off" size={19} color="#000" />
              </Animated.View>
            </Animated.View>
            <Animated.View pointerEvents="none" style={[styles.glyph, pen]}>
              <Icon name="create-outline" size={19} />
            </Animated.View>
          </View>
        </Glass>
      </Animated.View>
    </Tap>
  );
}

export function ChatHeader() {
  const insets = useSafeAreaInsets();
  const thread = useApp((s) => (s.activeThreadId ? s.threads[s.activeThreadId] : undefined));
  const draftIncognito = useApp((s) => s.draft.incognito);
  const models = useApp((s) => s.models);
  const newChat = useApp((s) => s.newChat);
  const setIncognito = useApp((s) => s.setIncognito);
  const drawer = useDrawer();
  const incognito = thread?.incognito ?? draftIncognito;
  const fadeH = insets.top + 72;

  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
      <Svg
        pointerEvents="none"
        width="100%"
        height={fadeH}
        style={{ position: "absolute", top: 0 }}
      >
        <Defs>
          <LinearGradient id="headerFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000" stopOpacity={1} />
            <Stop offset="0.6" stopColor="#000" stopOpacity={0.85} />
            <Stop offset="1" stopColor="#000" stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={fadeH} fill="url(#headerFade)" />
      </Svg>
      <View style={{ paddingTop: insets.top + 6 }} className="flex-row items-center gap-3 px-3">
        <Tap accessibilityRole="button" accessibilityLabel="Open menu" onPress={drawer.open}>
          <Glass radius={20} interactive>
            <View className="h-10 w-10 items-center justify-center">
              <MenuGlyph />
            </View>
          </Glass>
        </Tap>
        {/* Just the chat's name; renaming and deleting live on its row in the menu. */}
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={
            thread
              ? `${thread.title}, ${incognito ? "incognito" : findModel(models, thread.modelRef).name}`
              : incognito
                ? "Incognito chat"
                : "New chat"
          }
          className="flex-1 items-center"
        >
          <Animated.View
            key={thread?.key ?? thread?.id ?? (incognito ? "incognito" : "new")}
            entering={fadeIn}
            className="w-full items-center"
          >
            {thread ? (
              <Display className="text-[15px] leading-5" numberOfLines={1}>
                {thread.title}
              </Display>
            ) : null}
            <View className="mt-0.5 flex-row items-center gap-1">
              {incognito ? (
                <Icon name="eye-off-outline" size={12} color={colors.textMuted} />
              ) : null}
              {thread?.mode === "research" ? (
                <Icon name="telescope-outline" size={12} color={colors.textMuted} />
              ) : null}
              <Text muted className="text-xs" numberOfLines={1}>
                {incognito
                  ? "Incognito"
                  : thread
                    ? findModel(models, thread.modelRef).name
                    : "New chat"}
              </Text>
            </View>
          </Animated.View>
        </View>
        <CornerButton
          started={Boolean(thread)}
          incognito={incognito}
          onIncognito={setIncognito}
          onNewChat={newChat}
        />
      </View>
    </View>
  );
}

const over = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  lit: { ...over, borderRadius: 20, backgroundColor: "#F2F2F4" },
  glyph: { ...over, alignItems: "center", justifyContent: "center" },
});
