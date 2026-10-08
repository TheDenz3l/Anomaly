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
  /** Photo URLs the reply's searches and reads returned; the app loads these without a tap. */
  images: v.optional(v.array(v.string())),
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

/** A file the user attached; its text is read on the server (convex/files.ts) and given to the model. */
export const vFilePart = v.object({
  id: v.string(),
  type: v.literal("file"),
  storageId: v.optional(v.id("_storage")),
  uri: v.optional(v.string()),
  name: v.string(),
  mime: v.string(),
  size: v.number(),
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
  vFilePart,
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
  /** report: a Deep Research report; subagents: the answer to an approved sub-agent plan. */
  kind: v.optional(v.union(v.literal("report"), v.literal("subagents"))),
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

/** A provider key's balance as last reported; status "unsupported" means the provider has no balance API. */
export const vProviderBalance = v.object({
  status: v.union(v.literal("ok"), v.literal("unsupported"), v.literal("error")),
  remaining: v.optional(v.number()),
  total: v.optional(v.number()),
  used: v.optional(v.number()),
  currency: v.optional(v.string()),
  error: v.optional(v.string()),
  checkedAt: v.number(),
});

/** A provider signed in with a subscription instead of a key: the refresh side of its tokens. */
export const vProviderAuth = v.object({
  type: v.literal("chatgpt"),
  refreshCipher: v.string(),
  expiresAt: v.number(),
  accountId: v.string(),
  email: v.optional(v.string()),
  plan: v.optional(v.string()),
});

/** A subscription's usage windows (5-hour, weekly) as last read. */
export const vProviderLimits = v.object({
  plan: v.optional(v.string()),
  windows: v.array(
    v.object({
      id: v.string(),
      label: v.string(),
      usedPercent: v.number(),
      resetsAt: v.optional(v.number()),
      windowMinutes: v.optional(v.number()),
    })
  ),
  checkedAt: v.number(),
  error: v.optional(v.string()),
});

/** What replies sent from the app spent through one provider in a calendar month (UTC). */
export const vProviderUsage = v.object({
  month: v.string(),
  costUsd: v.number(),
  /** Replies on models with no published price, so costUsd leaves them out. */
  unpriced: v.number(),
  promptTokens: v.number(),
  completionTokens: v.number(),
  replies: v.number(),
  /**
   * How far the provider's balance fell this month, summed read to read (top-ups ignored). The
   * spend for endpoints that publish no prices; it counts use of the key outside this app too.
   */
  balanceSpent: v.optional(v.number()),
});

export const vLocation = v.object({ lat: v.number(), lng: v.number(), label: v.string() });

export type Source = Infer<typeof vSource>;
export type SourceOrigin = Infer<typeof vSourceOrigin>;
export type Part = Infer<typeof vPart>;
export type TextPart = Infer<typeof vTextPart>;
export type ThinkingPart = Infer<typeof vThinkingPart>;
export type SearchPart = Infer<typeof vSearchPart>;
export type ComponentPart = Infer<typeof vComponentPart>;
export type ImagePart = Infer<typeof vImagePart>;
export type FilePart = Infer<typeof vFilePart>;
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
