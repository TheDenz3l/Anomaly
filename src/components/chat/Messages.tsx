import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useMemo, memo, useState, useEffect, useRef } from "react";
import { Platform, Pressable, View } from "react-native";
import { Tap } from "@/components/ui/Tap";
import { openLink, trustedImageUrls, withLinkUrls } from "@/lib/links";
import { fileIcon, humanSize, typeLabel } from "@/lib/files";
import { useApp } from "@/lib/store";
import { Icon } from "@/components/ui/Icon";
import { Text } from "@/components/ui/Text";
import { ComponentRenderer } from "@/genui/ComponentRenderer";
import { collectSources } from "@/lib/artifacts";
import { colors } from "@/lib/theme";
import { contentMoving, displayParts, isStep, replyStatus } from "@/lib/replyStatus";
import type { Message } from "@/lib/types";
import { Markdown } from "./Markdown";
import { SourcesBar } from "./SourcesBar";
import { CitationProvider } from "./Citations";
import { LinkedText } from "./LinkedText";
import { ReplyStatus, TailGlobe } from "./ReplyStatus";
import { replyEnded } from "@/lib/haptics";

const hoverable = Platform.OS === "web";

/**
 * Your message, with a copy button underneath. On web it appears while the pointer is over the
 * message (its row keeps its space, so nothing shifts); on touch screens a tap on the bubble shows it.
 */
function UserBubble({ text }: { text: string }) {
  const showToast = useApp((s) => s.showToast);
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const shown = hover || open;

  const copy = async () => {
    await Clipboard.setStringAsync(withLinkUrls(text));
    setCopied(true);
    showToast("Copied");
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Pressable
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      onPress={hoverable ? undefined : () => setOpen((o) => !o)}
      accessible={false}
      className="w-full items-end"
    >
      <View className="max-w-[82%] rounded-[22px] rounded-br-md bg-bubble px-4 py-2.5">
        <Text selectable className="text-base leading-6 text-white">
          <LinkedText text={text} color={colors.linkOnBubble} />
        </Text>
      </View>
      {hoverable || shown ? (
        <View className="h-8 flex-row items-center justify-end" style={{ opacity: shown ? 1 : 0 }}>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={copied ? "Copied" : "Copy message"}
            onPress={() => void copy()}
            onFocus={() => setHover(true)}
            onBlur={() => setHover(false)}
            hitSlop={4}
            className="h-8 w-[30px] items-center justify-center rounded-full"
          >
            <Icon
              name={copied ? "checkmark" : "copy-outline"}
              size={17}
              color={copied ? colors.success : colors.textMuted}
            />
          </Tap>
        </View>
      ) : null}
    </Pressable>
  );
}

function UserMessageRow({ message }: { message: Message }) {
  const event = message.parts.find((p) => p.type === "ui_event");
  if (event && event.type === "ui_event") {
    // Auto-saves are the system acting, not the user — the memory card already shows it.
    if (event.action === "auto_saved") return null;
    return (
      <View
        accessibilityLabel={`You: ${event.label}`}
        className="flex-row items-center justify-end gap-1.5 py-0.5"
      >
        <Icon name="return-down-forward" size={13} color={colors.textFaint} />
        <Text weight="medium" className="text-[13px] text-ink-faint">
          {event.label}
        </Text>
      </View>
    );
  }
  const images = message.parts.filter((p) => p.type === "image");
  const files = message.parts.filter((p) => p.type === "file");
  const text = message.parts.find((p) => p.type === "text");
  return (
    <View className="items-end gap-1.5">
      {images.length > 0 ? (
        <View className="flex-row flex-wrap justify-end gap-1.5">
          {images.map((p, i) =>
            p.type === "image" ? (
              // Keyed by position: the sent copy swaps its temporary id for the server's.
              <Image
                key={`img${i}`}
                source={{ uri: p.uri }}
                accessibilityLabel="Attached photo"
                style={{
                  width: images.length > 1 ? 120 : 200,
                  height: images.length > 1 ? 120 : 200 * ((p.height ?? 3) / (p.width ?? 4)),
                  borderRadius: 18,
                }}
                contentFit="cover"
              />
            ) : null
          )}
        </View>
      ) : null}
      {files.length > 0 ? (
        <View className="items-end gap-1.5">
          {files.map((p) =>
            p.type === "file" ? (
              <Tap
                key={p.id}
                accessibilityRole="button"
                accessibilityLabel={`${p.name}, ${typeLabel(p.name, p.mime)}`}
                accessibilityHint="Opens the file"
                disabled={!p.uri?.startsWith("https://")}
                onPress={() => {
                  if (p.uri) void openLink(p.uri);
                }}
                className="max-w-[280px] flex-row items-center gap-3 rounded-[18px] bg-raised py-2.5 pl-2.5 pr-4"
              >
                <View
                  className="h-10 w-10 items-center justify-center rounded-xl"
                  style={{ backgroundColor: colors.raisedHigh }}
                >
                  <Icon name={fileIcon(p.name, p.mime)} size={19} color={colors.text} />
                </View>
                <View className="shrink">
                  <Text weight="medium" className="text-[15px] leading-5" numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text muted className="text-[13px] leading-[18px]" numberOfLines={1}>
                    {`${typeLabel(p.name, p.mime)}${p.size ? `, ${humanSize(p.size)}` : ""}`}
                  </Text>
                </View>
              </Tap>
            ) : null
          )}
        </View>
      ) : null}
      {text && text.type === "text" ? <UserBubble text={text.text} /> : null}
    </View>
  );
}

/**
 * Assistant replies have no bubble: text on black, components on surface cards (PRD §2.4).
 * `onRegenerate` is for replies outside the open chat (a profile sheet's), which the app's chat
 * state doesn't hold: it regenerates them itself and they can't be saved.
 */
function AssistantMessageRow({
  message,
  last,
  onRegenerate,
}: {
  message: Message;
  last: boolean;
  onRegenerate?: (messageId: string) => void;
}) {
  const streaming = message.status === "streaming";
  // The end of a reply settles the haptics: a soft tap once a finished reply has played out.
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) replyEnded(message.status === "done");
    wasStreaming.current = streaming;
  }, [streaming, message.status]);
  const sources = collectSources(message);
  const trustedImages = useMemo(() => trustedImageUrls(message.parts), [message.parts]);
  const visible = displayParts(message.parts);
  const status = replyStatus(message, visible);
  // Reasoning and searches fold into the status line; the answer itself streams below it.
  const steps = visible.filter(isStep);
  const content = visible.filter((p) => !isStep(p));
  const tip = visible[visible.length - 1];
  // Once there is an answer on screen and the model goes on to another step, the foot of the
  // reply shows it too, since the line at the top may have scrolled away.
  const tail = streaming && content.length > 0 && !contentMoving(tip);

  return (
    <CitationProvider sources={sources}>
      <View className="gap-3.5">
        {status ? <ReplyStatus message={message} status={status} steps={steps} /> : null}
        {content.map((p) => {
          switch (p.type) {
            case "text":
              return (
                <Markdown
                  key={p.id}
                  text={p.text}
                  streaming={streaming && p === tip}
                  trustedImages={trustedImages}
                />
              );
            case "component":
              return (
                <ComponentRenderer
                  key={p.id}
                  part={p}
                  threadId={message.threadId}
                  messageStreaming={streaming}
                />
              );
            default:
              return null;
          }
        })}
        {tail && status ? <TailGlobe phase={status.phase} /> : null}
        {!streaming ? (
          <SourcesBar message={message} sources={sources} onRegenerate={onRegenerate} />
        ) : null}
        {last ? null : <View className="h-1" />}
      </View>
    </CitationProvider>
  );
}

/** Rows re-render only when their own message changes, not on every streamed update to the thread. */
export const UserMessage = memo(UserMessageRow);
export const AssistantMessage = memo(AssistantMessageRow);
