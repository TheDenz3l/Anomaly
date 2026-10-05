import type { CapabilityProfile, ProfileParams } from "../lib/validators";

/**
 * Capability registry (PRD §3.5 step 1): fingerprints host + model id + /models metadata into a
 * starting profile. Probes and live traffic refine it; manual overrides always win.
 * A remote JSON (REGISTRY_URL) can patch these rules without a deploy — see applyRemoteRules.
 */

export const REGISTRY_VERSION = 1;

type Partial2 = {
  reasoning?: Partial<CapabilityProfile["reasoning"]>;
  features?: Partial<CapabilityProfile["features"]>;
  params?: ProfileParams;
  confidence?: number;
};

export type RemoteRule = Partial2 & { host?: string; model: string };

export type ModelKind = "chat" | "embedding" | "audio" | "image" | "other";

const EFFORT_3 = ["low", "medium", "high"];
const BUDGETS = { low: 2048, medium: 8192, high: 24576 };

function base(): CapabilityProfile {
  return {
    reasoning: { style: "none", levels: [], defaultLevel: "off" },
    features: {
      vision: false,
      tools: true,
      streaming: true,
      reasoningText: false,
      audio: false,
      webSearch: false,
    },
    params: {},
    confidence: 0.4,
    source: "registry",
    lastVerified: Date.now(),
    version: REGISTRY_VERSION,
  };
}

function merge(p: CapabilityProfile, patch: Partial2): CapabilityProfile {
  return {
    ...p,
    reasoning: { ...p.reasoning, ...(patch.reasoning ?? {}) } as CapabilityProfile["reasoning"],
    features: { ...p.features, ...(patch.features ?? {}) },
    params: { ...(p.params ?? {}), ...(patch.params ?? {}) },
    confidence: patch.confidence ?? p.confidence,
  };
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

export function isLocalHost(host: string): boolean {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])|:(1234|11434|8080|5000)$/.test(
    host
  );
}

export function modelKind(id: string, meta?: any): ModelKind {
  const m = id.toLowerCase();
  const outputs: string[] | undefined = meta?.architecture?.output_modalities;
  if (outputs && outputs.length && !outputs.includes("text"))
    return outputs.includes("image") ? "image" : "other";
  if (/embed|embedding|bge-|e5-|gte-|nomic-embed/.test(m)) return "embedding";
  if (/whisper|tts|transcribe|speech|audio-preview|realtime/.test(m)) return "audio";
  if (/dall-e|gpt-image|stable-diffusion|sdxl|flux|imagen/.test(m)) return "image";
  if (/moderation|davinci|babbage|curie|ada-0|search-document|rerank/.test(m)) return "other";
  return "chat";
}

export function contextWindowOf(id: string, meta?: any): number {
  const n = Number(
    meta?.context_length ??
      meta?.context_window ??
      meta?.max_context_length ??
      meta?.top_provider?.context_length
  );
  if (Number.isFinite(n) && n > 0) return n;
  const m = id.toLowerCase();
  if (/gpt-5|gpt-4\.1/.test(m)) return m.includes("4.1") ? 1_047_576 : 400_000;
  if (/o[134]/.test(m) || /gpt-4o/.test(m)) return 128_000;
  if (/claude/.test(m)) return 200_000;
  if (/gemini/.test(m)) return 1_048_576;
  if (/llama-4/.test(m)) return 1_000_000;
  return 32_768;
}

export function displayName(id: string, meta?: any): string {
  if (typeof meta?.name === "string" && meta.name) return meta.name.replace(/^[^:]+:\s*/, "");
  const last = id.split("/").pop() ?? id;
  return last
    .replace(/[-_]/g, " ")
    .replace(/\b(gpt|ai|vl|r1)\b/gi, (s) => s.toUpperCase())
    .replace(/\b([a-z])/g, (s) => s.toUpperCase());
}

export function pricingOf(meta?: any): { prompt: number; completion: number } | undefined {
  const p = Number(meta?.pricing?.prompt);
  const c = Number(meta?.pricing?.completion);
  if (Number.isFinite(p) && Number.isFinite(c) && (p > 0 || c > 0))
    return { prompt: p, completion: c };
  return undefined;
}

function openRouterProfile(id: string, meta: any): CapabilityProfile {
  const m = id.toLowerCase();
  const params: string[] = Array.isArray(meta?.supported_parameters)
    ? meta.supported_parameters
    : [];
  const inputs: string[] = Array.isArray(meta?.architecture?.input_modalities)
    ? meta.architecture.input_modalities
    : [];
  const hasMeta = Boolean(meta);
  const reasons = params.includes("reasoning") || params.includes("include_reasoning");
  let p = merge(base(), {
    features: {
      vision: hasMeta
        ? inputs.includes("image")
        : /vision|claude|gpt-4o|gpt-5|gemini|llama-4|pixtral|vl\b/.test(m),
      tools: hasMeta ? params.includes("tools") : true,
      audio: inputs.includes("audio"),
      // Only models that search on their own; OpenRouter's paid web plugin isn't used by default.
      webSearch: /^perplexity\/|search-preview|:online$/.test(m),
    },
    params: /search-preview/.test(m) ? { nativeSearch: "openai_options" } : {},
    confidence: hasMeta ? 0.9 : 0.7,
  });
  if (
    reasons ||
    (!hasMeta &&
      /claude-(3\.7|sonnet-4|opus-4|haiku-4)|gemini-2\.5|o[134]|gpt-5|r1|qwen3|grok/.test(m))
  ) {
    if (/^(anthropic|google)\/|qwen3|gemini/.test(m)) {
      p = merge(p, {
        reasoning: {
          style: "budget",
          field: "reasoning.max_tokens",
          levels: EFFORT_3,
          budgets: BUDGETS,
          defaultLevel: "medium",
        },
        features: { reasoningText: true },
      });
    } else if (/deepseek.*r1|deepseek-reasoner/.test(m)) {
      p = merge(p, {
        reasoning: {
          style: "toggle",
          field: "reasoning.enabled",
          levels: ["on"],
          defaultLevel: "on",
        },
        features: { reasoningText: true },
      });
    } else {
      const levels = /gpt-5/.test(m) ? ["minimal", ...EFFORT_3] : EFFORT_3;
      p = merge(p, {
        reasoning: { style: "effort", field: "reasoning.effort", levels, defaultLevel: "medium" },
        features: { reasoningText: !/^openai\//.test(m) },
      });
    }
  }
  if (m === "openrouter/auto") {
    // Auto-router picks the model and effort per request; "auto" sends no reasoning field.
    p = merge(p, { params: { autoLevel: true } });
  }
  return p;
}

function openAiProfile(id: string): CapabilityProfile {
  const m = id.toLowerCase();
  let p = merge(base(), { confidence: 0.6 });
  if (/^(o1|o3|o4)/.test(m)) {
    p = merge(p, {
      reasoning: {
        style: "effort",
        field: "reasoning_effort",
        levels: EFFORT_3,
        defaultLevel: "medium",
      },
      features: { vision: !/^(o1-mini|o3-mini)/.test(m), tools: !/^o1-mini/.test(m) },
      params: { maxTokensField: "max_completion_tokens" },
      confidence: 0.92,
    });
  } else if (/^gpt-5/.test(m)) {
    const chat = /chat/.test(m);
    p = merge(p, {
      reasoning: chat
        ? { style: "none", levels: [], defaultLevel: "off" }
        : {
            style: "effort",
            field: "reasoning_effort",
            levels: ["minimal", ...EFFORT_3],
            defaultLevel: "medium",
          },
      features: { vision: true },
      params: { maxTokensField: "max_completion_tokens" },
      confidence: 0.92,
    });
  } else if (/^(gpt-4o|gpt-4\.1|chatgpt-4o|gpt-4-turbo)/.test(m)) {
    p = merge(p, { features: { vision: true }, confidence: 0.92 });
  }
  if (/search/.test(m)) {
    p = merge(p, {
      features: { webSearch: true, tools: false },
      params: { nativeSearch: "openai_options" },
    });
  }
  if (/audio/.test(m)) p = merge(p, { features: { audio: true } });
  return p;
}

function anthropicProfile(id: string): CapabilityProfile {
  const m = id.toLowerCase();
  const thinks = /claude-(3-7|sonnet-4|opus-4|haiku-4)/.test(m);
  return merge(base(), {
    reasoning: thinks
      ? {
          style: "budget",
          field: "thinking.budget_tokens",
          levels: EFFORT_3,
          budgets: BUDGETS,
          defaultLevel: "medium",
        }
      : undefined,
    features: { vision: true, reasoningText: thinks },
    params: { maxTokensField: "max_tokens" },
    confidence: 0.85,
  });
}

function genericByName(id: string, local: boolean): CapabilityProfile {
  const m = id.toLowerCase();
  let p = merge(base(), { confidence: local ? 0.5 : 0.4 });
  if (/qwen3|qwq|deepseek-r1|r1-distill|think|magistral|phi-4-reasoning|gpt-oss/.test(m)) {
    p = merge(p, {
      reasoning:
        local || !/gpt-oss/.test(m)
          ? { style: "toggle", field: "<think> tags", levels: ["on"], defaultLevel: "on" }
          : {
              style: "effort",
              field: "reasoning_effort",
              levels: EFFORT_3,
              defaultLevel: "medium",
            },
      features: { reasoningText: true },
      confidence: 0.6,
    });
  }
  if (
    /vision|llava|-vl\b|vl-|gemma-?3|pixtral|llama-?3\.2-?\d+b-?vision|llama-4|minicpm-v|moondream/.test(
      m
    )
  ) {
    p = merge(p, { features: { vision: true } });
  }
  return p;
}

export function registryProfile(baseUrl: string, modelId: string, meta?: any): CapabilityProfile {
  const host = hostOf(baseUrl);
  const m = modelId.toLowerCase();
  if (host.endsWith("openrouter.ai")) return openRouterProfile(modelId, meta);
  if (host === "api.openai.com") return openAiProfile(modelId);
  if (host === "api.anthropic.com") return anthropicProfile(modelId);
  if (host === "api.deepseek.com") {
    return merge(base(), {
      features: { reasoningText: m.includes("reasoner") },
      confidence: 0.85,
    });
  }
  if (host === "generativelanguage.googleapis.com") {
    const thinks = /gemini-2\.5|gemini-3/.test(m);
    return merge(base(), {
      reasoning: thinks
        ? {
            style: "effort",
            field: "reasoning_effort",
            levels: m.includes("flash") ? ["none", ...EFFORT_3] : EFFORT_3,
            defaultLevel: "medium",
          }
        : undefined,
      features: { vision: true },
      params: { streamUsage: true },
      confidence: 0.8,
    });
  }
  if (host === "api.x.ai") {
    return merge(base(), {
      reasoning: /grok-3-mini/.test(m)
        ? {
            style: "effort",
            field: "reasoning_effort",
            levels: ["low", "high"],
            defaultLevel: "low",
          }
        : undefined,
      features: { vision: /vision|grok-4/.test(m), reasoningText: /grok-3-mini/.test(m) },
      confidence: 0.8,
    });
  }
  if (host === "api.groq.com") {
    if (/gpt-oss/.test(m)) {
      return merge(base(), {
        reasoning: {
          style: "effort",
          field: "reasoning_effort",
          levels: EFFORT_3,
          defaultLevel: "medium",
        },
        features: { reasoningText: true },
        confidence: 0.8,
      });
    }
    return merge(genericByName(modelId, false), { confidence: 0.7 });
  }
  if (host === "api.mistral.ai") {
    return merge(base(), {
      features: { vision: /pixtral|medium|small-3/.test(m), reasoningText: /magistral/.test(m) },
      confidence: 0.75,
    });
  }
  return genericByName(modelId, isLocalHost(host));
}

export function applyRemoteRules(
  profile: CapabilityProfile,
  baseUrl: string,
  modelId: string,
  rules: RemoteRule[]
): CapabilityProfile {
  const host = hostOf(baseUrl);
  let p = profile;
  for (const rule of rules) {
    if (rule.host && rule.host.toLowerCase() !== host) continue;
    try {
      if (!new RegExp(rule.model, "i").test(modelId)) continue;
    } catch {
      continue;
    }
    p = merge(p, rule);
  }
  return p;
}
