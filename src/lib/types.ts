export type Role = "user" | "assistant";

export type SourceOrigin = "native" | "app" | "subagent";

export type Source = {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  snippet: string;
  origin: SourceOrigin;
};

export type ComponentStatus = "streaming" | "ready" | "invalid";

export type TextPart = { id: string; type: "text"; text: string };
export type ThinkingPart = {
  id: string;
  type: "thinking";
  text: string;
  done: boolean;
  durationMs?: number;
};
export type ComponentPart = {
  id: string;
  type: "component";
  name: string;
  props: unknown;
  status: ComponentStatus;
  fallbackText: string;
  error?: string;
};
export type ImagePart = {
  id: string;
  type: "image";
  uri: string;
  width?: number;
  height?: number;
  description?: string;
  describedBy?: string;
};
/** A file the user attached; `uri` is the local copy while sending, then the stored file. */
export type FilePart = {
  id: string;
  type: "file";
  name: string;
  mime: string;
  size: number;
  uri?: string;
};
export type SourcesPart = { id: string; type: "sources"; sources: Source[] };
export type UiEventPart = {
  id: string;
  type: "ui_event";
  componentId: string;
  component: string;
  action: string;
  label: string;
  payload?: Record<string, unknown>;
};

/** A web search step: the queries it ran and the pages it found, shown inline before the answer. */
export type SearchPart = {
  id: string;
  type: "search";
  queries: string[];
  sources: Source[];
  phase: "searching" | "reading" | "done";
  durationMs?: number;
  /** Photo URLs the reply's searches and reads returned; these load without a tap. */
  images?: string[];
};

export type Part =
  | TextPart
  | ThinkingPart
  | SearchPart
  | ComponentPart
  | ImagePart
  | FilePart
  | SourcesPart
  | UiEventPart;

export type ReplyMeta = {
  modelRef: string;
  levelRequested: string;
  levelSent: string;
  reasoningTokens: number;
  kind?: "report";
  /** The model that read the photos because the reply's model can't see images. */
  visionModelRef?: string;
  /** The reply's model can't see images and no other model could read the photos. */
  visionSkipped?: boolean;
};

export type MessageStatus = "streaming" | "done" | "stopped" | "error";

export type Message = {
  id: string;
  /** Stable React key: the optimistic id this message replaced, so it never remounts mid-reply. */
  key?: string;
  threadId: string;
  role: Role;
  parts: Part[];
  createdAt: number;
  status: MessageStatus;
  meta?: ReplyMeta;
};

export type ThreadMode = "chat" | "research";

export type Thread = {
  id: string;
  /** Client-only: the optimistic id a new chat started with, kept as a stable React key. */
  key?: string;
  title: string;
  modelRef: string;
  mode: ThreadMode;
  reasoningLevel: string;
  incognito: boolean;
  createdAt: number;
  updatedAt: number;
  /** Latest user prompt (server-provided) for History rows. */
  preview?: string;
  /** Set while the chat is pinned to the top of Recents. */
  pinnedAt?: number;
};

export type ReasoningStyle = "effort" | "budget" | "toggle" | "none";

export type CapabilityProfile = {
  reasoning: {
    style: ReasoningStyle;
    field?: string;
    levels: string[];
    budgets?: Record<string, number>;
    noop?: boolean;
    defaultLevel: string;
  };
  features: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    reasoningText: boolean;
    audio: boolean;
    webSearch: boolean;
  };
  confidence: number;
  source: "registry" | "probe" | "learned" | "manual";
  lastVerified: number;
  version: number;
};

export type Model = {
  id: string;
  name: string;
  providerId: string;
  contextWindow: number;
  profile: CapabilityProfile;
  /** USD per token, when the provider publishes it. */
  pricing?: { prompt: number; completion: number };
};

export type ProviderStatus = "connected" | "error" | "checking";

/** A provider key's balance as last reported; "unsupported" means the provider has no balance API. */
export type ProviderBalance = {
  status: "ok" | "unsupported" | "error";
  remaining?: number;
  total?: number;
  used?: number;
  currency?: string;
  error?: string;
  checkedAt: number;
};

/** What replies sent from the app spent through a provider this month (UTC). */
export type ProviderUsage = {
  month: string;
  costUsd: number;
  /** Replies on models with no published price, left out of costUsd. */
  unpriced: number;
  promptTokens: number;
  completionTokens: number;
  replies: number;
  /** How far the balance fell this month (all use of the key, not just this app). */
  balanceSpent?: number;
};

/** A subscription's usage window: the rolling 5-hour limit or the weekly one. */
export type LimitWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: number;
  windowMinutes?: number;
};

export type ProviderLimits = {
  plan?: string;
  windows: LimitWindow[];
  checkedAt: number;
  error?: string;
};

export type Provider = {
  providerId: string;
  label: string;
  baseUrl: string;
  keyHint: string;
  headers: { key: string; value: string }[];
  status: ProviderStatus;
  lastError?: string;
  balance?: ProviderBalance;
  usage?: ProviderUsage;
  /** Set when the provider is a signed-in plan rather than a key. */
  subscription?: { vendor: "chatgpt"; email?: string; plan?: string };
  limits?: ProviderLimits;
};

export type MemoryCategory = "preference" | "fact" | "person" | "place" | "work";

export type Memory = {
  id: string;
  text: string;
  category: MemoryCategory;
  scope: "global" | "thread";
  threadId?: string;
  confidence: number;
  createdAt: number;
};

export type SubagentMode = "off" | "auto" | "offer";
export type WebMode = "auto" | "native" | "app";

export type Settings = {
  customInstructions: string;
  memoryEnabled: boolean;
  subagentMode: SubagentMode;
  webMode: WebMode;
  searchProvider: "none" | "brave" | "tavily" | "searxng";
  searchKeyHint: string;
  voiceInput: "device" | "endpoint";
  voiceOutput: "device" | "endpoint";
  readRepliesAloud: boolean;
  probeSpendCapUsd: number;
  defaultModelRef: string;
  researchModelRef: string | null;
  /** The thinking level picked last; every chat uses it until another is picked. */
  thinkingLevel: string;
  /** The user's own image model; the key stays on the server. */
  imageGen?: ImageGenSetup | null;
};

export type ImageFlavor = "openai" | "chat" | "nanobanana";

/** What's left on an image key: money, or the service's own credits (Nano Banana's bananas). */
export type ImageBalance = {
  remaining?: number;
  total?: number;
  used?: number;
  unit: string;
  money: boolean;
};

export type ImageGenSetup = {
  baseUrl: string;
  model: string;
  keyHint: string;
  hasKey: boolean;
  flavor: ImageFlavor | null;
  /** As last read; `peak` is the most the key held since its last top-up. */
  balance:
    | (ImageBalance & {
        status: "ok" | "unsupported" | "error";
        peak?: number;
        error?: string;
        checkedAt: number;
      })
    | null;
  usage: { month: string; images: number; spent: number } | null;
  timing: { model: string; avgMs: number; n: number } | null;
};

export type ImageModelOption = { id: string; name: string; note?: string };

/** What probing an image endpoint found: where to call it, how, and the models the key can use. */
export type ImageProbe = {
  baseUrl: string;
  flavor: ImageFlavor;
  models: ImageModelOption[];
  balance?: ImageBalance;
};
