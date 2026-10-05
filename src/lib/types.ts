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
export type ImagePart = { id: string; type: "image"; uri: string; width?: number; height?: number };
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

export type Part = TextPart | ThinkingPart | ComponentPart | ImagePart | SourcesPart | UiEventPart;

export type ReplyMeta = {
  modelRef: string;
  levelRequested: string;
  levelSent: string;
  reasoningTokens: number;
  kind?: "report";
};

export type MessageStatus = "streaming" | "done" | "stopped" | "error";

export type Message = {
  id: string;
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
  title: string;
  modelRef: string;
  mode: ThreadMode;
  reasoningLevel: string;
  incognito: boolean;
  createdAt: number;
  updatedAt: number;
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
};

export type ProviderStatus = "connected" | "error" | "checking";

export type Provider = {
  providerId: string;
  label: string;
  baseUrl: string;
  keyHint: string;
  headers: { key: string; value: string }[];
  status: ProviderStatus;
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
};
