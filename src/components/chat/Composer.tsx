import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, TextInput, View, type LayoutChangeEvent } from "react-native";
import Animated from "react-native-reanimated";
import { Glass } from "@/components/ui/Glass";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { fadeIn, fadeOut, popIn, popOut, reflow } from "@/lib/motion";
import { useApp, useComposerTarget, type Attachment } from "@/lib/store";
import { colors, fonts } from "@/lib/theme";
import { ModelPicker } from "./ModelPicker";
import { levelLabel, ThinkingPicker } from "./ThinkingPicker";

function Chip({
  icon,
  label,
  onPress,
  active,
  accessibilityLabel,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  active?: boolean;
  accessibilityLabel: string;
}) {
  return (
    <Tap
      haptic
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`h-8 flex-row items-center gap-1.5 rounded-full px-2.5 ${active ? "bg-primary-soft" : "bg-white/[0.07]"}`}
    >
      <Icon name={icon} size={14} color={active ? colors.primaryStrong : colors.textMuted} />
      <Text
        weight="medium"
        className={`text-[13px] ${active ? "text-primary-strong" : "text-ink"}`}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Tap>
  );
}

const SPOKEN = "What movies are playing near me tonight?";

/** Hold-to-talk waveform. Mock mode streams a canned partial transcript; on-device speech comes with the native build. */
function useVoice(onPartial: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [levels, setLevels] = useState<number[]>(() => Array(28).fill(0.15));
  const words = useRef(0);

  useEffect(() => {
    if (!recording) return;
    words.current = 0;
    const wave = setInterval(
      () => setLevels((l) => [...l.slice(1), 0.15 + Math.random() * 0.85]),
      70
    );
    const transcript = setInterval(() => {
      const all = SPOKEN.split(" ");
      words.current = Math.min(all.length, words.current + 1);
      onPartial(all.slice(0, words.current).join(" "));
    }, 260);
    return () => {
      clearInterval(wave);
      clearInterval(transcript);
      setLevels(Array(28).fill(0.15));
    };
  }, [recording, onPartial]);

  return { recording, levels, start: () => setRecording(true), stop: () => setRecording(false) };
}

export function Composer({ onLayout }: { onLayout?: (e: LayoutChangeEvent) => void }) {
  const { target, model } = useComposerTarget();
  const send = useApp((s) => s.send);
  const stop = useApp((s) => s.stop);
  const streaming = useApp((s) => s.streaming !== null);
  const researchArmed = useApp((s) => s.researchArmed);
  const setResearchMode = useApp((s) => s.setResearchMode);
  const setModel = useApp((s) => s.setModel);
  const setReasoningLevel = useApp((s) => s.setReasoningLevel);
  const showToast = useApp((s) => s.showToast);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [picker, setPicker] = useState<"model" | "thinking" | null>(null);
  const voice = useVoice(setText);
  const input = useRef<TextInput>(null);

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !streaming;
  const thinkingSupported = model.profile.reasoning.style !== "none";
  const visionWarning = attachments.length > 0 && !model.profile.features.vision;

  const submit = () => {
    if (!canSend) return;
    send(text, attachments);
    setText("");
    setAttachments([]);
  };

  const attach = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 4,
      quality: 0.7,
    });
    if (res.canceled) return;
    setAttachments((a) =>
      [...a, ...res.assets.map((x) => ({ uri: x.uri, width: x.width, height: x.height }))].slice(
        0,
        4
      )
    );
  };

  return (
    <View onLayout={onLayout} className="px-3">
      <Glass radius={28} interactive>
        <View className="px-2 pb-2 pt-1.5">
          {attachments.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, padding: 6 }}
            >
              {attachments.map((a, i) => (
                <Animated.View key={a.uri + i} entering={popIn} exiting={popOut} layout={reflow}>
                  <Image
                    source={{ uri: a.uri }}
                    style={{ width: 60, height: 60, borderRadius: 14 }}
                    contentFit="cover"
                    accessibilityLabel="Attachment"
                  />
                  <Tap
                    accessibilityLabel="Remove attachment"
                    onPress={() => setAttachments((all) => all.filter((_, j) => j !== i))}
                    className="absolute -right-1.5 -top-1.5 h-6 w-6 items-center justify-center rounded-full bg-raised"
                  >
                    <Icon name="close" size={13} />
                  </Tap>
                </Animated.View>
              ))}
            </ScrollView>
          ) : null}
          {visionWarning ? (
            <Animated.View entering={fadeIn} exiting={fadeOut} className="mx-1.5 mb-1 flex-row items-center gap-2 rounded-2xl bg-[rgba(245,165,36,0.12)] px-3 py-2">
              <Icon name="eye-off-outline" size={14} color={colors.warning} />
              <Text className="flex-1 text-[13px] leading-[18px] text-warning">
                {model.name} can’t see images. Switch to a vision model.
              </Text>
            </Animated.View>
          ) : null}

          {voice.recording ? (
            <View
              accessibilityLiveRegion="polite"
              className="min-h-[44px] flex-row items-center gap-[3px] px-3 py-2"
            >
              {voice.levels.map((l, i) => (
                <View
                  key={i}
                  className="w-[3px] rounded-full bg-primary"
                  style={{ height: 6 + l * 26 }}
                />
              ))}
              <Text weight="medium" muted className="ml-2 flex-1 text-[13px]" numberOfLines={1}>
                {text || "Listening"}
              </Text>
            </View>
          ) : (
            <TextInput
              ref={input}
              value={text}
              onChangeText={setText}
              multiline
              placeholder={researchArmed ? "What should I research?" : "Ask anything"}
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="Message"
              onKeyPress={(e) => {
                const ev = e.nativeEvent as { key: string; shiftKey?: boolean };
                if (Platform.OS === "web" && ev.key === "Enter" && !ev.shiftKey) {
                  (e as unknown as { preventDefault: () => void }).preventDefault();
                  submit();
                }
              }}
              style={
                {
                  fontFamily: fonts.body,
                  fontSize: 16,
                  lineHeight: 22,
                  color: colors.text,
                  minHeight: 44,
                  maxHeight: 140,
                  paddingHorizontal: 12,
                  paddingTop: 11,
                  paddingBottom: 9,
                  outlineStyle: "none",
                  resize: "none",
                } as object
              }
            />
          )}

          <View className="flex-row items-center gap-1.5 px-1">
            <Tap
              haptic
              accessibilityLabel="Attach photo"
              onPress={attach}
              className="h-8 w-8 items-center justify-center rounded-full bg-white/[0.07]"
            >
              <Icon name="add" size={20} color={colors.text} />
            </Tap>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              className="flex-1"
              contentContainerStyle={{ gap: 6 }}
            >
              <Chip
                icon="cube-outline"
                label={model.name}
                accessibilityLabel={`Model: ${model.name}`}
                onPress={() => setPicker("model")}
              />
              {thinkingSupported ? (
                <Chip
                  icon="bulb-outline"
                  label={levelLabel(target.reasoningLevel)}
                  accessibilityLabel={`Thinking: ${levelLabel(target.reasoningLevel)}`}
                  active={target.reasoningLevel !== "auto" && target.reasoningLevel !== "off"}
                  onPress={() => setPicker("thinking")}
                />
              ) : null}
              <Chip
                icon="telescope-outline"
                label="Research"
                accessibilityLabel="Deep research"
                active={researchArmed}
                onPress={() => {
                  setResearchMode(!researchArmed);
                  if (!researchArmed) showToast("Deep research on for the next message");
                }}
              />
            </ScrollView>
            <View className="h-9 w-9">
            {streaming ? (
              <Animated.View key="stop" entering={popIn} exiting={popOut} style={StyleSheet.absoluteFill}>
              <Tap
                accessibilityLabel="Stop"
                onPress={stop}
                className="h-9 w-9 items-center justify-center rounded-full bg-ink"
              >
                <View className="h-3 w-3 rounded-[3px] bg-black" />
              </Tap>
              </Animated.View>
            ) : canSend ? (
              <Animated.View key="send" entering={popIn} exiting={popOut} style={StyleSheet.absoluteFill}>
              <Tap
                haptic
                accessibilityLabel="Send"
                onPress={submit}
                className="h-9 w-9 items-center justify-center rounded-full bg-primary"
              >
                <Icon name="arrow-up" size={20} color="#fff" />
              </Tap>
              </Animated.View>
            ) : (
              <Animated.View key="mic" entering={popIn} exiting={popOut} style={StyleSheet.absoluteFill}>
              <Tap
                accessibilityLabel="Hold to talk"
                accessibilityHint="Press and hold, then release to stop"
                onPressIn={() => {
                  setText("");
                  voice.start();
                }}
                onPressOut={voice.stop}
                className={`h-9 w-9 items-center justify-center rounded-full ${voice.recording ? "bg-primary" : "bg-white/[0.07]"}`}
              >
                <Icon name="mic" size={18} color={voice.recording ? "#fff" : colors.text} />
              </Tap>
              </Animated.View>
            )}
            </View>
          </View>
        </View>
      </Glass>

      <ModelPicker
        open={picker === "model"}
        onClose={() => setPicker(null)}
        value={target.modelRef}
        onSelect={setModel}
      />
      <ThinkingPicker
        open={picker === "thinking"}
        onClose={() => setPicker(null)}
        model={model}
        value={target.reasoningLevel}
        onSelect={setReasoningLevel}
      />
    </View>
  );
}
