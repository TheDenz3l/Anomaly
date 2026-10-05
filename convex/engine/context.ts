import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { decisionProvider, maskPii, type Decision, type DecisionProvider } from "../ai/decisions";
import type { Endpoint } from "../ai/openai";
import { decryptSecret } from "../lib/crypto";
import type { SettingsFields } from "../lib/settings";
import type { CapabilityProfile } from "../lib/validators";
import { webCache, type WebCache } from "../web/cache";
import type { SearchConfig } from "../web/providers";

export type LearnEvent =
  | { kind: "param_rejected"; param: string }
  | { kind: "reasoning_tokens"; levelSent: string; tokens: number; reported: boolean }
  | { kind: "reasoning_text_seen" }
  | { kind: "success" }
  | { kind: "max_tokens_field"; field: "max_tokens" | "max_completion_tokens" };

export type DecisionRecord = {
  kind: string;
  input: unknown;
  output: unknown;
  confidence: number;
  provider: string;
  refId?: string;
};

/** Everything one model call needs; cheap to fork for another model (sub-agents, research tiers). */
export type Engine = {
  ctx: ActionCtx;
  userId: Id<"users">;
  thread: Doc<"threads">;
  settings: SettingsFields;
  endpoint: Endpoint;
  providerId: string;
  modelId: string;
  modelRef: string;
  contextWindow: number;
  pricing?: { prompt: number; completion: number };
  profile: CapabilityProfile;
  cache: WebCache;
  search: SearchConfig;
  dp: DecisionProvider;
  decisions: DecisionRecord[];
  learn: Map<string, LearnEvent[]>;
  /** Jev moderation/PII flags for this turn; inputs are masked or redacted before logging. */
  safety: string[];
};

export async function modelEngine(
  ctx: ActionCtx,
  base: {
    userId: Id<"users">;
    thread: Doc<"threads">;
    settings: SettingsFields;
    search?: SearchConfig;
    decisions?: DecisionRecord[];
    learn?: Map<string, LearnEvent[]>;
  },
  ref: string
): Promise<Engine> {
  const m = await ctx.runQuery(internal.engine.data.modelContext, { userId: base.userId, ref });
  if (!m) {
    throw new ConvexError(
      `The model "${ref}" isn't available. Pick another model, or re-add its provider in Settings.`
    );
  }
  const endpoint: Endpoint = {
    baseUrl: m.baseUrl,
    apiKey: m.keyCipher ? await decryptSecret(m.keyCipher) : undefined,
    headers: m.headersCipher ? JSON.parse(await decryptSecret(m.headersCipher)) : [],
  };
  let search = base.search;
  if (!search) {
    const s = base.settings;
    search = {
      provider: s.searchProvider,
      key: s.searchKeyCipher ? await decryptSecret(s.searchKeyCipher) : undefined,
      url: s.searchUrl,
    };
  }
  return {
    ctx,
    userId: base.userId,
    thread: base.thread,
    settings: base.settings,
    endpoint,
    providerId: m.providerId,
    modelId: m.modelId,
    modelRef: ref,
    contextWindow: m.contextWindow,
    pricing: m.pricing,
    profile: m.profile,
    cache: webCache(ctx),
    search,
    dp: decisionProvider(),
    decisions: base.decisions ?? [],
    learn: base.learn ?? new Map(),
    safety: [],
  };
}

/** Same user/thread/search config, different model — shares the decision log and learning buffer. */
export async function forkEngine(engine: Engine, ref: string | null | undefined): Promise<Engine> {
  if (!ref || ref === engine.modelRef) return engine;
  try {
    return await modelEngine(engine.ctx, engine, ref);
  } catch {
    return engine;
  }
}

export function note<T>(
  engine: Engine,
  kind: string,
  input: unknown,
  d: Decision<T>,
  refId?: string
): T {
  engine.decisions.push({
    kind,
    input:
      typeof input === "string"
        ? engine.safety.includes("pii_sensitive") || engine.safety.includes("credentials")
          ? "[redacted: sensitive]"
          : maskPii(input).slice(0, 500)
        : input,
    output: d.choice as unknown,
    confidence: d.confidence,
    provider: d.provider,
    refId,
  });
  return d.choice;
}

export function learn(engine: Engine, ev: LearnEvent): void {
  const key = `${engine.providerId}\u0000${engine.modelId}`;
  const list = engine.learn.get(key) ?? [];
  list.push(ev);
  engine.learn.set(key, list);
}

/** Persists decisions and learning events gathered during a turn in as few calls as possible. */
export async function flushRecords(engine: Engine, refId?: string): Promise<void> {
  const { ctx } = engine;
  const jobs: Promise<unknown>[] = [];
  if (engine.decisions.length) {
    const items = engine.decisions.splice(0).map((d) => ({
      ...d,
      input: sanitizeLog(d.input),
      output: sanitizeLog(d.output),
    }));
    jobs.push(
      ctx.runMutation(internal.decisionLog.recordMany, { userId: engine.userId, refId, items })
    );
  }
  for (const [key, events] of engine.learn) {
    const [providerId, modelId] = key.split("\u0000");
    if (events.length) {
      jobs.push(
        ctx.runMutation(internal.models.learn, {
          userId: engine.userId,
          providerId,
          modelId,
          events,
        })
      );
    }
  }
  engine.learn.clear();
  await Promise.allSettled(jobs);
}

function sanitizeLog(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return null;
  }
}

export function estimateCost(
  engine: Engine,
  promptTokens: number,
  completionTokens: number
): number | undefined {
  if (!engine.pricing) return undefined;
  return promptTokens * engine.pricing.prompt + completionTokens * engine.pricing.completion;
}
