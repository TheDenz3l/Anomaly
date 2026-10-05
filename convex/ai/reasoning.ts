import type { CapabilityProfile } from "../lib/validators";
import type { ChatMessage, ToolDef } from "./openai";

/** Request builder (PRD §3.5): maps the Thinking setting onto what this endpoint accepts. */

export type Difficulty = "easy" | "moderate" | "hard";

export const DEFAULT_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 24576,
  on: 8192,
};

export function resolveLevel(
  profile: CapabilityProfile,
  requested: string,
  difficulty: Difficulty
): { sent: string; budget?: number } {
  const { style, levels } = profile.reasoning;
  if (requested === "auto" && profile.params?.autoLevel) return { sent: "auto" };
  if (style === "none" || levels.length === 0) return { sent: "off" };
  if (requested === "off") {
    if (style === "effort") {
      if (levels.includes("none")) return { sent: "none" };
      return { sent: levels[0] };
    }
    return { sent: "off" };
  }
  let sent: string;
  const usable = levels.filter((l) => l !== "none");
  if (requested === "auto") {
    const idx =
      difficulty === "easy"
        ? 0
        : difficulty === "moderate"
          ? Math.floor((usable.length - 1) / 2)
          : usable.length - 1;
    sent = usable[Math.min(Math.max(idx, 0), usable.length - 1)] ?? profile.reasoning.defaultLevel;
  } else {
    sent = levels.includes(requested) ? requested : profile.reasoning.defaultLevel;
  }
  const budget =
    style === "budget"
      ? (profile.reasoning.budgets?.[sent] ?? DEFAULT_BUDGETS[sent] ?? 8192)
      : undefined;
  return { sent, budget };
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

export type BuiltRequest = {
  body: Record<string, unknown>;
  levelSent: string;
  budget?: number;
  /** Top-level keys this builder added for reasoning — dropped first when the endpoint rejects a param. */
  reasoningKeys: string[];
  /** Directive appended to the system prompt (Qwen-style /no_think). */
  systemSuffix?: string;
};

export function buildRequest(opts: {
  model: string;
  profile: CapabilityProfile;
  level: string;
  difficulty: Difficulty;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  extra?: Record<string, unknown>;
}): BuiltRequest {
  const { profile } = opts;
  const body: Record<string, unknown> = { model: opts.model, messages: opts.messages };
  if (opts.tools?.length) body.tools = opts.tools;
  if (profile.params?.streamUsage !== false) body.stream_options = { include_usage: true };
  const maxField = profile.params?.maxTokensField ?? "max_tokens";
  let maxTokens = opts.maxTokens;

  const { sent, budget } = resolveLevel(profile, opts.level, opts.difficulty);
  const field = profile.reasoning.field;
  const reasoningKeys: string[] = [];
  let systemSuffix: string | undefined;
  const mark = (path: string) => reasoningKeys.push(path.split(".")[0]);

  // "auto" on a router endpoint: send nothing and let it choose the effort.
  switch (sent === "auto" ? "none" : profile.reasoning.style) {
    case "effort": {
      const path = field && !field.includes(" ") ? field : "reasoning_effort";
      setPath(body, path, sent);
      mark(path);
      break;
    }
    case "budget": {
      if (sent === "off") break;
      const b = budget ?? 8192;
      if (field === "thinking.budget_tokens" || field === "extra_body.thinking") {
        body.thinking = { type: "enabled", budget_tokens: b };
        mark("thinking");
      } else {
        const path = field && !field.includes(" ") ? field : "reasoning.max_tokens";
        setPath(body, path, b);
        mark(path);
      }
      maxTokens = Math.max(maxTokens ?? 0, b + 4096);
      break;
    }
    case "toggle": {
      const on = sent !== "off";
      if (!field || field.includes("<think>")) {
        if (!on) systemSuffix = "/no_think";
      } else if (field === "thinking.type") {
        body.thinking = { type: on ? "enabled" : "disabled" };
        mark("thinking");
      } else {
        setPath(body, field, on);
        mark(field);
      }
      break;
    }
    case "none":
      break;
  }
  if (maxTokens) body[maxField] = maxTokens;
  Object.assign(body, opts.extra ?? {});
  return { body, levelSent: sent, budget, reasoningKeys, systemSuffix };
}
