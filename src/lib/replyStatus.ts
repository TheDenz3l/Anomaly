import type { ComponentPart, Message, Part, SearchPart, ThinkingPart } from "./types";

/**
 * What a reply is doing right now, as one line: the status at the top of every assistant reply.
 * Pure, so the chat and the tests read the same story from a message's parts.
 */
export type StatusPhase =
  | "thinking"
  | "searching"
  | "reading"
  | "working"
  | "writing"
  | "building"
  | "imaging"
  | "done"
  | "stopped"
  | "error";

export type ReplyStatus = {
  phase: StatusPhase;
  live: boolean;
  label: string;
  /** Muted words after the label: the query being searched, the latest reasoning headline. */
  detail?: string;
  /** Pages the step is reading, newest last; the line cycles through them while it reads. */
  sites: string[];
  /** Sources the reply searched, for the favicons on a finished line. */
  sourceCount: number;
  /** Whether tapping the line has steps to show: reasoning text, queries, pages. */
  expandable: boolean;
};

/** What the line calls a card while its arguments are still streaming in. */
const BUILDING: Record<string, string> = {
  MovieShowtimes: "showtimes",
  MapCard: "the map",
  Chart: "your chart",
  Table: "a table",
  Compare: "the comparison",
  Timeline: "a timeline",
  Form: "a form",
  Stepper: "the steps",
  Checklist: "your checklist",
  ChoiceChips: "options",
  Weather: "the forecast",
  ProductGrid: "product picks",
  Blocks: "your answer",
  OpenUI: "your answer",
  SubagentPlan: "a plan",
  SubagentTimeline: "the workers",
  ResearchPlan: "a research plan",
  ResearchProgress: "the research run",
  LocationRequest: "a location request",
  MemoryConfirm: "a memory",
  ImageGeneration: "your image",
};

/** "the forecast", "a table": what a card is called while it is being built. */
export function buildingName(component: string): string {
  return BUILDING[component] ?? "a card";
}

const PHASES: SearchPart["phase"][] = ["searching", "reading", "done"];

/**
 * One search section per reply: every search folds into the first one, wherever later searches
 * ran. The reasoning steps that end up side by side merge into one.
 */
export function displayParts(parts: Part[]): Part[] {
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

/** The steps behind a reply's answer, which the status line folds away: reasoning and searches. */
export function isStep(p: Part): p is ThinkingPart | SearchPart {
  return p.type === "thinking" || p.type === "search";
}

function imageWorking(p: ComponentPart): boolean {
  return (
    p.name === "ImageGeneration" && (p.props as { state?: string } | null)?.state === "working"
  );
}

/** Whether the reply's last row shows it moving on its own: text growing, a card building, an image. */
export function contentMoving(p: Part | undefined): boolean {
  if (!p) return false;
  if (p.type === "text") return true;
  if (p.type === "component") return p.status === "streaming" || imageWorking(p);
  return false;
}

/** "9s", "1m 5s": whole seconds, never zero. */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/** The running clock on a live line: "0s", "42s", "1m 05s". */
export function formatClock(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

/**
 * The headline the model gave its latest reasoning, if it writes them (a line in bold on its own,
 * as most reasoning summaries do).
 */
export function reasoningHeadline(text: string): string | undefined {
  const heads = [...text.matchAll(/^\s*\*\*([^*\n]{3,80})\*\*\s*$/gm)];
  const last = heads[heads.length - 1]?.[1]?.trim();
  return last ? last.replace(/[.:]$/, "") : undefined;
}

function liveStatus(message: Message, parts: Part[]): Omit<ReplyStatus, "expandable"> {
  const last = parts[parts.length - 1];
  const search = parts.find((p): p is SearchPart => p.type === "search");
  const sourceCount = search?.sources.length ?? 0;
  const base = { live: true, sites: [] as string[], sourceCount };

  if (last?.type === "thinking" && !last.done)
    return { ...base, phase: "thinking", label: "Thinking", detail: reasoningHeadline(last.text) };
  if (last?.type === "search" && last.phase === "searching")
    return {
      ...base,
      phase: "searching",
      label: "Searching",
      detail: last.queries[last.queries.length - 1],
    };
  if (last?.type === "search" && last.phase === "reading")
    return { ...base, phase: "reading", label: "Reading", sites: last.sources.map((s) => s.url) };
  if (last?.type === "text") return { ...base, phase: "writing", label: "Writing" };
  if (last?.type === "component" && imageWorking(last))
    return { ...base, phase: "imaging", label: "Creating your image" };
  if (last?.type === "component" && last.status === "streaming")
    return { ...base, phase: "building", label: "Building", detail: buildingName(last.name) };

  // Before the first output, or between steps: reasoning models think, the rest just work.
  const reasoning = message.meta && message.meta.levelSent !== "off";
  return reasoning
    ? { ...base, phase: "thinking", label: "Thinking" }
    : { ...base, phase: "working", label: "Working" };
}

/**
 * The status line for a reply, or null when there is nothing worth a line: a finished reply from
 * before replies kept their time, with no reasoning or search behind it.
 */
export function replyStatus(
  message: Message,
  parts = displayParts(message.parts)
): ReplyStatus | null {
  const steps = parts.filter(isStep);
  const expandable = steps.some((p) =>
    p.type === "thinking" ? p.text.trim().length > 0 : p.queries.length + p.sources.length > 0
  );

  if (message.status === "streaming") return { ...liveStatus(message, parts), expandable };

  const search = steps.find((p): p is SearchPart => p.type === "search");
  const sourceCount = search?.sources.length ?? 0;
  const end = { live: false, sites: [], sourceCount, expandable };
  const took = message.workedMs;

  if (message.status === "stopped")
    return {
      ...end,
      phase: "stopped",
      label: took ? `Stopped after ${formatDuration(took)}` : "Stopped",
    };
  if (message.status === "error") return { ...end, phase: "error", label: "Couldn’t finish" };

  if (took) return { ...end, phase: "done", label: `Worked for ${formatDuration(took)}` };
  const thought = steps.reduce(
    (ms, p) => ms + (p.type === "thinking" ? (p.durationMs ?? 0) : 0),
    0
  );
  if (steps.some((p) => p.type === "thinking"))
    return { ...end, phase: "done", label: `Thought for ${formatDuration(thought)}` };
  if (search) return { ...end, phase: "done", label: "Searched the web" };
  return null;
}
