import { Image } from "expo-image";
import { View } from "react-native";
import { Icon } from "@/components/ui/Icon";
import { Text } from "@/components/ui/Text";
import { ComponentRenderer } from "@/genui/ComponentRenderer";
import { collectSources } from "@/lib/artifacts";
import { colors } from "@/lib/theme";
import type { Message, Part, SearchPart, ThinkingPart } from "@/lib/types";
import { Markdown } from "./Markdown";
import { SourcesBar } from "./SourcesBar";
import { ThinkingBlock } from "./ThinkingBlock";
import { ActivityRow } from "./Activity";
import { CitationProvider } from "./Citations";
import { SearchBlock } from "./SearchBlock";

export function UserMessage({ message }: { message: Message }) {
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
  const text = message.parts.find((p) => p.type === "text");
  return (
    <View className="items-end gap-1.5">
      {images.length > 0 ? (
        <View className="flex-row flex-wrap justify-end gap-1.5">
          {images.map((p) =>
            p.type === "image" ? (
              <Image
                key={p.id}
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
      {text && text.type === "text" ? (
        <View className="max-w-[82%] rounded-[22px] rounded-br-md bg-bubble px-4 py-2.5">
          <Text className="text-base leading-6 text-white">{text.text}</Text>
        </View>
      ) : null}
    </View>
  );
}

const PENDING_THOUGHT: ThinkingPart = { id: "pending", type: "thinking", text: "", done: false };

/** Whether the last part already shows the reply is moving: text growing, live reasoning, a search, a skeleton. */
/** Whether a row shows the reply is moving: text growing, live reasoning, a search, a skeleton. */
function showsActivity(p: Part | undefined, last: boolean): boolean {
  if (!p) return false;
  if (p.type === "text") return last;
  if (p.type === "thinking") return !p.done;
  if (p.type === "search") return p.phase !== "done";
  if (p.type === "component") return p.status === "streaming";
  return false;
}

const PHASES: SearchPart["phase"][] = ["searching", "reading", "done"];

/**
 * One search section per reply: every search folds into the first one, wherever later searches
 * ran. The reasoning steps that end up side by side merge into one row.
 */
function displayParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  let search = -1;
  for (const p of parts) {
    if (p.type === "sources") continue;
    if (p.type === "search" && search >= 0) {
      const s = out[search] as SearchPart;
      const seen = new Set(s.sources.map((x) => x.url));
      out[search] = {
        ...s,
        queries: [...s.queries, ...p.queries.filter((q) => !s.queries.includes(q))],
        sources: [...s.sources, ...p.sources.filter((x) => !seen.has(x.url))],
        phase: PHASES[Math.min(PHASES.indexOf(s.phase), PHASES.indexOf(p.phase))],
        durationMs: (s.durationMs ?? 0) + (p.durationMs ?? 0) || undefined,
      };
      continue;
    }
    const prev = out[out.length - 1];
    if (p.type === "thinking" && prev?.type === "thinking") {
      out[out.length - 1] = {
        ...prev,
        text: [prev.text, p.text].filter(Boolean).join("\n\n"),
        done: p.done,
        durationMs: (prev.durationMs ?? 0) + (p.durationMs ?? 0),
      };
      continue;
    }
    if (p.type === "search") search = out.length;
    out.push(p);
  }
  return out;
}

/** Assistant replies have no bubble: text on black, components on surface cards (PRD §2.4). */
/** Assistant replies have no bubble: text on black, components on surface cards (PRD §2.4). */
export function AssistantMessage({ message, last }: { message: Message; last: boolean }) {
  const streaming = message.status === "streaming";
  const sources = collectSources(message);
  const visible = displayParts(message.parts);
  const reasoning = message.meta && message.meta.levelSent !== "off";
  const end = visible.length - 1;
  const moving = visible.some((p, i) => showsActivity(p, i === end));
  // While the model works between visible steps, the last reasoning row picks back up (the next
  // reasoning merges into it anyway) rather than stacking a second "Thinking" row under it.
  const resume = streaming && !moving && visible[end]?.type === "thinking";

  const rows = visible.map((p, i) => {
    switch (p.type) {
      case "thinking":
        // Keyed by position so the pending row below becomes this row when reasoning arrives.
        return (
          <ThinkingBlock
            key={`think-${i}`}
            part={resume && i === end ? { ...p, done: false } : p}
          />
        );
      case "search":
        return <SearchBlock key="search" part={p} animate={streaming} />;
      case "text":
        return <Markdown key={p.id} text={p.text} streaming={streaming && i === end} />;
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
  });
  // Before the first output, or after a search or a card, a pending row holds the next slot. It
  // has the key the next reasoning row will get, so reasoning continues the row instead of remounting it.
  if (streaming && !moving && !resume) {
    const slot = `think-${visible.length}`;
    rows.push(
      reasoning ? (
        <ThinkingBlock key={slot} part={PENDING_THOUGHT} />
      ) : (
        <ActivityRow key={slot} orb="working" live label="Working" />
      )
    );
  }

  return (
    <CitationProvider sources={sources}>
      <View className="gap-3.5">
        {rows}
        {message.status === "stopped" ? (
          <View className="flex-row items-center gap-1.5">
            <Icon name="stop-circle-outline" size={14} color={colors.textFaint} />
            <Text className="text-[13px] text-ink-faint">Stopped</Text>
          </View>
        ) : null}
        {!streaming ? <SourcesBar message={message} sources={sources} /> : null}
        {last ? null : <View className="h-1" />}
      </View>
    </CitationProvider>
  );
}
