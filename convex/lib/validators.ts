import { v, type Infer } from "convex/values";

/** Shared value shapes. Mirrors src/lib/types.ts so the client renders server parts unchanged. */

export const vRole = v.union(v.literal("user"), v.literal("assistant"));

export const vSourceOrigin = v.union(v.literal("native"), v.literal("app"), v.literal("subagent"));

export const vSource = v.object({
  id: v.string(),
  url: v.string(),
  title: v.string(),
  favicon: v.optional(v.string()),
  snippet: v.string(),
  origin: vSourceOrigin,
});

export const vComponentStatus = v.union(
  v.literal("streaming"),
  v.literal("ready"),
  v.literal("invalid")
);

export const vTextPart = v.object({ id: v.string(), type: v.literal("text"), text: v.string() });

export const vThinkingPart = v.object({
  id: v.string(),
  type: v.literal("thinking"),
  text: v.string(),
  done: v.boolean(),
  durationMs: v.optional(v.number()),
});

export const vSearchPart = v.object({
  id: v.string(),
  type: v.literal("search"),
  queries: v.array(v.string()),
  sources: v.array(vSource),
  phase: v.union(v.literal("searching"), v.literal("reading"), v.literal("done")),
  durationMs: v.optional(v.number()),
});

export const vComponentPart = v.object({
  id: v.string(),
  type: v.literal("component"),
  name: v.string(),
  props: v.any(),
  status: vComponentStatus,
  fallbackText: v.string(),
  error: v.optional(v.string()),
});

export const vImagePart = v.object({
  id: v.string(),
  type: v.literal("image"),
  uri: v.optional(v.string()),
  storageId: v.optional(v.id("_storage")),
  mime: v.optional(v.string()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
});

export const vSourcesPart = v.object({
  id: v.string(),
  type: v.literal("sources"),
  sources: v.array(vSource),
});

export const vUiEventPart = v.object({
  id: v.string(),
  type: v.literal("ui_event"),
  componentId: v.string(),
  component: v.string(),
  action: v.string(),
  label: v.string(),
  payload: v.optional(v.any()),
});

export const vPart = v.union(
  vTextPart,
  vThinkingPart,
  vSearchPart,
  vComponentPart,
  vImagePart,
  vSourcesPart,
  vUiEventPart
);

export const vMessageStatus = v.union(
  v.literal("streaming"),
  v.literal("done"),
  v.literal("stopped"),
  v.literal("error")
);

export const vReplyMeta = v.object({
  modelRef: v.string(),
  levelRequested: v.string(),
  levelSent: v.string(),
  reasoningTokens: v.number(),
  kind: v.optional(v.literal("report")),
  promptTokens: v.optional(v.number()),
  completionTokens: v.optional(v.number()),
  costUsd: v.optional(v.number()),
});

export const vThreadMode = v.union(v.literal("chat"), v.literal("research"));

export const vReasoningStyle = v.union(
  v.literal("effort"),
  v.literal("budget"),
  v.literal("toggle"),
  v.literal("none")
);

export const vReasoning = v.object({
  style: vReasoningStyle,
  field: v.optional(v.string()),
  levels: v.array(v.string()),
  budgets: v.optional(v.record(v.string(), v.number())),
  noop: v.optional(v.boolean()),
  defaultLevel: v.string(),
});

export const vFeatures = v.object({
  vision: v.boolean(),
  tools: v.boolean(),
  streaming: v.boolean(),
  reasoningText: v.boolean(),
  audio: v.boolean(),
  webSearch: v.boolean(),
});

/** Request-shape quirks learned per endpoint; not part of the client-facing profile. */
export const vParams = v.object({
  maxTokensField: v.optional(v.union(v.literal("max_tokens"), v.literal("max_completion_tokens"))),
  streamUsage: v.optional(v.boolean()),
  nativeSearch: v.optional(v.union(v.literal("openrouter"), v.literal("openai_options"))),
  /** Router endpoints (Jev Router, openrouter/auto) pick reasoning effort themselves on "auto". */
  autoLevel: v.optional(v.boolean()),
});

export const vProfileSource = v.union(
  v.literal("registry"),
  v.literal("probe"),
  v.literal("learned"),
  v.literal("manual")
);

export const vProfile = v.object({
  reasoning: vReasoning,
  features: vFeatures,
  params: v.optional(vParams),
  confidence: v.number(),
  source: vProfileSource,
  lastVerified: v.number(),
  version: v.number(),
});

export const vSubagentMode = v.union(v.literal("off"), v.literal("auto"), v.literal("offer"));
export const vWebMode = v.union(v.literal("auto"), v.literal("native"), v.literal("app"));
export const vSearchProvider = v.union(
  v.literal("none"),
  v.literal("firecrawl"),
  v.literal("brave"),
  v.literal("tavily"),
  v.literal("searxng")
);
export const vVoiceMode = v.union(v.literal("device"), v.literal("endpoint"));

export const vMemoryCategory = v.union(
  v.literal("preference"),
  v.literal("fact"),
  v.literal("person"),
  v.literal("place"),
  v.literal("work")
);
export const vMemoryScope = v.union(v.literal("global"), v.literal("thread"));

export const vAgentRole = v.union(
  v.literal("search"),
  v.literal("reader"),
  v.literal("maps"),
  v.literal("code"),
  v.literal("vision"),
  v.literal("memory-read"),
  v.literal("verifier")
);

export const vRoleModels = v.object({
  planner: v.union(v.string(), v.null()),
  worker: v.union(v.string(), v.null()),
  verifier: v.union(v.string(), v.null()),
  synthesizer: v.union(v.string(), v.null()),
});

export const vHeader = v.object({ key: v.string(), value: v.string() });

export const vLocation = v.object({ lat: v.number(), lng: v.number(), label: v.string() });

export type Source = Infer<typeof vSource>;
export type SourceOrigin = Infer<typeof vSourceOrigin>;
export type Part = Infer<typeof vPart>;
export type TextPart = Infer<typeof vTextPart>;
export type ThinkingPart = Infer<typeof vThinkingPart>;
export type SearchPart = Infer<typeof vSearchPart>;
export type ComponentPart = Infer<typeof vComponentPart>;
export type ImagePart = Infer<typeof vImagePart>;
export type UiEventPart = Infer<typeof vUiEventPart>;
export type MessageStatus = Infer<typeof vMessageStatus>;
export type ReplyMeta = Infer<typeof vReplyMeta>;
export type CapabilityProfile = Infer<typeof vProfile>;
export type ProfileParams = Infer<typeof vParams>;
export type ReasoningStyle = Infer<typeof vReasoningStyle>;
export type MemoryCategory = Infer<typeof vMemoryCategory>;
export type MemoryScope = Infer<typeof vMemoryScope>;
export type AgentRole = Infer<typeof vAgentRole>;
export type RoleModels = Infer<typeof vRoleModels>;
export type SubagentMode = Infer<typeof vSubagentMode>;
export type WebMode = Infer<typeof vWebMode>;
export type SearchProviderId = Infer<typeof vSearchProvider>;
export type GeoLocation = Infer<typeof vLocation>;
