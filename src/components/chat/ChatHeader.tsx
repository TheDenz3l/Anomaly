import { Switch } from "heroui-native";
import { useState } from "react";
import { TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Glass } from "@/components/ui/Glass";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Sheet } from "@/components/ui/Sheet";
import { Tap } from "@/components/ui/Tap";
import { Display, Text } from "@/components/ui/Text";
import { ActionButton } from "@/genui/kit";
import { MenuGlyph } from "@/components/navigation/MenuGlyph";
import { useDrawer } from "@/components/navigation/SideDrawer";
import { fadeIn } from "@/lib/motion";
import { findModel, useApp } from "@/lib/store";
import { colors, fonts } from "@/lib/theme";

function GlassButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Glass radius={20} interactive>
        <View className="h-10 w-10 items-center justify-center">
          <Icon name={icon} size={19} />
        </View>
      </Glass>
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
  const renameThread = useApp((s) => s.renameThread);
  const deleteThread = useApp((s) => s.deleteThread);
  const showToast = useApp((s) => s.showToast);
  const drawer = useDrawer();
  const [menu, setMenu] = useState(false);
  const [title, setTitle] = useState("");
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
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`${thread?.title ?? "New chat"}, chat options`}
          onPress={() => {
            setTitle(thread?.title ?? "");
            setMenu(true);
          }}
          className="flex-1 items-center"
        >
          <Animated.View key={thread?.id ?? "new"} entering={fadeIn} className="items-center">
            {thread ? (
              <Display className="text-[15px] leading-5" numberOfLines={1}>
                {thread.title}
              </Display>
            ) : null}
            <View className="mt-0.5 flex-row items-center gap-1">
              {incognito ? <Icon name="eye-off-outline" size={12} color={colors.textMuted} /> : null}
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
              <Icon name="chevron-down" size={11} color={colors.textMuted} />
            </View>
          </Animated.View>
        </Tap>
        <GlassButton icon="create-outline" label="New chat" onPress={newChat} />
      </View>

      <Sheet
        open={menu}
        onClose={() => setMenu(false)}
        title={thread ? "Chat options" : "New chat"}
      >
        <View className="gap-4">
          <View className="flex-row items-center gap-3 rounded-3xl bg-card p-4">
            <Icon name="eye-off-outline" size={20} color={colors.textMuted} />
            <View className="flex-1">
              <Text weight="bold" className="text-base">
                Incognito
              </Text>
              <Text muted className="text-[13px] leading-[18px]">
                Nothing from this chat is saved to or read from memory.
              </Text>
            </View>
            <Switch isSelected={incognito} onSelectedChange={setIncognito} />
          </View>
          {thread ? (
            <>
              <View className="gap-2 rounded-3xl bg-card p-4">
                <Text weight="bold" className="text-base">
                  Title
                </Text>
                <TextInput
                  value={title}
                  onChangeText={setTitle}
                  accessibilityLabel="Chat title"
                  style={{
                    fontFamily: fonts.body,
                    fontSize: 16,
                    color: colors.text,
                    backgroundColor: colors.raised,
                    borderRadius: 14,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                  }}
                />
                <View className="flex-row justify-end">
                  <ActionButton
                    size="sm"
                    label="Rename"
                    disabled={!title.trim() || title === thread.title}
                    onPress={() => {
                      renameThread(thread.id, title.trim());
                      showToast("Renamed");
                    }}
                  />
                </View>
              </View>
              <ActionButton
                variant="danger-soft"
                icon="trash-outline"
                label="Delete chat"
                onPress={() => {
                  deleteThread(thread.id);
                  setMenu(false);
                  showToast("Chat deleted");
                }}
              />
            </>
          ) : null}
        </View>
      </Sheet>
    </View>
  );
}
