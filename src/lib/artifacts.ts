import type { CatalogName, CatalogProps } from "@/genui/schemas";
import type { ComponentPart, Message, Part, Source, Thread } from "@/lib/types";

/**
 * Artifacts: everything Anomaly has made in your chats that's worth coming back to — interactive
 * tools, data views and research reports. Derived from messages rather than stored separately, so
 * they stay in sync with the chat they came from. Process UI (plans, progress, prompts) is left out,
 * and so is anything from an incognito chat.
 */

export type ArtifactGroup = "apps" | "reports" | "data";

type Base = {
  id: string;
  threadId: string;
  messageId: string;
  title: string;
  /** What it is, in a word: "Calculator", "Report", "Checklist"… */
  kind: string;
  group: ArtifactGroup;
  createdAt: number;
};

export type Artifact =
  | (Base & { type: "component"; part: ComponentPart })
  | (Base & { type: "report"; message: Message; sources: Source[] });

type Kind<N extends CatalogName> = {
  group: ArtifactGroup;
  kind: (p: CatalogProps<N>) => string;
  title: (p: CatalogProps<N>, thread: Thread) => string;
};

const kinds: { [N in CatalogName]?: Kind<N> } = {
  Chart: { group: "apps", kind: (p) => (p.model ? "Calculator" : "Chart"), title: (p) => p.title },
  Checklist: { group: "apps", kind: () => "Checklist", title: (p) => p.title },
  Stepper: { group: "apps", kind: () => "Guide", title: (p) => p.title },
  Weather: { group: "apps", kind: () => "Forecast", title: (p) => `${p.location} forecast` },
  MovieShowtimes: { group: "apps", kind: () => "Showtimes", title: (p, t) => p.title ?? t.title },
  MapCard: { group: "apps", kind: () => "Map", title: (p, t) => p.title ?? t.title },
  ProductGrid: { group: "apps", kind: () => "Shopping", title: (p, t) => p.title ?? t.title },
  Table: { group: "data", kind: () => "Table", title: (p, t) => p.title ?? t.title },
  Compare: { group: "data", kind: () => "Comparison", title: (p, t) => p.title ?? t.title },
  Timeline: { group: "data", kind: () => "Timeline", title: (p, t) => p.title ?? t.title },
};

/** Merged, de-duplicated sources in the order they arrived: search steps first, then sub-agent and research results. */
export function collectSources(message: Message): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const p of message.parts) {
    const list = p.type === "search" || p.type === "sources" ? p.sources : [];
    for (const s of list) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      out.push(s);
    }
  }
  return out;
}

/**
 * The report itself, without the run's status chatter: from the first heading onward (the text
 * before it is "workers are running…" narration), keeping text and tables.
 */
export function reportParts(message: Message): Part[] {
  const start = message.parts.findIndex((p) => p.type === "text" && p.text.trimStart().startsWith("### "));
  return message.parts
    .slice(Math.max(0, start))
    .filter((p) => p.type === "text" || (p.type === "component" && p.name === "Table"));
}

/** A report's body as Markdown, citations and all. */
export function reportText(message: Message): string {
  return reportParts(message)
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

export function collectArtifacts(threads: Record<string, Thread>, messages: Record<string, Message[]>): Artifact[] {
  const out: Artifact[] = [];
  for (const thread of Object.values(threads)) {
    if (thread.incognito) continue;
    for (const m of messages[thread.id] ?? []) {
      if (m.role !== "assistant" || m.status === "streaming") continue;
      if (m.meta?.kind === "report") {
        out.push({
          type: "report",
          id: `${m.id}-report`,
          threadId: thread.id,
          messageId: m.id,
          title: thread.title.replace(/^Research: /, ""),
          kind: "Report",
          group: "reports",
          createdAt: m.createdAt,
          message: m,
          sources: collectSources(m),
        });
      }
      for (const p of m.parts) {
        if (p.type !== "component" || p.status !== "ready") continue;
        const k = kinds[p.name as CatalogName] as Kind<CatalogName> | undefined;
        if (!k) continue;
        const props = p.props as CatalogProps<CatalogName>;
        out.push({
          type: "component",
          id: p.id,
          threadId: thread.id,
          messageId: m.id,
          title: k.title(props, thread),
          kind: k.kind(props),
          group: k.group,
          createdAt: m.createdAt,
          part: p,
        });
      }
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export const groupLabels: Record<ArtifactGroup, string> = { apps: "Apps", reports: "Reports", data: "Data" };

/** "Today", "Yesterday", a weekday within the week, otherwise a short date. */
export function ago(ts: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ts >= start.getTime()) return "Today";
  if (ts >= start.getTime() - day) return "Yesterday";
  const d = new Date(ts);
  if (ts >= start.getTime() - 6 * day) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Plain text for sharing or copying an artifact. */
export function artifactText(a: Artifact): string {
  if (a.type === "component") return `${a.title}\n\n${a.part.fallbackText}`;
  const refs = a.sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.url}`).join("\n");
  return `# ${a.title}\n\n${reportText(a.message)}\n\n## Sources\n${refs}`;
}
