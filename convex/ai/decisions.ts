import type { CapabilityProfile, MemoryCategory, SubagentMode } from "../lib/validators";
import {
  choiceOf,
  jevDecide,
  jevEnabled,
  noulConfidence,
  noulOf,
  scoreOf,
  type JevQuestion,
} from "./jev";
import { cardSummary, type ModelComponent } from "./catalog";
import type { ErrorKind } from "./openai";
import type { Difficulty } from "./reasoning";

/**
 * DecisionProvider (PRD §4). Jev (TypeSafe System One) returns typed, probabilistic choices over a
 * fixed set; until its API is verified every call falls back to the heuristic implementation, so
 * callers never change. Thresholds: > 0.85 act, 0.5–0.85 lightweight confirm, < 0.5 ask/fall back.
 */

export const THRESHOLDS = { act: 0.85, confirm: 0.5 } as const;

export type Band = "act" | "confirm" | "fallback";
export function band(confidence: number): Band {
  if (confidence > THRESHOLDS.act) return "act";
  if (confidence >= THRESHOLDS.confirm) return "confirm";
  return "fallback";
}

export type Decision<T> = { choice: T; confidence: number; provider: "heuristic" | "jev" };

export type Intent = "chat" | "search" | "ui" | "image" | "memory" | "research";
export type Delegation = {
  mode: "none" | "single" | "parallel" | "research";
  n: number;
  explicit: boolean;
};
export type SearchDecision = { mode: "none" | "quick" | "deep"; timeSensitive: boolean };
export type MemoryGate = {
  remember: boolean;
  text: string;
  category: MemoryCategory;
  scope: "global" | "thread";
};
export type ProbeName =
  | "basic"
  | "effort_flat"
  | "reasoning_check"
  | "effort_nested"
  | "budget"
  | "toggle"
  | "noop"
  | "tools"
  | "vision"
  | "web_search";
export type TurnTaking = "continue" | "end" | "interrupt";

export type TurnInput = {
  text: string;
  hasImages: boolean;
  researchMode: boolean;
  subagentMode: SubagentMode;
  /** The previous assistant reply, for follow-ups like "and tomorrow?". */
  recent?: string;
  /** Card names Jev may pick from. */
  components?: readonly string[];
  timeoutMs?: number;
};

/** Typed moderation/PII flags (PRD §4): used to mask decision logs, never shown to the model. */
export type SafetyFlag = "pii_contact" | "pii_sensitive" | "credentials" | "unsafe";

/** Every per-turn decision (PRD §4 table), answered in one Jev request or by heuristics. */
export type PresentationKind = "text" | "visual" | "tool" | "data";
/**
 * How the reply should look, in the spirit of OpenAI's Intelligent UI ("the format depends on what
 * you're asking"): plain text, a composed visual answer, a live tool, or a data card. The visual and
 * tool probabilities are kept so borderline answers can still be offered the card.
 */
export type Presentation = { kind: PresentationKind; visual: number; tool: number };

export type TurnDecisions = {
  intent: Decision<Intent>;
  difficulty: Decision<Difficulty>;
  search: Decision<SearchDecision>;
  delegation: Decision<Delegation>;
  components: Decision<Partial<Record<ModelComponent, number>>>;
  presentation: Decision<Presentation>;
  memory: Decision<MemoryGate>;
  safety: Decision<SafetyFlag[]>;
  costUsd?: number;
};

export type FollowUpInput = { message: string; reply: string; candidates: string[] };

export interface DecisionProvider {
  turn(i: TurnInput): Promise<TurnDecisions>;
  intent(i: { text: string; hasImages: boolean; researchMode: boolean }): Promise<Decision<Intent>>;
  components(text: string): Promise<Decision<Partial<Record<ModelComponent, number>>>>;
  difficulty(text: string): Promise<Decision<Difficulty>>;
  delegation(text: string, mode: SubagentMode): Promise<Decision<Delegation>>;
  search(text: string): Promise<Decision<SearchDecision>>;
  memoryGate(text: string): Promise<Decision<MemoryGate>>;
  memoryRelevance(query: string, candidates: string[]): Promise<Decision<number[]>>;
  errorKind(status: number, body: string, fallback: ErrorKind): Promise<Decision<ErrorKind>>;
  probeTriage(profile: CapabilityProfile, available: ProbeName[]): Promise<Decision<ProbeName[]>>;
  followUps(i: FollowUpInput): Promise<Decision<string[]>>;
  turnTaking(i: { transcript: string; silenceMs: number }): Promise<Decision<TurnTaking>>;
  pii(text: string): Decision<{ flags: string[]; masked: string }>;
  title(text: string): string;
}

/* ------------------------------------------------------------------ heuristics */

const h = <T>(choice: T, confidence: number): Decision<T> => ({
  choice,
  confidence,
  provider: "heuristic",
});

const COMPONENT_HINTS: [ModelComponent, RegExp, number][] = [
  ["MovieShowtimes", /\b(movies?|showtimes?|cinema|theat(re|er)s?|playing near)\b/i, 0.95],
  ["MapCard", /\b(near me|nearby|map|directions|where is|closest|around here)\b/i, 0.8],
  ["Weather", /\b(weather|forecast|rain|snow|temperature|umbrella)\b/i, 0.95],
  ["Chart", /\b(chart|graph|plot|savings?|invest|compound|retire|growth over)\b/i, 0.85],
  ["Checklist", /\b(pack(ing)?|checklist|to-?do|shopping list)\b/i, 0.9],
  [
    "ProductGrid",
    /\b(buy|shopping|best .{0,30}(headphones|laptop|phone|camera|bike)|under \$\d+|products?)\b/i,
    0.8,
  ],
  ["Timeline", /\b(history of|timeline|chronolog)/i, 0.85],
  ["Form", /\b(book|reserve|reservation|table for|sign ?up|fill (in|out))\b/i, 0.75],
  ["Stepper", /\b(how do i|how to|set ?up|install|steps|guide|recipe)\b/i, 0.75],
  ["Compare", /\b(compare|vs\.?|versus|difference between|better than)\b/i, 0.85],
  ["Table", /\b(table|list of|breakdown|specs|prices of)\b/i, 0.6],
  [
    "Blocks",
    /\b(plan (a|an|my|for|out)|itinerary|calculator|calculate|split (the )?(bill|check)|tip calc|scale (a |the |this )?recipe|break (it |this )?down|how does .{1,40} work)\b/i,
    0.7,
  ],
];

const SMALL_TALK =
  /^(hi|hey|hello|yo|thanks|thank you|ok|okay|cool|nice|good (morning|night|evening)|how are you)[!. ]*$/i;
const TIME_SENSITIVE =
  /\b(today|tonight|tomorrow|this (week|weekend|month|year)|latest|newest|news|recent(ly)?|just (came out|dropped|released|announced)|current(ly)?|right now|now playing|price|stock|score|election|release date|near me|open now|20[2-3]\d)\b/i;

const PHOTOS =
  /\b(photos?|pictures?|pics|images?|screenshots?|wallpapers?|gallery|what (does|do|did) .{1,60} look like)\b/i;
const MAKE_IMAGE =
  /\b(generate|create|draw|make|design|edit)\b.{0,30}\b(images?|pictures?|photos?)\b/i;

/** The user wants to see photos (not have one made): a search then brings back photos too. */
export function wantsPhotos(text: string): boolean {
  return PHOTOS.test(text) && !MAKE_IMAGE.test(text);
}

const FILLER = [
  /\b(can|could|would|will) you( please)?\b/gi,
  /\b(please|pls|plz|hey|hi|hello|yo|thanks|thank you)\b/gi,
  /\b(show|tell|give|grab|get|find|send|bring) me\b/gi,
  /\bi (heard|think|thought|saw|read|want|need|wonder(ed)?|was wondering|guess)( that| it was| about)?\b/gi,
  /\b(a bunch of|a few|a couple of|some of|all of|all|any|some)\b/gi,
  /\b(what'?s|whats|what is|what are|is there|are there|do you know|let me know)\b/gi,
  /\bi'?m (curious|wondering|interested)( about| if| in)?\b/gi,
];
const QUERY_DROP = new Set(
  "the a an of for to in on at about and or with that this these those were was is are been be it its i me my you your we our they them there here just really also so very".split(
    " "
  )
);

/**
 * A search query from a chat message, for searching before the model has written one: the first
 * sentence or two with the asking and the filler taken out ("Show me a bunch of the new photos
 * that were released recently for gta 6" → "new photos released recently gta 6"). Results must
 * share most of a query's words to count as on topic, which a whole chatty sentence never does.
 */
export function searchQueryFrom(text: string): string {
  const sentences = text
    // The iOS keyboard types curly apostrophes ("What’s"); the filler patterns use straight ones.
    .replace(/[‘’]/g, "'")
    .split(/(?<=[?!])\s+|(?<=\w\.)\s+|\.{2,}|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  let words: string[] = [];
  let taken = "";
  for (const sentence of sentences) {
    taken = `${taken} ${sentence}`;
    let q = taken;
    for (const re of FILLER) q = q.replace(re, " ");
    words = q
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter((w) => w && !QUERY_DROP.has(w.toLowerCase()));
    if (words.length >= 3) break;
  }
  return (words.slice(0, 8).join(" ") || text.trim()).slice(0, 300);
}
const DEEP =
  /\b(research|in-?depth|sources|cite|citations|comprehensive|literature|evidence|reviews of)\b/i;
const FACTUAL = /^(who|what|when|where|which|how (much|many|old|tall|far))\b/i;

const EXPLICIT_AGENTS =
  /(^\/agents\b)|\b(use|using|with|spin up|spawn|run)\s+(\d+\s+|two\s+|three\s+|four\s+|five\s+)?(parallel\s+)?(sub-?agents?|agents?|workers?)\b/i;
const WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };

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
    [/^i work as\s+/i, "Works as "],
    [/^i (like|love|prefer)\s+/i, "Prefers "],
    [/^i (hate|dislike|don'?t like)\s+/i, "Dislikes "],
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
  if (/\b(live|city|home|neighbou?rhood|moved to)\b/i.test(text)) return "place";
  if (/\b(work|job|team|project|company|office|boss)\b/i.test(text)) return "work";
  if (
    /\b(name|wife|husband|partner|son|daughter|friend|mom|dad|mother|father|kids?|dog|cat)\b/i.test(
      text
    )
  )
    return "person";
  if (/\b(prefer|like|love|hate|vegetarian|vegan|allergic|favou?rite|don'?t eat)\b/i.test(text))
    return "preference";
  return "fact";
}

const EXPLICIT_MEMORY = /\b(remember|keep in mind|note that|don'?t forget)\b/i;
const IMPLICIT_MEMORY =
  /\b(i'?m (a |an )?(vegetarian|vegan|pescatarian|allergic|lactose)|i am allergic|my name is|i live in|i moved to|i work (at|for|as)|my (wife|husband|partner|son|daughter|dog|cat)('?s name)? is|i (prefer|always|never|hate|love) )/i;

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}
const STOP = new Set(
  "the and for are you your with that this from have has was were what when where which who will would about into them they then than there their our out can could should just like".split(
    " "
  )
);

const PII: [string, RegExp, string][] = [
  ["email", /[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  ["api_key", /\b(sk|pk|fc|rk|xox[abp])-[A-Za-z0-9_-]{12,}\b/g, "[key]"],
  ["card", /\b(?:\d[ -]?){13,19}\b/g, "[card]"],
  ["phone", /(?<!\w)\+?\d[\d\s().-]{8,}\d/g, "[phone]"],
  ["ip", /\b\d{1,3}(\.\d{1,3}){3}\b/g, "[ip]"],
];

const TOOL_HINT =
  /\b(calculat\w*|split .{0,30}\b(bill|check)|tip (for|on)|how much (would|will|should|do) i|convert|scale (a |the |this )?recipe|budget|loan|payments?|compound)\b/i;
const VISUAL_HINT =
  /\b(plan (a|an|my|for|out)|itinerary|schedule|routine|break (it |this )?down|breakdown|how (does|do) .{1,40} work|how (to|do i)\b|steps? (to|for)|guide|explain how|difference between|compare|versus|vs\.?|recipe)\b/i;

function presentationHeuristic(text: string): Decision<Presentation> {
  if (TOOL_HINT.test(text)) return h({ kind: "tool", visual: 0.3, tool: 0.6 }, 0.6);
  if (VISUAL_HINT.test(text)) return h({ kind: "visual", visual: 0.6, tool: 0.1 }, 0.6);
  return h({ kind: "text", visual: 0, tool: 0 }, 0.55);
}

export const heuristicDecisions: DecisionProvider = {
  async turn(i) {
    const h_ = heuristicDecisions;
    const [intent, difficulty, search, delegation, components, memory] = await Promise.all([
      h_.intent({ text: i.text, hasImages: i.hasImages, researchMode: i.researchMode }),
      h_.difficulty(i.text),
      h_.search(i.text),
      h_.delegation(i.text, i.subagentMode),
      h_.components(i.text),
      h_.memoryGate(i.text),
    ]);
    const safety = h_.pii(i.text);
    const flags: SafetyFlag[] = [];
    if (safety.choice.flags.some((f) => f === "email" || f === "phone")) flags.push("pii_contact");
    if (safety.choice.flags.includes("card")) flags.push("pii_sensitive");
    if (safety.choice.flags.includes("api_key")) flags.push("credentials");
    return {
      intent,
      difficulty,
      search,
      delegation,
      components,
      presentation: presentationHeuristic(i.text),
      memory,
      safety: h(flags, safety.confidence),
    };
  },

  async intent({ text, hasImages, researchMode }) {
    if (researchMode) return h("research", 0.99);
    if (hasImages) return h("image", 0.9);
    if (SMALL_TALK.test(text.trim())) return h("chat", 0.95);
    if (EXPLICIT_MEMORY.test(text)) return h("memory", 0.9);
    for (const [, re, c] of COMPONENT_HINTS) if (re.test(text)) return h("ui", c);
    if (TIME_SENSITIVE.test(text) || DEEP.test(text)) return h("search", 0.75);
    return h("chat", 0.55);
  },

  async components(text) {
    const out: Partial<Record<ModelComponent, number>> = {};
    let top = 0;
    for (const [name, re, c] of COMPONENT_HINTS) {
      if (re.test(text)) {
        out[name] = c;
        top = Math.max(top, c);
      }
    }
    return h(out, top || 0.3);
  },

  async difficulty(text) {
    if (
      /\b(research|compare|analy[sz]e|plan|why|explain|prove|derive|trade-?offs?|design|debug)\b/i.test(
        text
      ) ||
      text.length > 220
    )
      return h("hard", 0.78);
    if (text.length > 70) return h("moderate", 0.7);
    return h("easy", 0.82);
  },

  async delegation(text, mode) {
    const m = text.match(EXPLICIT_AGENTS);
    const research = /\bresearch with (\d+|two|three|four|five) agents\b/i.exec(text);
    if (m || research) {
      const raw = (research?.[1] ?? m?.[4] ?? "").trim().toLowerCase();
      const n = Math.min(5, Math.max(2, Number(raw) || WORDS[raw] || 3));
      return h({ mode: research ? "research" : "parallel", n, explicit: true }, 0.97);
    }
    if (mode === "off") return h({ mode: "none", n: 0, explicit: false }, 0.99);
    const entities = text
      .split(/,|\band\b|\bvs\.?\b|\bversus\b/i)
      .filter((s) => s.trim().length > 2);
    if (/\b(compare|versus|vs\.?)\b/i.test(text) && entities.length >= 3) {
      return h({ mode: "parallel", n: Math.min(5, entities.length), explicit: false }, 0.6);
    }
    if (DEEP.test(text) && text.length > 120)
      return h({ mode: "single", n: 1, explicit: false }, 0.55);
    return h({ mode: "none", n: 0, explicit: false }, 0.85);
  },

  async search(text) {
    const timeSensitive = TIME_SENSITIVE.test(text);
    if (DEEP.test(text)) return h({ mode: "deep", timeSensitive }, 0.8);
    if (timeSensitive) return h({ mode: "quick", timeSensitive }, 0.85);
    if (FACTUAL.test(text.trim())) return h({ mode: "quick", timeSensitive: false }, 0.55);
    return h({ mode: "none", timeSensitive: false }, 0.7);
  },

  async memoryGate(text) {
    const explicit = EXPLICIT_MEMORY.test(text);
    const implicit = IMPLICIT_MEMORY.test(text);
    const question =
      /\?\s*$/.test(text.trim()) ||
      /^(do|does|did|can|could|what|who|where|when|how|is|are)\b/i.test(text.trim());
    if ((!explicit && !implicit) || (question && !explicit)) {
      return h({ remember: false, text: "", category: "fact", scope: "global" }, 0.9);
    }
    const scope = /\b(for this (chat|thread|conversation)|in this chat)\b/i.test(text)
      ? "thread"
      : "global";
    return h(
      { remember: true, text: memoryText(text), category: categorize(text), scope },
      explicit ? 0.93 : 0.72
    );
  },

  async memoryRelevance(query, candidates) {
    const q = tokens(query);
    const scores = candidates.map((c) => {
      const t = tokens(c);
      if (!q.size || !t.size) return 0;
      let hit = 0;
      for (const w of t) if (q.has(w)) hit++;
      return Math.min(1, hit / Math.min(q.size, t.size) + 0.05);
    });
    return h(scores, 0.6);
  },

  async errorKind(_status, _body, fallback) {
    return h(fallback, 0.8);
  },

  async probeTriage(profile, available) {
    const skip = new Set<ProbeName>();
    const r = profile.reasoning;
    if (profile.source === "manual") return h([], 0.99);
    if (profile.confidence >= 0.9) {
      if (r.style !== "none") {
        skip.add(r.style === "effort" ? "budget" : "effort_flat");
        skip.add("toggle");
      }
    }
    if (r.style === "none" && profile.confidence >= 0.85) {
      skip.add("noop");
    }
    if (profile.confidence >= 0.9 && profile.features.vision) skip.add("vision");
    return h(
      available.filter((p) => !skip.has(p)),
      0.7
    );
  },

  async followUps({ candidates }) {
    // Without Jev there's no ranking signal, so stay quiet (confirm band → not shown).
    return h(candidates.slice(0, 3), 0.5);
  },

  async turnTaking({ transcript, silenceMs }) {
    const t = transcript.trim();
    if (/^(stop|wait|hold on|cancel|never ?mind)\b/i.test(t)) return h("interrupt", 0.92);
    const trailing = /\b(and|or|but|so|because|the|a|to|of|um+|uh+)$/i.test(t);
    if (silenceMs > 1600 && !trailing) return h("end", 0.88);
    if (silenceMs > 900 && /[.?!]$/.test(t)) return h("end", 0.8);
    return h("continue", trailing ? 0.9 : 0.65);
  },

  pii(text) {
    const flags: string[] = [];
    let masked = text;
    for (const [flag, re, rep] of PII) {
      if (re.test(masked)) {
        flags.push(flag);
        masked = masked.replace(re, rep);
      }
      re.lastIndex = 0;
    }
    return h({ flags, masked }, flags.length ? 0.85 : 0.95);
  },

  title(text) {
    const clean = text
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
      .replace(/^\/\w+\s*/, "")
      .replace(/[?!.]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return "New chat";
    const words = clean.split(" ");
    const short = words.slice(0, 6).join(" ");
    return short.charAt(0).toUpperCase() + short.slice(1) + (words.length > 6 ? "…" : "");
  },
};

/* ------------------------------------------------------------------ Jev (TypeSafe System One) */

const yesNo = (instructions: string, yes: string, no: string): JevQuestion => ({
  type: "noul",
  instructions,
  criteria: { true: yes, false: no },
});

/** The per-turn question set: every row of the PRD §4 table that depends on the user's message. */
const TURN_QUESTIONS = (components: readonly string[]): Record<string, JevQuestion> => ({
  intent: {
    type: "choice",
    instructions: "What does the user mainly need from their latest message?",
    criteria: {
      chat: "Conversation, opinion, writing, coding or general knowledge answerable without tools.",
      search: "Current or factual information that needs a web search.",
      ui: "Live data or structure best shown as an interactive card (weather, places, showtimes, charts, checklists, comparisons, steps, forms, plans, breakdowns, calculators).",
      image: "Understanding or discussing an image the user attached.",
      memory: "The user is mainly telling the assistant something about themselves.",
      research: "An in-depth, multi-source investigation that ends in a cited report.",
    },
  },
  card: {
    type: "choice",
    instructions: "Which interactive card would best present the answer?",
    criteria: Object.fromEntries([
      ["none", "Plain text is best."],
      ...components.map((c) => [c, cardSummary(c)]),
    ]),
  },
  presentation: {
    type: "choice",
    instructions: "How should the reply to the user's latest message be presented on a phone?",
    criteria: {
      text: "Plain text reads best: conversation, reactions, opinions, creative writing, code, a quick fact or a one-line calculation.",
      visual:
        "The answer has a shape worth seeing laid out: a plan or itinerary, a schedule, how something works, a breakdown into parts, steps to follow, a ranked list or top picks, key numbers, or options weighed side by side.",
      tool: "The user would want to change numbers and watch results update: amounts, quantities, headcount, rates, budgets, tips, splits, conversions or scaling.",
      data: "Live data from an app tool: weather, places nearby, showtimes, products to buy, or figures over time.",
    },
  },
  search_depth: {
    type: "choice",
    instructions: "How much web searching does a good answer need?",
    criteria: {
      none: "No search; answer from knowledge or the conversation.",
      quick: "One or two searches to confirm facts or get current data.",
      deep: "Many searches across sources, comparing and citing them.",
    },
  },
  time_sensitive: yesNo(
    "Does a good answer depend on current or recent information?",
    "Needs today's or recent data (news, prices, schedules, weather, releases).",
    "Timeless; general knowledge is enough."
  ),
  difficulty: {
    type: "score",
    instructions: "How much reasoning does a good answer need?",
    criteria: [
      "Trivial, lookup or small talk",
      "Some thought",
      "Hard multi-step reasoning, analysis or planning",
    ],
  },
  delegate: {
    type: "choice",
    instructions: "Should the assistant hand this to background workers?",
    criteria: {
      none: "One assistant can answer directly.",
      single: "One focused worker would help (long reading or a separate investigation).",
      parallel:
        "Several independent sub-tasks (one per product, place or source) that can run in parallel.",
      research:
        "A full deep-research run: clarify, plan, search many sources, write a cited report.",
    },
  },
  parallel_count: {
    type: "score",
    instructions: "If split into parallel workers, how many independent sub-tasks are there?",
    criteria: ["2", "3", "4", "5"],
  },
  remember: yesNo(
    "Does the user state a durable fact or preference about themselves worth remembering in future chats?",
    "A lasting personal fact or preference (diet, home city, family, work, likes).",
    "No lasting personal fact, or it's a question or one-off detail."
  ),
  memory_category: {
    type: "choice",
    instructions: "If this were saved to memory, what kind of fact is it?",
    criteria: {
      preference: "Likes, dislikes, diet, style.",
      fact: "Other facts about the user.",
      person: "People in the user's life.",
      place: "Where the user lives or goes.",
      work: "Job, team, projects.",
    },
  },
  memory_scope: {
    type: "choice",
    instructions: "Where should that memory apply?",
    criteria: {
      global: "Useful in any future chat.",
      thread: "Only relevant to this conversation.",
    },
  },
  pii_contact: yesNo(
    "Does the message contain contact details (email, phone number, street address)?",
    "Contains contact details.",
    "No contact details."
  ),
  pii_sensitive: yesNo(
    "Does the message contain sensitive personal data (health, finances, government IDs, card numbers)?",
    "Contains sensitive personal data.",
    "No sensitive personal data."
  ),
  credentials: yesNo(
    "Does the message contain a password, API key, token or other secret?",
    "Contains a secret.",
    "No secrets."
  ),
  unsafe: yesNo(
    "Is the request harmful (self-harm, violence, weapons, illegal activity, abuse)?",
    "Harmful request.",
    "Not harmful."
  ),
});

const DIFFICULTY_LEVELS: Difficulty[] = ["easy", "moderate", "hard"];
const SAFETY: SafetyFlag[] = ["pii_contact", "pii_sensitive", "credentials", "unsafe"];

function jevD<T>(choice: T, confidence: number): Decision<T> {
  return { choice, confidence: Math.round(confidence * 100) / 100, provider: "jev" };
}

/** Below the confirm threshold Jev's answer is ignored and the heuristic stands (PRD §4). */
const usable = (confidence: number) => band(confidence) !== "fallback";

const jevDecisions: DecisionProvider = {
  ...heuristicDecisions,

  async turn(input) {
    const base = await heuristicDecisions.turn(input);
    if (input.researchMode || !input.text.trim()) return base;
    const res = await jevDecide(
      {
        message: input.text.slice(0, 4000),
        has_images: input.hasImages,
        previous_reply: input.recent?.slice(0, 1500) ?? "",
      },
      TURN_QUESTIONS(input.components ?? []),
      input.timeoutMs ?? 2000
    );
    if (!res) return base;
    const a = res.answers;
    const out: TurnDecisions = { ...base, costUsd: res.costUsd };

    const intent = choiceOf(a.intent);
    if (intent && usable(intent.confidence))
      out.intent = jevD(intent.choice as Intent, intent.confidence);

    const card = choiceOf(a.card);
    if (card && usable(card.confidence)) {
      const probs: Partial<Record<ModelComponent, number>> = {};
      for (const [k, prob] of Object.entries(card.probabilities)) {
        if (k !== "none" && prob > 0.05) probs[k as ModelComponent] = prob;
      }
      out.components = jevD(probs, card.confidence);
    }

    // Kept even below the confidence floor: the visual and tool probabilities are what the turn
    // weighs, and they stay calibrated when no single format wins outright.
    const pres = choiceOf(a.presentation);
    if (pres) {
      out.presentation = jevD(
        {
          kind: pres.choice as PresentationKind,
          visual: pres.probabilities.visual ?? 0,
          tool: pres.probabilities.tool ?? 0,
        },
        pres.confidence
      );
    }

    const depth = choiceOf(a.search_depth);
    const timely = noulOf(a.time_sensitive);
    if (depth && usable(depth.confidence)) {
      out.search = jevD(
        {
          mode: depth.choice as SearchDecision["mode"],
          timeSensitive: timely !== null ? timely > 0.5 : base.search.choice.timeSensitive,
        },
        depth.confidence
      );
    }

    const diff = scoreOf(a.difficulty);
    if (diff && usable(diff.confidence)) {
      out.difficulty = jevD(
        DIFFICULTY_LEVELS[Math.min(2, Math.max(0, Math.round(diff.score)))],
        diff.confidence
      );
    }

    // An explicit "use sub-agents" request always wins (PRD §3.6).
    const del = choiceOf(a.delegate);
    if (
      del &&
      usable(del.confidence) &&
      !base.delegation.choice.explicit &&
      input.subagentMode !== "off"
    ) {
      const mode = del.choice as Delegation["mode"];
      const count = scoreOf(a.parallel_count);
      const n =
        mode === "parallel"
          ? 2 + Math.min(3, Math.max(0, Math.round(count?.score ?? 1)))
          : mode === "single"
            ? 1
            : 0;
      out.delegation = jevD({ mode, n, explicit: false }, del.confidence);
    }

    const remember = noulOf(a.remember);
    if (remember !== null) {
      const cat = choiceOf(a.memory_category);
      const scope = choiceOf(a.memory_scope);
      out.memory = jevD(
        {
          remember: remember > 0.5,
          text: base.memory.choice.text || memoryText(input.text),
          category:
            cat && usable(cat.confidence)
              ? (cat.choice as MemoryCategory)
              : base.memory.choice.category,
          scope:
            scope && usable(scope.confidence)
              ? (scope.choice as MemoryGate["scope"])
              : base.memory.choice.scope,
        },
        noulConfidence(remember)
      );
    }

    const flags = new Set<SafetyFlag>(base.safety.choice);
    let safetyConfidence = 1;
    for (const f of SAFETY) {
      const prob = noulOf(a[f]);
      if (prob === null) continue;
      if (prob > 0.5) flags.add(f);
      safetyConfidence = Math.min(safetyConfidence, noulConfidence(prob));
    }
    out.safety = jevD([...flags], safetyConfidence);
    return out;
  },

  async memoryGate(text) {
    const base = await heuristicDecisions.memoryGate(text);
    const q = TURN_QUESTIONS([]);
    const res = await jevDecide(
      { message: text.slice(0, 2000) },
      { remember: q.remember, memory_category: q.memory_category, memory_scope: q.memory_scope },
      2000
    );
    const p = noulOf(res?.answers.remember);
    if (p === null) return base;
    const cat = choiceOf(res?.answers.memory_category);
    const scope = choiceOf(res?.answers.memory_scope);
    return jevD(
      {
        remember: p > 0.5,
        text: base.choice.text || memoryText(text),
        category:
          cat && usable(cat.confidence) ? (cat.choice as MemoryCategory) : base.choice.category,
        scope:
          scope && usable(scope.confidence)
            ? (scope.choice as MemoryGate["scope"])
            : base.choice.scope,
      },
      noulConfidence(p)
    );
  },

  async memoryRelevance(query, candidates) {
    if (!candidates.length) return heuristicDecisions.memoryRelevance(query, candidates);
    const list = candidates.slice(0, 16);
    const questions: Record<string, JevQuestion> = {};
    list.forEach((c, i) => {
      questions[`m${i}`] = yesNo(
        `Would knowing this about the user help answer their message? Memory: "${c.slice(0, 300)}"`,
        "Relevant to this message.",
        "Unrelated to this message."
      );
    });
    const res = await jevDecide({ message: query.slice(0, 2000) }, questions, 2000);
    if (!res) return heuristicDecisions.memoryRelevance(query, candidates);
    const scores = candidates.map((_, i) =>
      i < list.length ? (noulOf(res.answers[`m${i}`]) ?? 0) : 0
    );
    return jevD(scores, 0.8);
  },

  async errorKind(status, body, fallback) {
    const res = await jevDecide(
      { http_status: status, body: body.slice(0, 1500) },
      {
        kind: {
          type: "choice",
          instructions: "What went wrong with this model API request?",
          criteria: {
            bad_param: "A request parameter or value isn't supported.",
            rate_limit: "Too many requests or quota exceeded.",
            auth: "Invalid or missing API key, or no access.",
            context_overflow: "The prompt is longer than the model's context window.",
            not_found: "The model or endpoint doesn't exist.",
            server: "Temporary provider/server failure.",
            unknown: "Something else.",
          },
        },
      },
      1500
    );
    const c = choiceOf(res?.answers.kind);
    return c && usable(c.confidence)
      ? jevD(c.choice as ErrorKind, c.confidence)
      : heuristicDecisions.errorKind(status, body, fallback);
  },

  async probeTriage(profile, available) {
    if (profile.source === "manual") return heuristicDecisions.probeTriage(profile, available);
    const what: Record<ProbeName, string> = {
      basic: "a plain request works at all",
      effort_flat: "the top-level reasoning_effort parameter is accepted, and which levels",
      reasoning_check:
        "the model actually reasons when asked, for an endpoint that accepts any effort value",
      effort_nested: "a nested reasoning.effort parameter is accepted",
      budget:
        "a reasoning token budget (reasoning.max_tokens or thinking.budget_tokens) is accepted",
      toggle: "reasoning can be switched on and off",
      noop: "changing the reasoning level actually changes reasoning tokens",
      tools: "tool calling works",
      vision: "image input works",
      web_search: "built-in web search works",
    };
    const questions: Record<string, JevQuestion> = {};
    for (const p of available) {
      questions[p] = yesNo(
        `Given the current capability profile, is a probe still needed to check whether ${what[p]}?`,
        "The profile doesn't settle this with confidence; probing adds information.",
        "The profile already settles this; probing would waste a request."
      );
    }
    const res = await jevDecide(
      {
        reasoning: profile.reasoning,
        features: profile.features,
        confidence: profile.confidence,
        source: profile.source,
      },
      questions,
      2000
    );
    if (!res) return heuristicDecisions.probeTriage(profile, available);
    const keep = available.filter((p) => (noulOf(res.answers[p]) ?? 1) > 0.5);
    return jevD(keep.includes("basic") || !keep.length ? keep : ["basic", ...keep], 0.8);
  },

  async followUps({ message, reply, candidates }) {
    if (!candidates.length) return jevD([], 0.9);
    const res = await jevDecide(
      { message: message.slice(0, 1500), reply: reply.slice(0, 2000) },
      {
        offer: yesNo(
          "Would tappable follow-up suggestions genuinely help the user after this reply?",
          "Yes: there are natural next steps the user is likely to want.",
          "No: the reply is complete, or it already asks the user something."
        ),
        next: {
          type: "choice",
          instructions: "Which next step is the user most likely to want?",
          criteria: Object.fromEntries(candidates.map((c) => [c, c])),
        },
      },
      1500
    );
    const offer = noulOf(res?.answers.offer);
    const next = choiceOf(res?.answers.next);
    if (offer === null || !next)
      return heuristicDecisions.followUps({ message, reply, candidates });
    if (offer <= 0.5) return jevD([], noulConfidence(offer));
    const ranked = Object.entries(next.probabilities)
      .sort((x, y) => y[1] - x[1])
      .filter(([, prob]) => prob >= 0.1)
      .map(([label]) => label)
      .slice(0, 3);
    return jevD(ranked, noulConfidence(offer));
  },

  async turnTaking(i) {
    const res = await jevDecide(
      { transcript: i.transcript.slice(-1000), silence_ms: i.silenceMs },
      {
        turn: {
          type: "choice",
          instructions: "In hands-free voice mode, what should the assistant do now?",
          criteria: {
            continue: "The user is mid-thought; keep listening.",
            end: "The user finished their turn; send it.",
            interrupt: "The user wants the assistant to stop talking or cancel.",
          },
        },
      },
      800
    );
    const c = choiceOf(res?.answers.turn);
    return c && usable(c.confidence)
      ? jevD(c.choice as TurnTaking, c.confidence)
      : heuristicDecisions.turnTaking(i);
  },
};

export function decisionProvider(): DecisionProvider {
  return jevEnabled() ? jevDecisions : heuristicDecisions;
}

/** Text-only "remember" detection used to decide whether the write gate should run at all. */
export function mightBeMemory(text: string): boolean {
  return EXPLICIT_MEMORY.test(text) || IMPLICIT_MEMORY.test(text);
}

export function maskPii(text: string): string {
  return heuristicDecisions.pii(text).choice.masked;
}
