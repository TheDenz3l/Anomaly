import type { CapabilityProfile, MemoryCategory } from "@/lib/types";

/**
 * DecisionProvider (PRD §4). Jev slots in here later; v1 ships the heuristic implementation so
 * callers never change. Every decision carries a confidence the UI can act on:
 * > 0.85 act, 0.5–0.85 lightweight confirm, < 0.5 ask or fall back.
 */

export type Scenario =
  | "movies"
  | "savings"
  | "research"
  | "subagents"
  | "compare"
  | "weather"
  | "checklist"
  | "memory"
  | "products"
  | "timeline"
  | "form"
  | "steps"
  | "image"
  | "fallback";

export type Difficulty = "easy" | "moderate" | "hard";

export type Decision<T> = { choice: T; confidence: number; provider: "heuristic" | "jev" };

export type RouteInput = { text: string; hasImages: boolean; researchMode: boolean };

export type MemoryGate = {
  remember: boolean;
  text: string;
  category: MemoryCategory;
  scope: "global" | "thread";
};

export interface DecisionProvider {
  route(input: RouteInput): Decision<Scenario>;
  difficulty(text: string): Decision<Difficulty>;
  memoryGate(text: string): Decision<MemoryGate>;
  title(text: string): string;
}

const rules: { scenario: Scenario; pattern: RegExp; confidence: number }[] = [
  { scenario: "subagents", pattern: /\b(sub-?agents?|agents?)\b/i, confidence: 0.97 },
  { scenario: "research", pattern: /\bresearch\b/i, confidence: 0.92 },
  {
    scenario: "memory",
    pattern:
      /\b(remember|i'?m (a |an )?(vegetarian|vegan|allergic)|i am allergic|my name is|i live in)\b/i,
    confidence: 0.88,
  },
  {
    scenario: "movies",
    pattern: /\b(movies?|showtimes?|cinema|theat(re|er)s?|playing near)\b/i,
    confidence: 0.95,
  },
  { scenario: "weather", pattern: /\b(weather|forecast|rain|temperature)\b/i, confidence: 0.94 },
  { scenario: "savings", pattern: /\b(savings?|invest|compound|retire|chart)\b/i, confidence: 0.9 },
  { scenario: "checklist", pattern: /\b(pack(ing)?|checklist|to-?do)\b/i, confidence: 0.9 },
  {
    scenario: "products",
    pattern: /\b(headphones|buy|shopping|products?|under \$\d+)\b/i,
    confidence: 0.86,
  },
  { scenario: "timeline", pattern: /\b(history|timeline)\b/i, confidence: 0.84 },
  { scenario: "form", pattern: /\b(book|reserve|reservation|table for)\b/i, confidence: 0.83 },
  { scenario: "steps", pattern: /\b(how do i|set ?up|steps|guide|install)\b/i, confidence: 0.8 },
  { scenario: "compare", pattern: /\b(compare|vs\.?|versus)\b/i, confidence: 0.82 },
];

function memoryText(raw: string): string {
  let s = raw
    .replace(/^(please\s+)?(remember|note|keep in mind)\s+(that\s+)?/i, "")
    .replace(/[.!]+$/, "")
    .trim();
  const swaps: [RegExp, string][] = [
    [/^i'?m\s+/i, ""],
    [/^i am\s+/i, ""],
    [/^i live in\s+/i, "Lives in "],
    [/^i work (at|for)\s+/i, "Works at "],
    [/^i (like|love|prefer)\s+/i, "Prefers "],
    [/^i hate\s+/i, "Dislikes "],
    [/^my name is\s+/i, "Name is "],
    [/^my\s+/i, "Their "],
  ];
  for (const [re, rep] of swaps) {
    if (re.test(s)) {
      s = s.replace(re, rep);
      break;
    }
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function categorize(text: string): MemoryCategory {
  if (/\b(live|city|home|neighbourhood|neighborhood)\b/i.test(text)) return "place";
  if (/\b(work|job|team|project|company)\b/i.test(text)) return "work";
  if (/\b(name|wife|husband|partner|son|daughter|friend|mom|dad)\b/i.test(text)) return "person";
  if (/\b(prefer|like|love|hate|vegetarian|vegan|allergic)\b/i.test(text)) return "preference";
  return "fact";
}

export const heuristicDecisions: DecisionProvider = {
  route({ text, hasImages, researchMode }) {
    if (hasImages) return { choice: "image", confidence: 0.9, provider: "heuristic" };
    if (researchMode) return { choice: "research", confidence: 0.99, provider: "heuristic" };
    for (const r of rules) {
      if (r.pattern.test(text))
        return { choice: r.scenario, confidence: r.confidence, provider: "heuristic" };
    }
    return { choice: "fallback", confidence: 0.4, provider: "heuristic" };
  },

  difficulty(text) {
    if (
      /\b(research|compare|analy[sz]e|plan|why|explain|prove)\b/i.test(text) ||
      text.length > 220
    ) {
      return { choice: "hard", confidence: 0.78, provider: "heuristic" };
    }
    if (text.length > 70) return { choice: "moderate", confidence: 0.7, provider: "heuristic" };
    return { choice: "easy", confidence: 0.82, provider: "heuristic" };
  },

  memoryGate(text) {
    const explicit = /\b(remember|keep in mind|note that)\b/i.test(text);
    const body = memoryText(text);
    return {
      choice: { remember: true, text: body, category: categorize(text), scope: "global" },
      confidence: explicit ? 0.93 : 0.71,
      provider: "heuristic",
    };
  },

  title(text) {
    const clean = text
      .replace(/[?!.]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    const words = clean.split(" ");
    const short = words.slice(0, 6).join(" ");
    return short.charAt(0).toUpperCase() + short.slice(1) + (words.length > 6 ? "…" : "");
  },
};

export const decisions: DecisionProvider = heuristicDecisions;

/** Maps the thread's Thinking setting onto what this endpoint actually accepts (PRD §3.5 request builder). */
export function resolveReasoning(
  profile: CapabilityProfile,
  requested: string,
  difficulty: Difficulty
): { sent: string; budget?: number } {
  const { style, levels, budgets } = profile.reasoning;
  if (style === "none" || levels.length === 0) return { sent: "off" };
  if (requested === "off") return { sent: "off" };
  let sent: string;
  if (requested === "auto") {
    const idx =
      difficulty === "easy"
        ? 0
        : difficulty === "moderate"
          ? Math.floor((levels.length - 1) / 2)
          : levels.length - 1;
    sent = levels[Math.min(idx, levels.length - 1)];
  } else {
    sent = levels.includes(requested) ? requested : profile.reasoning.defaultLevel;
  }
  return { sent, budget: budgets?.[sent] };
}

export function reasoningTokensFor(sent: string, difficulty: Difficulty): number {
  const base: Record<string, number> = {
    off: 0,
    minimal: 120,
    low: 640,
    on: 1400,
    medium: 1800,
    high: 4200,
  };
  const mult = difficulty === "hard" ? 1.6 : difficulty === "moderate" ? 1.1 : 0.7;
  return Math.round((base[sent] ?? 900) * mult);
}
