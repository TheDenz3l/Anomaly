import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import { Orb } from "@/components/orb/Orb";
import { Favicon } from "@/components/ui/Favicon";
import { Icon } from "@/components/ui/Icon";
import { Tap } from "@/components/ui/Tap";
import { Text } from "@/components/ui/Text";
import { domainOf, openLink } from "@/lib/links";
import { fadeIn, fadeOut } from "@/lib/motion";
import {
  formatClock,
  formatDuration,
  type ReplyStatus as Status,
  type StatusPhase,
} from "@/lib/replyStatus";
import { colors } from "@/lib/theme";
import type { Message, SearchPart, ThinkingPart } from "@/lib/types";
import { Rail } from "./Activity";
import { GLYPH } from "./StatusGlyph";
import { StatusLine } from "./StatusLine";

/** How long the line stays on each page while a search reads them. */
const SITE_MS = 1100;
/**
 * The shortest time a step stays on the line. A step the reply passes through faster (thinking for
 * a moment between a search and the answer) is skipped rather than flashed.
 */
const MIN_SHOW_MS = 650;
/** Pages listed before "Show more" in a search step. */
const FIRST = 6;

/** Whole seconds since `start`, ticking while `live`. */
function useSeconds(start: number, live: boolean): number {
  const [secs, setSecs] = useState(() => Math.max(0, Math.floor((Date.now() - start) / 1000)));
  useEffect(() => {
    if (!live) return;
    const tick = () => setSecs(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    // A quarter-second poll keeps the count on the second; equal values don't re-render.
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [start, live]);
  return secs;
}

/**
 * The status as the line shows it: each step holds for at least MIN_SHOW_MS, and whatever the reply
 * moved on to meanwhile shows once that time is up. Within a step, fresh details pass straight through.
 */
function useHeld(status: Status): Status {
  const key = `${status.phase}|${status.label}|${status.detail ?? ""}`;
  const [shown, setShown] = useState(() => ({ key, status, at: Date.now() }));
  useEffect(() => {
    if (key === shown.key) return;
    const show = () => setShown({ key, status, at: Date.now() });
    const wait = shown.at + MIN_SHOW_MS - Date.now();
    if (wait <= 0) {
      show();
      return;
    }
    const t = setTimeout(show, wait);
    return () => clearTimeout(t);
    // The step to show is fixed by its key; later details of the same step pass straight through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, shown]);
  return key === shown.key ? status : shown.status;
}

/** Steps through `items` one at a time while `active`, wrapping around as more arrive. */
function useCycle(items: string[], active: boolean): string | undefined {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setI((n) => n + 1), SITE_MS);
    return () => clearInterval(id);
  }, [active]);
  return items.length ? items[i % items.length] : undefined;
}

function ThoughtStep({ part }: { part: ThinkingPart }) {
  return (
    <View className="gap-0.5">
      <Text weight="medium" className="text-[13px] leading-5 text-ink-faint">
        {part.done ? `Thought for ${formatDuration(part.durationMs ?? 0)}` : "Thinking"}
      </Text>
      <Text className="pb-1 text-sm leading-[21px] text-ink-faint">
        {part.text || "Reasoning will appear here as the model shares it."}
      </Text>
    </View>
  );
}

function SearchStep({ part, animate }: { part: SearchPart; animate: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? part.sources : part.sources.slice(0, FIRST);
  const hidden = part.sources.length - shown.length;
  const enter = animate ? fadeIn : undefined;
  return (
    <View>
      <Text weight="medium" className="text-[13px] leading-5 text-ink-faint">
        {part.phase === "done" ? "Searched the web" : "Searching the web"}
      </Text>
      {part.queries.map((q) => (
        <Animated.View key={q} entering={enter} className="flex-row items-center gap-2.5 py-1.5">
          <Icon name="search" size={14} color={colors.textFaint} />
          <Text muted className="flex-1 text-[14px] leading-5" numberOfLines={1}>
            {q}
          </Text>
        </Animated.View>
      ))}
      {shown.map((s) => (
        <Animated.View key={s.id} entering={enter}>
          <Tap
            accessibilityRole="link"
            accessibilityLabel={`${s.title}, ${domainOf(s.url)}`}
            onPress={() => void openLink(s.url)}
            className="flex-row items-center gap-2.5 py-1.5"
          >
            <Favicon url={s.url} size={16} />
            <Text className="flex-1 text-[14px] leading-5 text-ink/80" numberOfLines={1}>
              {s.title}
            </Text>
          </Tap>
        </Animated.View>
      ))}
      {hidden > 0 || all ? (
        <Tap accessibilityRole="button" onPress={() => setAll(!all)} className="self-start py-1.5">
          <Text weight="medium" className="text-[14px] text-ink-faint">
            {all ? "Show less" : `Show ${hidden} more`}
          </Text>
        </Tap>
      ) : null}
    </View>
  );
}

/**
 * The status at the top of an assistant reply: one line that follows the reply from thinking
 * through searching and writing to done, then opens to the reasoning and searches behind it.
 */
export function ReplyStatus({
  message,
  status: live,
  steps,
}: {
  message: Message;
  status: Status;
  steps: (ThinkingPart | SearchPart)[];
}) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(0);
  // A reply already finished when the chat opened shows its line still; a live one plays it in.
  const [enter] = useState(live.live);
  const status = useHeld(live);
  const secs = useSeconds(message.startedAt ?? message.createdAt, status.live);
  const site = useCycle(status.sites, status.phase === "reading");
  const search = steps.find((p): p is SearchPart => p.type === "search");

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <StatusLine
        phase={status.phase}
        live={status.live}
        label={status.label}
        detail={status.detail}
        site={status.phase === "reading" ? site : undefined}
        sources={!status.live && search ? search.sources.slice(0, 3).map((s) => s.url) : undefined}
        sourceCount={status.sourceCount}
        timer={status.live ? formatClock(secs) : undefined}
        expanded={open}
        onToggle={live.expandable ? () => setOpen((o) => !o) : undefined}
        enter={enter}
        width={width}
      />
      {open && live.expandable ? (
        <Animated.View entering={fadeIn} exiting={fadeOut}>
          <Rail>
            <View className="gap-3 py-1">
              {steps.map((p) =>
                p.type === "thinking" ? (
                  <ThoughtStep key={p.id} part={p} />
                ) : (
                  <SearchStep key={p.id} part={p} animate={live.live} />
                )
              )}
            </View>
          </Rail>
        </Animated.View>
      ) : null}
    </View>
  );
}

const TAIL_GLOBE: Partial<Record<StatusPhase, "reasoning" | "searching">> = {
  thinking: "reasoning",
  searching: "searching",
  reading: "searching",
};

/**
 * The globe at the foot of a reply that already has an answer on screen while the model goes on
 * to another step, so the end of the reply, where you are reading, still shows it working.
 */
export function TailGlobe({ phase }: { phase: StatusPhase }) {
  return (
    <Animated.View
      entering={fadeIn}
      exiting={fadeOut}
      style={{ width: GLYPH, height: GLYPH, alignItems: "center", justifyContent: "center" }}
    >
      <Orb state={TAIL_GLOBE[phase] ?? "working"} size={16} label="Still working" />
    </Animated.View>
  );
}
