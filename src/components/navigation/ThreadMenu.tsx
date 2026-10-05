import { BlurView } from "expo-blur";
import { useEffect, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import Reanimated, {
  Easing as REasing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass } from "@/components/ui/Glass";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { useApp } from "@/lib/store";
import { colors, fonts } from "@/lib/theme";
import type { Thread } from "@/lib/types";

/** Window-space frame of the row that was long-pressed. */
export type Anchor = { x: number; y: number; width: number; height: number };
export type ThreadMenuTarget = { thread: Thread; anchor: Anchor };

type Item = {
  key: string;
  label: string;
  icon: IconName;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
};

const native = Platform.OS !== "web";
const BLUR = 28;
const AnimatedBlur = Reanimated.createAnimatedComponent(BlurView);
const MENU_W = 250;
const ROW_H = 50;
const PAD_V = 6;
const SEP_H = 13;
const GAP = 8;
const EDGE = 12;
const DANGER = "#F0645D";

export function threadIcon(t: Thread): IconName {
  if (t.mode === "research") return "telescope-outline";
  if (t.incognito) return "eye-off-outline";
  return "chatbubble-outline";
}

function estimateHeight(groups: Item[][]): number {
  const rows = groups.reduce((n, g) => n + g.length, 0);
  return PAD_V * 2 + rows * ROW_H + (groups.length - 1) * SEP_H;
}

/**
 * Long-press menu for a chat row. The row lifts above a dimmed, blurred backdrop and a short action
 * list opens beside it, below when there is room, above otherwise. Rename edits the title in place.
 */
export function ThreadMenu({
  target,
  onClose,
}: {
  target: ThreadMenuTarget | null;
  onClose: () => void;
}) {
  const pinThread = useApp((s) => s.pinThread);
  const renameThread = useApp((s) => s.renameThread);
  const deleteThread = useApp((s) => s.deleteThread);
  const showToast = useApp((s) => s.showToast);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  /** Opacity of the dimming and the menu: a plain ease, no overshoot. */
  const [fade] = useState(() => new Animated.Value(0));
  /**
   * Blur strength, animated on its own. Fading the blur's parent instead makes it flicker: an
   * ancestor below full opacity cuts the blur off from what's behind it (web and iOS both), so it
   * snaps in and out as the opacity crosses 1.
   */
  const blur = useSharedValue(0);
  const blurProps = useAnimatedProps(() => ({ intensity: blur.get() }));
  /** Scale of the menu and the lifted row: springy, but clamped so it never overshoots. */
  const [progress] = useState(() => new Animated.Value(0));
  const [shift] = useState(() => new Animated.Value(0));

  // Hold on to the last target while the menu animates out; reset per opening.
  const [shown, setShown] = useState(target);
  const [title, setTitle] = useState<string | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  if (target && target !== shown) {
    setShown(target);
    setTitle(null);
    setMeasured(null);
  }

  useEffect(() => {
    if (target) {
      shift.setValue(0);
      if (reduced) {
        fade.setValue(1);
        blur.set(BLUR);
        progress.setValue(1);
      } else {
        blur.set(withTiming(BLUR, { duration: 220, easing: REasing.out(REasing.cubic) }));
        Animated.parallel([
          Animated.timing(fade, {
            toValue: 1,
            duration: 180,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: native,
          }),
          Animated.spring(progress, {
            toValue: 1,
            damping: 24,
            stiffness: 340,
            mass: 0.7,
            overshootClamping: true,
            useNativeDriver: native,
          }),
        ]).start();
      }
    } else {
      const out = { toValue: 0, duration: reduced ? 0 : 140, useNativeDriver: native };
      blur.set(withTiming(0, { duration: out.duration }));
      Animated.parallel([Animated.timing(fade, out), Animated.timing(progress, out)]).start(
        ({ finished }) => {
          if (finished) setShown(null);
        }
      );
    }
  }, [target, reduced, fade, blur, progress, shift]);

  if (!shown) return null;
  const { thread, anchor: a } = shown;
  const renaming = title !== null;
  const nextTitle = title?.trim() ?? "";

  const startRename = () => {
    setTitle(thread.title);
    setMeasured(null);
    // Keep the field clear of the keyboard.
    const top = Math.min(a.y, insets.top + 96);
    if (reduced) shift.setValue(top - a.y);
    else
      Animated.spring(shift, {
        toValue: top - a.y,
        damping: 26,
        stiffness: 260,
        useNativeDriver: native,
      }).start();
  };

  const commitRename = () => {
    if (!nextTitle || nextTitle === thread.title) return;
    renameThread(thread.id, nextTitle);
    showToast("Renamed");
    onClose();
  };

  const groups: Item[][] = renaming
    ? [
        [
          {
            key: "save",
            label: "Save",
            icon: "checkmark",
            disabled: !nextTitle || nextTitle === thread.title,
            onPress: commitRename,
          },
          { key: "cancel", label: "Cancel", icon: "close", onPress: onClose },
        ],
      ]
    : [
        [
          {
            key: "pin",
            label: thread.pinnedAt ? "Unpin" : "Pin",
            icon: "pin-outline",
            onPress: () => {
              pinThread(thread.id, !thread.pinnedAt);
              showToast(thread.pinnedAt ? "Unpinned" : "Pinned");
              onClose();
            },
          },
        ],
        [{ key: "rename", label: "Rename", icon: "pencil-outline", onPress: startRename }],
        [
          {
            key: "delete",
            label: "Delete",
            icon: "trash-outline",
            danger: true,
            onPress: () => {
              deleteThread(thread.id);
              showToast("Chat deleted");
              onClose();
            },
          },
        ],
      ];

  const menuH = measured ?? estimateHeight(groups);
  const menuW = Math.min(MENU_W, width - EDGE * 2);
  const left = Math.max(EDGE, Math.min(a.x, width - menuW - EDGE));
  const below = a.y + a.height + GAP;
  const floor = height - insets.bottom - EDGE;
  const above = !renaming && below + menuH > floor && a.y - GAP - menuH >= insets.top + EDGE;
  const menuTop = above ? a.y - GAP - menuH : Math.min(below, floor - menuH);

  const menuScale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] });
  const lift = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] });

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={StyleSheet.absoluteFill}>
        <AnimatedBlur animatedProps={blurProps} tint="dark" style={StyleSheet.absoluteFill} />
        <Animated.View style={[StyleSheet.absoluteFill, styles.dim, { opacity: fade }]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close chat options"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
      </View>

      <Animated.View
        style={{
          position: "absolute",
          left: a.x,
          top: a.y,
          width: a.width,
          transform: [{ translateY: shift }, { scale: reduced ? 1 : lift }],
        }}
      >
        <View style={styles.row}>
          <Icon name={threadIcon(thread)} size={20} color={colors.text} />
          {renaming ? (
            <TextInput
              value={title}
              onChangeText={setTitle}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              onSubmitEditing={commitRename}
              maxLength={120}
              placeholder="Chat title"
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="Chat title"
              style={styles.input}
            />
          ) : (
            <Text className="flex-1 text-[17px] leading-6" numberOfLines={1}>
              {thread.title}
            </Text>
          )}
          {thread.pinnedAt && !renaming ? (
            <Icon name="pin" size={15} color={colors.textFaint} />
          ) : null}
        </View>
      </Animated.View>

      <Animated.View
        accessibilityRole="menu"
        onLayout={(e) => setMeasured(e.nativeEvent.layout.height)}
        style={[
          styles.menu,
          {
            left,
            top: menuTop,
            width: menuW,
            opacity: fade,
            transformOrigin: above ? "bottom left" : "top left",
            transform: [{ translateY: shift }, { scale: reduced ? 1 : menuScale }],
          },
        ]}
      >
        <Glass radius={26} tint="rgba(36,36,40,0.84)" style={{ paddingVertical: PAD_V }}>
          {groups.map((group, gi) => (
            <View key={group[0].key}>
              {gi > 0 ? <View style={styles.separator} /> : null}
              {group.map((item) => (
                <View key={item.key} style={item.disabled ? styles.disabled : undefined}>
                  <Tap
                    haptic
                    accessibilityRole="menuitem"
                    accessibilityState={{ disabled: !!item.disabled }}
                    disabled={item.disabled}
                    onPress={item.onPress}
                    style={styles.item}
                  >
                    <Icon name={item.icon} size={21} color={item.danger ? DANGER : colors.text} />
                    <Text
                      className="text-[17px] leading-6"
                      style={{ color: item.danger ? DANGER : colors.text }}
                    >
                      {item.label}
                    </Text>
                  </Tap>
                </View>
              ))}
            </View>
          ))}
        </Glass>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  dim: { backgroundColor: "rgba(0,0,0,0.42)" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: "#1F1F23",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.08)",
  },
  input: {
    flex: 1,
    height: 24,
    padding: 0,
    fontFamily: fonts.body,
    fontSize: 17,
    color: colors.text,
  },
  menu: {
    position: "absolute",
    borderRadius: 26,
    boxShadow: "0 18px 44px rgba(0,0,0,0.55)",
  },
  item: {
    height: ROW_H,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 20,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 6,
    marginHorizontal: 20,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  disabled: { opacity: 0.4 },
});
