import { Image } from "expo-image";
import { File as PickedFile, type PickMultipleFilesResult } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState } from "react";
import {
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
  Keyboard,
} from "react-native";
import Animated from "react-native-reanimated";
import { Glass } from "@/components/ui/Glass";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { fadeIn, fadeOut, popIn, popOut, reflow } from "@/lib/motion";
import { useApp, useComposerTarget, useVisionStandIn, type Attachment } from "@/lib/store";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { modelRef } from "@/lib/models";
import { colors } from "@/lib/theme";
import {
  fileIcon,
  humanSize,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  typeLabel,
  fileAttachment,
} from "@/lib/files";
import { ActionMenu, type MenuAnchor, type MenuItem } from "@/components/ui/ActionMenu";
import { LinkInput } from "./LinkInput";
import { levelLabel, ModelPicker } from "./ModelPicker";

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
      className={`h-8 flex-row items-center gap-1.5 rounded-full ${label ? "px-2.5" : "w-8 justify-center"} ${active ? "bg-primary-soft" : "bg-white/[0.07]"}`}
    >
      <Icon name={icon} size={14} color={active ? colors.primaryStrong : colors.textMuted} />
      {label ? (
        <Text
          weight="medium"
          className={`text-[13px] ${active ? "text-primary-strong" : "text-ink"}`}
          numberOfLines={1}
        >
          {label}
        </Text>
      ) : null}
    </Tap>
  );
}

/** The draft key of a chat that hasn't been sent yet. */
const NEW_CHAT = "new";
/** What was typed and attached in each chat that was left, for this session. */
const drafts = new Map<string, { text: string; attachments: Attachment[] }>();

const QUIET = 0.15;

/**
 * Hold-to-talk (PRD §3.11): on-device speech recognition with live partial transcripts and a
 * waveform driven by mic volume. Web uses the browser's speech API through the same module.
 */
function useVoice(onPartial: (text: string) => void, onError: (message: string) => void) {
  const [recording, setRecording] = useState(false);
  const [levels, setLevels] = useState<number[]>(() => Array(28).fill(QUIET));

  useSpeechRecognitionEvent("result", (ev) => {
    const t = ev.results[0]?.transcript;
    if (t) onPartial(t);
  });
  useSpeechRecognitionEvent("volumechange", (ev) => {
    // value runs from about -2 (silence) to 10 (loud).
    const level = Math.min(1, Math.max(QUIET, (ev.value + 2) / 12));
    setLevels((l) => [...l.slice(1), level]);
  });
  useSpeechRecognitionEvent("end", () => {
    setRecording(false);
    setLevels(Array(28).fill(QUIET));
  });
  useSpeechRecognitionEvent("error", (ev) => {
    setRecording(false);
    if (ev.error !== "aborted" && ev.error !== "no-speech")
      onError(ev.message || "Voice input stopped.");
  });

  const start = async () => {
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        onError("Allow microphone and speech recognition in Settings to talk to Anomaly.");
        return;
      }
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: true,
        continuous: false,
        addsPunctuation: true,
        // Settings promises speech is transcribed on the phone: keep audio off the network when it can.
        requiresOnDeviceRecognition: onDeviceSpeech(),
        volumeChangeEventOptions: { enabled: true, intervalMillis: 70 },
      });
      setRecording(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Voice input isn't available on this device.");
    }
  };
  const stop = () => {
    ExpoSpeechRecognitionModule.stop();
  };

  return { recording, levels, start: () => void start(), stop };
}

/** Whether this phone can transcribe speech itself (the web harness and some devices can't). */
function onDeviceSpeech(): boolean {
  try {
    return ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
  } catch {
    return false;
  }
}

/** A photo from the library or camera, with the type the picker reported. */
function photoAttachment(x: ImagePicker.ImagePickerAsset): Attachment {
  return {
    uri: x.uri,
    width: x.width,
    height: x.height,
    mime: x.mimeType ?? undefined,
    name: x.fileName ?? undefined,
  };
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
  const ensureProfile = useApp((s) => s.ensureProfile);
  const restore = useApp((s) => s.composerRestore);
  const clearRestore = useApp((s) => s.clearComposerRestore);
  const editing = useApp((s) => s.editing);
  const cancelEdit = useApp((s) => s.cancelEdit);
  const editMessage = useApp((s) => s.editMessage);
  const regenerate = useApp((s) => s.regenerate);
  const regenerateWith = useApp((s) => s.regenerateWith);
  const pickRegenerateModel = useApp((s) => s.pickRegenerateModel);
  const threadKey = useApp((s) => s.activeThreadId) ?? NEW_CHAT;
  const inbox = useApp((s) => s.composerInbox);
  const clearInbox = useApp((s) => s.clearComposerInbox);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [picker, setPicker] = useState(false);
  const voice = useVoice(setText, (message) => showToast(message, "danger"));
  const input = useRef<TextInput>(null);

  const canSend = (text.trim().length > 0 || (!editing && attachments.length > 0)) && !streaming;
  const thinkingSupported = model.profile.reasoning.style !== "none";
  const standIn = useVisionStandIn(model);
  const visionNote = attachments.some((a) => a.kind !== "file") && !model.profile.features.vision;
  const room = MAX_ATTACHMENTS - attachments.length;
  const ref = model.providerId ? modelRef(model) : "";
  const unverified = model.profile.source === "registry" || model.profile.source === "manual";

  // A model only known from the registry gets its reasoning controls checked in the background,
  // so the Thinking levels appear on their own instead of after a manual probe.
  useEffect(() => {
    if (ref && unverified) ensureProfile(ref);
  }, [ref, unverified, ensureProfile]);

  // Each chat keeps what was typed and attached in it: leaving sets it aside, coming back
  // restores it. A new chat's first send (pending, then its real id) is the same chat throughout.
  const [draftKey, setDraftKey] = useState(threadKey);
  /** The id of the edit the input currently holds, and what it held before that edit. */
  const [edited, setEdited] = useState<string | null>(null);
  const [aside, setAside] = useState("");
  let liveText = text;
  let liveAttachments = attachments;
  let swapped = false;
  if (draftKey !== threadKey) {
    setDraftKey(threadKey);
    if (!draftKey.startsWith("pending_")) {
      swapped = true;
      // Mid-edit the input holds the message being rewritten; the draft is what it set aside.
      const mine = edited ? aside : text;
      if (mine.trim() || attachments.length) drafts.set(draftKey, { text: mine, attachments });
      else drafts.delete(draftKey);
      const next = drafts.get(threadKey);
      drafts.delete(threadKey);
      liveText = next?.text ?? "";
      liveAttachments = next?.attachments ?? [];
      setText(liveText);
      setAttachments(liveAttachments);
    }
  }

  // A send the server refused hands its text and photos back, unless something new is here already.
  const [restored, setRestored] = useState<string | null>(null);
  if (restore && restore.id !== restored) {
    setRestored(restore.id);
    if (!text.trim()) setText(restore.text);
    if (!attachments.length) setAttachments(restore.attachments);
  }
  useEffect(() => {
    if (restore) clearRestore();
  }, [restore, clearRestore]);

  // Photos, files and text shared from another app join whatever is here, ready for a question.
  const [received, setReceived] = useState<string | null>(null);
  const [overflow, setOverflow] = useState(0);
  if (inbox && inbox.id !== received) {
    setReceived(inbox.id);
    const merged = [...liveAttachments, ...inbox.attachments];
    setOverflow(Math.max(0, merged.length - MAX_ATTACHMENTS));
    setAttachments(merged.slice(0, MAX_ATTACHMENTS));
    if (inbox.text) setText(liveText.trim() ? `${liveText.trimEnd()}\n${inbox.text}` : inbox.text);
  }
  useEffect(() => {
    if (!inbox) return;
    clearInbox();
    if (overflow) {
      showToast(
        `Up to ${MAX_ATTACHMENTS} attachments per message, so ${overflow} ${overflow === 1 ? "was" : "were"} left out.`
      );
    }
    input.current?.focus();
  }, [inbox, clearInbox, overflow, showToast]);

  // A message being rewritten takes the input; what was typed there comes back afterwards
  // (unless the chat was left, which already swapped the input for the next chat's draft).
  if ((editing?.id ?? null) !== edited) {
    setEdited(editing?.id ?? null);
    if (editing) {
      if (!edited) setAside(text);
      setText(editing.text);
    } else {
      if (!swapped) setText(aside);
      setAside("");
    }
  }
  useEffect(() => {
    if (edited) input.current?.focus();
  }, [edited]);

  const submit = () => {
    if (!canSend) return;
    // The keyboard goes away so the sent message and the reply below it get the screen.
    Keyboard.dismiss();
    if (editing) {
      editMessage(editing.messageId, text);
      return;
    }
    send(text, attachments);
    setText("");
    setAttachments([]);
  };

  const add = (more: Attachment[]) =>
    setAttachments((a) => [...a, ...more].slice(0, MAX_ATTACHMENTS));

  const pickPhotos = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, room),
      quality: 0.7,
    });
    if (res.canceled) return;
    add(res.assets.map(photoAttachment));
  };

  const pickFiles = async () => {
    let res: PickMultipleFilesResult;
    try {
      res = await PickedFile.pickFileAsync({ multipleFiles: true });
    } catch (e) {
      showToast(`Couldn't open Files: ${(e as Error).message}`, "danger");
      return;
    }
    if (res.canceled) return;
    const picked = res.result;
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) showToast(`${tooBig.name} is over 25 MB, so it was left out.`, "danger");
    add(
      picked
        .filter((f) => f.size <= MAX_FILE_BYTES)
        .map((f) =>
          fileAttachment({ uri: f.uri, name: f.name, mime: f.type || undefined, size: f.size })
        )
    );
  };

  const takePhoto = async () => {
    const access = await ImagePicker.requestCameraPermissionsAsync();
    if (!access.granted) {
      showToast("Camera access is off. Turn it on in Settings to take photos.", "danger");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7 });
    if (res.canceled) return;
    add(res.assets.map(photoAttachment));
  };

  /** Runs a picker while there's room for another attachment. */
  const whenRoom = (pick: () => Promise<void>) => () => {
    if (room <= 0) showToast(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
    else void pick();
  };

  // "Think harder" picks the model's top thinking level; turning it off goes back to Auto.
  const reasoningLevels = (model.profile.reasoning.levels ?? []).filter(
    (l) => !["off", "auto", "none"].includes(l)
  );
  const topLevel = reasoningLevels[reasoningLevels.length - 1];
  const thinkingHard = Boolean(topLevel) && target.reasoningLevel === topLevel;

  const menu: MenuItem[] = [
    { key: "camera", label: "Camera", icon: "camera-outline", onPress: whenRoom(takePhoto) },
    { key: "photos", label: "Photos", icon: "images-outline", onPress: whenRoom(pickPhotos) },
    { key: "files", label: "Files", icon: "attach-outline", onPress: whenRoom(pickFiles) },
    ...(thinkingSupported && topLevel
      ? [
          {
            key: "think",
            label: "Think harder",
            icon: "bulb-outline" as const,
            on: thinkingHard,
            section: true,
            onPress: () => setReasoningLevel(thinkingHard ? "auto" : topLevel),
          },
        ]
      : []),
  ];

  // The menu grows out of the + button, so it opens from where the button sits on screen.
  const plus = useRef<View>(null);
  const [menuAt, setMenuAt] = useState<MenuAnchor | null>(null);
  const openMenu = () =>
    plus.current?.measureInWindow((x, y, width, height) => setMenuAt({ x, y, width, height }));

  return (
    <View onLayout={onLayout} className="px-3">
      <Glass radius={28} interactive>
        <View className="px-2 pb-2 pt-1.5">
          {editing ? (
            <Animated.View
              entering={fadeIn}
              exiting={fadeOut}
              className="mx-1.5 mb-1 mt-1 flex-row items-center gap-2 rounded-2xl bg-raised py-1.5 pl-3 pr-1.5"
            >
              <Icon name="create-outline" size={14} color={colors.textMuted} />
              <Text muted className="flex-1 text-[13px] leading-[18px]">
                Editing your message. Sending replaces the replies after it.
              </Text>
              <Tap
                accessibilityRole="button"
                accessibilityLabel="Cancel edit"
                onPress={cancelEdit}
                hitSlop={6}
                className="h-7 w-7 items-center justify-center rounded-full"
              >
                <Icon name="close" size={15} color={colors.textMuted} />
              </Tap>
            </Animated.View>
          ) : null}
          {attachments.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, padding: 6 }}
            >
              {attachments.map((a, i) => (
                <Animated.View key={a.uri + i} entering={popIn} exiting={popOut} layout={reflow}>
                  {a.kind === "file" ? (
                    <View
                      accessible
                      accessibilityLabel={`${a.name ?? "File"}, ${typeLabel(a.name ?? "", a.mime)}`}
                      className="h-[60px] w-[176px] flex-row items-center gap-2.5 rounded-[14px] bg-raised px-2.5"
                    >
                      <View
                        className="h-9 w-9 items-center justify-center rounded-[10px]"
                        style={{ backgroundColor: colors.raisedHigh }}
                      >
                        <Icon name={fileIcon(a.name ?? "", a.mime)} size={18} color={colors.text} />
                      </View>
                      <View className="flex-1">
                        <Text
                          weight="medium"
                          className="text-[13px] leading-[17px]"
                          numberOfLines={1}
                        >
                          {a.name ?? "File"}
                        </Text>
                        <Text muted className="text-[12px] leading-4" numberOfLines={1}>
                          {`${typeLabel(a.name ?? "", a.mime)}${a.size ? `, ${humanSize(a.size)}` : ""}`}
                        </Text>
                      </View>
                    </View>
                  ) : (
                    <Image
                      source={{ uri: a.uri }}
                      style={{ width: 60, height: 60, borderRadius: 14 }}
                      contentFit="cover"
                      accessibilityLabel="Attached photo"
                    />
                  )}
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
          {visionNote && standIn ? (
            <Animated.View
              entering={fadeIn}
              exiting={fadeOut}
              accessibilityLiveRegion="polite"
              className="mx-1.5 mb-1 flex-row items-center gap-2 rounded-2xl bg-raised px-3 py-2"
            >
              <Icon name="eye-outline" size={14} color={colors.textMuted} />
              <Text muted className="flex-1 text-[13px] leading-[18px]">
                {model.name} can’t see images, so {standIn.name} will read them for it.
              </Text>
            </Animated.View>
          ) : visionNote ? (
            <Animated.View
              entering={fadeIn}
              exiting={fadeOut}
              accessibilityLiveRegion="polite"
              className="mx-1.5 mb-1 flex-row items-center gap-2 rounded-2xl bg-[rgba(245,165,36,0.12)] px-3 py-2"
            >
              <Icon name="eye-off-outline" size={14} color={colors.warning} />
              <Text className="flex-1 text-[13px] leading-[18px] text-warning">
                {model.name} can’t see images, and none of your models can. Add a vision model in
                Settings to include photos.
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
            <LinkInput
              ref={input}
              value={text}
              onChangeValue={setText}
              placeholder={researchArmed ? "What should I research?" : "Ask anything"}
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="Message"
              onKeyPress={(e) => {
                const ev = e.nativeEvent as {
                  key: string;
                  shiftKey?: boolean;
                  isComposing?: boolean;
                };
                // Enter while an IME is composing confirms the characters, not the message.
                if (
                  Platform.OS === "web" &&
                  ev.key === "Enter" &&
                  !ev.shiftKey &&
                  !ev.isComposing
                ) {
                  (e as unknown as { preventDefault: () => void }).preventDefault();
                  submit();
                }
              }}
            />
          )}

          <View className="flex-row items-center gap-1.5 px-1">
            <View ref={plus} collapsable={false}>
              <Tap
                haptic
                accessibilityLabel="Add photos or files"
                accessibilityHint="Opens camera, photos, files and thinking options"
                onPress={openMenu}
                onLongPress={openMenu}
                className="h-8 w-8 items-center justify-center rounded-full bg-white/[0.07]"
              >
                <Icon name="add" size={20} color={colors.text} />
              </Tap>
            </View>
            <View className="flex-1 flex-row items-center gap-1.5">
              {/* One label for the model and its thinking level, as in Claude's composer. */}
              <Tap
                haptic
                accessibilityRole="button"
                accessibilityLabel={
                  thinkingSupported
                    ? `Model: ${model.name}, thinking ${levelLabel(target.reasoningLevel)}`
                    : `Model: ${model.name}`
                }
                accessibilityHint="Choose the model and how much it thinks"
                onPress={() => setPicker(true)}
                style={{ flexShrink: 1 }}
                className="h-8 flex-row items-center gap-1.5 rounded-full bg-white/[0.07] px-3"
              >
                <Text weight="medium" className="shrink text-[14px]" numberOfLines={1}>
                  {model.name}
                </Text>
                {thinkingSupported ? (
                  <Text weight="medium" muted className="text-[14px]" numberOfLines={1}>
                    {levelLabel(target.reasoningLevel)}
                  </Text>
                ) : null}
              </Tap>
              <Chip
                icon="telescope-outline"
                label={researchArmed ? "Research" : ""}
                accessibilityLabel="Deep research"
                active={researchArmed}
                onPress={() => {
                  setResearchMode(!researchArmed);
                  if (!researchArmed) showToast("Deep research on for the next message");
                }}
              />
            </View>
            <View className="h-9 w-9">
              {streaming ? (
                <Animated.View
                  key="stop"
                  entering={popIn}
                  exiting={popOut}
                  style={StyleSheet.absoluteFill}
                >
                  <Tap
                    accessibilityLabel="Stop"
                    onPress={stop}
                    className="h-9 w-9 items-center justify-center rounded-full bg-ink"
                  >
                    <View className="h-3 w-3 rounded-[3px] bg-black" />
                  </Tap>
                </Animated.View>
              ) : canSend ? (
                <Animated.View
                  key="send"
                  entering={popIn}
                  exiting={popOut}
                  style={StyleSheet.absoluteFill}
                >
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
                <Animated.View
                  key="mic"
                  entering={popIn}
                  exiting={popOut}
                  style={StyleSheet.absoluteFill}
                >
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

      <ActionMenu
        anchor={menuAt}
        items={menu}
        onClose={() => setMenuAt(null)}
        label="Add to message"
      />
      <ModelPicker
        open={picker || regenerateWith !== null}
        onClose={() => {
          setPicker(false);
          pickRegenerateModel(null);
        }}
        value={target.modelRef}
        title={regenerateWith ? "Answer again with" : undefined}
        // Picked from a reply's Regenerate: the chat moves to that model and answers again.
        onSelect={(ref) => {
          setModel(ref);
          if (regenerateWith) regenerate(regenerateWith);
        }}
        level={target.reasoningLevel}
        onLevel={setReasoningLevel}
      />
    </View>
  );
}
