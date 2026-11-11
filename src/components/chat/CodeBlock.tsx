import { useState, type ReactNode } from "react";
import { Platform, Text as RNText, ScrollView, View } from "react-native";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { fileFor, isDocument, parseFenceInfo, type DocFile } from "@/lib/docFiles";
import { fileIcon, humanSize } from "@/lib/files";
import { useFileActions } from "@/lib/saveFile";
import { colors } from "@/lib/theme";

/** Bytes the text takes as UTF-8, the size the downloaded file will have. */
function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, monospace",
});

/** Lines of a document shown before "Show all". */
const PREVIEW_LINES = 14;

function Code({ text }: { text: string }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <RNText
        selectable
        style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 19, color: colors.text }}
        className="px-3.5 py-3"
      >
        {text}
      </RNText>
    </ScrollView>
  );
}

function IconButton({
  icon,
  label,
  onPress,
  disabled,
  tint,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tint?: string;
}) {
  return (
    <Tap
      haptic
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      onPress={disabled ? undefined : onPress}
      hitSlop={6}
      className="h-8 w-8 items-center justify-center rounded-full"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Icon name={icon} size={16} color={tint ?? colors.textMuted} />
    </Tap>
  );
}

function PillButton({
  icon,
  label,
  onPress,
  disabled,
  primary,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Tap
      haptic
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      onPress={disabled ? undefined : onPress}
      className={`h-9 flex-1 flex-row items-center justify-center gap-1.5 rounded-full ${primary ? "bg-primary" : "bg-raised"}`}
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <Icon name={icon} size={15} color={primary ? "#FFFFFF" : colors.text} />
      <Text weight="bold" className={`text-[14px] ${primary ? "text-white" : ""}`}>
        {label}
      </Text>
    </Tap>
  );
}

/** A code fence: what language it is, its code in monospace, and copy and download in reach. */
function Snippet({ file, body, live }: { file: DocFile; body: string; live: boolean }) {
  const { copy, download, copied, busy } = useFileActions(file, body);
  return (
    <View className="overflow-hidden rounded-xl bg-card">
      <View className="h-9 flex-row items-center border-b border-raised pl-3.5 pr-1">
        <Text muted className="flex-1 text-xs" numberOfLines={1}>
          {file.lang || "Text"}
        </Text>
        <IconButton
          icon={copied ? "checkmark" : "copy-outline"}
          tint={copied ? colors.success : undefined}
          label={copied ? "Copied" : "Copy code"}
          onPress={() => void copy()}
          disabled={live}
        />
        <IconButton
          icon="download-outline"
          label={`Download ${file.name}`}
          onPress={() => void download()}
          disabled={live || busy}
        />
      </View>
      <Code text={body} />
    </View>
  );
}

/**
 * A file the reply wrote: its name, type and size, a preview that opens to the whole thing, and
 * Copy and Download. Markdown previews as it reads, with its source a tap away.
 */
export function FileCard({
  file,
  body,
  live = false,
  expanded: startExpanded = false,
  renderMarkdown,
}: {
  file: DocFile;
  body: string;
  live?: boolean;
  expanded?: boolean;
  renderMarkdown?: (text: string) => ReactNode;
}) {
  const { copy, download, copied, busy } = useFileActions(file, body);
  const [expanded, setExpanded] = useState(startExpanded);
  const markdown = Boolean(renderMarkdown) && /^mdx?$/.test(file.ext);
  const [source, setSource] = useState(!markdown);
  const lines = body.split("\n");
  const long = lines.length > PREVIEW_LINES;
  const shown = expanded || !long ? body : lines.slice(0, PREVIEW_LINES).join("\n");
  const size = humanSize(utf8Bytes(body));
  const meta = live
    ? "Writing…"
    : `${file.ext.toUpperCase() || "Text"}, ${size}, ${lines.length} ${lines.length === 1 ? "line" : "lines"}`;

  return (
    <View className="overflow-hidden rounded-2xl border border-raised bg-card">
      <View className="flex-row items-center gap-3 px-3.5 pb-3 pt-3.5">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-raised">
          <Icon name={fileIcon(file.name, file.mime)} size={19} color={colors.primaryStrong} />
        </View>
        <View className="flex-1">
          <Text weight="bold" className="text-[15px] leading-5" numberOfLines={1}>
            {file.name}
          </Text>
          <Text muted className="text-xs leading-4">
            {meta}
          </Text>
        </View>
        {markdown ? (
          <IconButton
            icon={source ? "eye-outline" : "code-slash-outline"}
            label={source ? "Show preview" : "Show source"}
            onPress={() => setSource((s) => !s)}
          />
        ) : null}
      </View>

      <View className="border-t border-raised bg-black/30">
        {source || !renderMarkdown ? (
          <Code text={shown} />
        ) : (
          <View className="px-3.5 py-3">{renderMarkdown(shown)}</View>
        )}
        {long ? (
          <Tap
            accessibilityRole="button"
            onPress={() => setExpanded((e) => !e)}
            className="flex-row items-center justify-center gap-1 border-t border-raised py-2.5"
          >
            <Text weight="medium" muted className="text-[13px]">
              {expanded ? "Show less" : `Show all ${lines.length} lines`}
            </Text>
            <Icon
              name={expanded ? "chevron-up" : "chevron-down"}
              size={13}
              color={colors.textMuted}
            />
          </Tap>
        ) : null}
      </View>

      <View className="flex-row gap-2 border-t border-raised p-3">
        <PillButton
          icon={copied ? "checkmark" : "copy-outline"}
          label={copied ? "Copied" : "Copy"}
          onPress={() => void copy()}
          disabled={live}
        />
        <PillButton
          primary
          icon="download-outline"
          label="Download"
          onPress={() => void download()}
          disabled={live || busy}
        />
      </View>
    </View>
  );
}

/** A fenced block in a reply: a file card when it's a document, otherwise a code snippet. */
export function CodeBlock({
  info,
  body,
  live,
  renderMarkdown,
}: {
  info: string;
  body: string;
  live: boolean;
  renderMarkdown?: (text: string) => ReactNode;
}) {
  const file = fileFor(parseFenceInfo(info), body);
  return isDocument(file, body) ? (
    <FileCard file={file} body={body} live={live} renderMarkdown={renderMarkdown} />
  ) : (
    <Snippet file={file} body={body} live={live} />
  );
}
