import type { CapabilityProfile, Model, Provider } from "@/lib/types";

const DAY = 86_400_000;
const now = Date.now();

function profile(
  p: Partial<CapabilityProfile> & Pick<CapabilityProfile, "reasoning">
): CapabilityProfile {
  return {
    features: {
      vision: false,
      tools: true,
      streaming: true,
      reasoningText: false,
      audio: false,
      webSearch: false,
    },
    confidence: 0.9,
    source: "registry",
    lastVerified: now - 2 * DAY,
    version: 3,
    ...p,
  };
}

export const mockProviders: Provider[] = [
  {
    providerId: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-…4f2a",
    headers: [],
    status: "connected",
  },
  {
    providerId: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyHint: "sk-or-…91cd",
    headers: [{ key: "HTTP-Referer", value: "https://atlas.app" }],
    status: "connected",
  },
  {
    providerId: "lmstudio",
    label: "LM Studio (home)",
    baseUrl: "http://192.168.1.20:1234/v1",
    keyHint: "none",
    headers: [],
    status: "connected",
  },
];

export const mockModels: Model[] = [
  {
    id: "gpt-5",
    name: "GPT-5",
    providerId: "openai",
    contextWindow: 400_000,
    profile: profile({
      reasoning: {
        style: "effort",
        field: "reasoning_effort",
        levels: ["minimal", "low", "medium", "high"],
        defaultLevel: "medium",
      },
      features: {
        vision: true,
        tools: true,
        streaming: true,
        reasoningText: false,
        audio: false,
        webSearch: true,
      },
      confidence: 0.97,
    }),
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 mini",
    providerId: "openai",
    contextWindow: 400_000,
    profile: profile({
      reasoning: {
        style: "effort",
        field: "reasoning_effort",
        levels: ["minimal", "low", "medium", "high"],
        defaultLevel: "low",
      },
      features: {
        vision: true,
        tools: true,
        streaming: true,
        reasoningText: false,
        audio: false,
        webSearch: true,
      },
      confidence: 0.95,
    }),
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    providerId: "openrouter",
    contextWindow: 200_000,
    profile: profile({
      reasoning: {
        style: "budget",
        field: "reasoning.max_tokens",
        levels: ["low", "medium", "high"],
        budgets: { low: 2048, medium: 8192, high: 24576 },
        defaultLevel: "medium",
      },
      features: {
        vision: true,
        tools: true,
        streaming: true,
        reasoningText: true,
        audio: false,
        webSearch: true,
      },
      confidence: 0.93,
      source: "probe",
      lastVerified: now - 5 * DAY,
    }),
  },
  {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek R1",
    providerId: "openrouter",
    contextWindow: 128_000,
    profile: profile({
      reasoning: {
        style: "toggle",
        field: "reasoning.enabled",
        levels: ["on"],
        defaultLevel: "on",
      },
      features: {
        vision: false,
        tools: true,
        streaming: true,
        reasoningText: true,
        audio: false,
        webSearch: false,
      },
      confidence: 0.81,
      source: "learned",
      lastVerified: now - 1 * DAY,
    }),
  },
  {
    id: "meta-llama/llama-4-maverick",
    name: "Llama 4 Maverick",
    providerId: "openrouter",
    contextWindow: 1_000_000,
    profile: profile({
      reasoning: { style: "none", levels: [], defaultLevel: "off" },
      features: {
        vision: true,
        tools: true,
        streaming: true,
        reasoningText: false,
        audio: false,
        webSearch: false,
      },
      confidence: 0.88,
    }),
  },
  {
    id: "qwen3-30b-a3b",
    name: "Qwen3 30B A3B",
    providerId: "lmstudio",
    contextWindow: 32_768,
    profile: profile({
      reasoning: { style: "toggle", field: "<think> tags", levels: ["on"], defaultLevel: "on" },
      features: {
        vision: false,
        tools: false,
        streaming: true,
        reasoningText: true,
        audio: false,
        webSearch: false,
      },
      confidence: 0.72,
      source: "probe",
      lastVerified: now - 9 * DAY,
    }),
  },
];

export const DEFAULT_MODEL_REF = "openrouter/anthropic/claude-sonnet-4.5";

export function modelRef(model: Pick<Model, "providerId" | "id">): string {
  return `${model.providerId}/${model.id}`;
}
