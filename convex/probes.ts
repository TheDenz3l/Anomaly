import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { decisionProvider, heuristicDecisions, type ProbeName } from "./ai/decisions";
import { complete, LlmError, type Completion, type Endpoint } from "./ai/openai";
import { registryProfile } from "./ai/registry";
import { optionalUser, requireUser } from "./lib/auth";
import { endpointFor } from "./lib/endpoint";
import { errorMessage, parseModelRef } from "./lib/util";
import type { CapabilityProfile } from "./lib/validators";

/**
 * Lazy, user-confirmed capability probes (PRD §3.5 step 2). Tiny max_tokens, no user data,
 * every request logged, total spend capped per user.
 */

const ALL: ProbeName[] = [
  "basic",
  "effort_flat",
  "effort_nested",
  "budget",
  "toggle",
  "noop",
  "tools",
  "vision",
  "web_search",
];
const PROMPT = "Reply with the single word OK.";
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const LEVEL_WORDS = ["none", "minimal", "low", "medium", "high", "xhigh", "default"];
const FALLBACK_PRICE = { prompt: 5e-6, completion: 15e-6 };

const EST_TOKENS: Record<ProbeName, [number, number]> = {
  basic: [20, 8],
  effort_flat: [40, 32],
  effort_nested: [20, 16],
  budget: [20, 1100],
  toggle: [20, 16],
  noop: [60, 1200],
  tools: [80, 40],
  vision: [120, 16],
  web_search: [600, 64],
};

function costOf(price: { prompt: number; completion: number }, p: number, c: number) {
  return p * price.prompt + c * price.completion;
}

export const plan = query({
  args: { ref: v.string() },
  handler: async (ctx, { ref }) => {
    const userId = await optionalUser(ctx);
    const parsed = parseModelRef(ref);
    if (!userId || !parsed) return null;
    const provider = await ctx.db
      .query("providers")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", userId).eq("providerId", parsed.providerId)
      )
      .first();
    if (!provider) return null;
    const prof = await ctx.db
      .query("capabilityProfiles")
      .withIndex("by_user_model", (q) =>
        q.eq("userId", userId).eq("providerId", parsed.providerId).eq("modelId", parsed.modelId)
      )
      .first();
    const profile: CapabilityProfile = prof ?? registryProfile(provider.baseUrl, parsed.modelId);
    const available = ALL.filter((p) => p !== "web_search");
    // Queries can't call out to Jev; the plan shows the heuristic triage, the run asks Jev.
    const triage = await heuristicDecisions.probeTriage(profile, available);
    const price = provider.models.find((m) => m.id === parsed.modelId)?.pricing ?? FALLBACK_PRICE;
    const estimatedUsd = triage.choice.reduce((n, p) => n + costOf(price, ...EST_TOKENS[p]), 0);
    const settings = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    return {
      probes: triage.choice,
      skipped: available.filter((p) => !triage.choice.includes(p)),
      estimatedUsd: Math.round(estimatedUsd * 10000) / 10000,
      priceKnown: Boolean(provider.models.find((m) => m.id === parsed.modelId)?.pricing),
      spentUsd: settings?.probeSpentUsd ?? 0,
      capUsd: settings?.probeSpendCapUsd ?? 0.05,
      manual: profile.source === "manual",
    };
  },
});

export const logs = query({
  args: { ref: v.string() },
  handler: async (ctx, { ref }) => {
    const userId = await optionalUser(ctx);
    const parsed = parseModelRef(ref);
    if (!userId || !parsed) return [];
    const rows = await ctx.db
      .query("probeLogs")
      .withIndex("by_user_model", (q) =>
        q.eq("userId", userId).eq("providerId", parsed.providerId).eq("modelId", parsed.modelId)
      )
      .order("desc")
      .take(50);
    return rows.map((r) => ({
      probe: r.probe,
      status: r.status,
      result: r.result,
      costUsd: r.costUsd,
      ts: r.ts,
    }));
  },
});

export const log = internalMutation({
  args: {
    userId: v.id("users"),
    providerId: v.string(),
    modelId: v.string(),
    probe: v.string(),
    request: v.any(),
    status: v.number(),
    result: v.string(),
    costUsd: v.number(),
  },
  handler: async (ctx, a) => {
    await ctx.db.insert("probeLogs", { ...a, ts: Date.now() });
  },
});

type ProbeOutcome = { ok: boolean; status: number; error?: string; res?: Completion };

async function send(
  ctx: ActionCtx,
  ep: Endpoint,
  who: { userId: Id<"users">; providerId: string; modelId: string },
  probe: string,
  body: Record<string, unknown>,
  price: { prompt: number; completion: number },
  maxField: { value: "max_tokens" | "max_completion_tokens" }
): Promise<ProbeOutcome> {
  const tokens = Number(body.max_tokens ?? 16);
  delete body.max_tokens;
  body[maxField.value] = tokens;
  let out: ProbeOutcome;
  try {
    const res = await complete(ep, {
      model: who.modelId,
      stream_options: { include_usage: true },
      ...body,
    });
    out = { ok: true, status: 200, res };
  } catch (e) {
    if (
      e instanceof LlmError &&
      /max_tokens/.test(e.body) &&
      /max_completion_tokens/.test(e.body) &&
      maxField.value === "max_tokens"
    ) {
      maxField.value = "max_completion_tokens";
      return await send(
        ctx,
        ep,
        who,
        probe,
        { ...body, max_tokens: tokens, [maxField.value]: undefined },
        price,
        maxField
      );
    }
    if (e instanceof LlmError && /stream_options/.test(e.body)) {
      try {
        const res = await complete(ep, { model: who.modelId, ...body });
        out = { ok: true, status: 200, res };
      } catch (e2) {
        out = {
          ok: false,
          status: e2 instanceof LlmError ? e2.status : 0,
          error: errorMessage(e2),
        };
      }
    } else {
      out = {
        ok: false,
        status: e instanceof LlmError ? e.status : 0,
        error: e instanceof LlmError ? `${e.message} ${e.body}`.slice(0, 600) : errorMessage(e),
      };
    }
  }
  const u = out.res?.usage;
  const cost = u?.costUsd ?? costOf(price, u?.promptTokens ?? 20, u?.completionTokens ?? 0);
  const { messages: _m, ...logged } = body;
  await ctx.runMutation(internal.probes.log, {
    ...who,
    probe,
    request: JSON.parse(JSON.stringify(logged, (_k, val) => (val === undefined ? null : val))),
    status: out.status,
    result: out.ok
      ? `ok${out.res?.reasoning ? " (reasoning text)" : ""}${out.res?.toolCalls.length ? " (tool call)" : ""}`
      : (out.error ?? "error"),
    costUsd: cost,
  });
  await ctx.runMutation(internal.settings.addProbeSpend, { userId: who.userId, usd: cost });
  return out;
}

type ProbeRun = {
  ran: string[];
  skipped: string[];
  findings: string[];
  profile: CapabilityProfile | null;
};

export const run = action({
  args: { ref: v.string(), probes: v.optional(v.array(v.string())) },
  handler: async (ctx, { ref, probes }): Promise<ProbeRun> =>
    runProbes(ctx, await requireUser(ctx), ref, probes),
});

/** Reasoning-control probes only: a few tiny requests, enough to fill in the Thinking levels. */
const AUTO: ProbeName[] = ["basic", "effort_flat", "effort_nested", "budget", "toggle"];

/** A registry guess that leaves the Thinking control empty or uncertain gets checked once, unasked. */
function needsCheck(p: Pick<CapabilityProfile, "source" | "confidence" | "reasoning">): boolean {
  return p.source === "registry" && (p.reasoning.style === "none" || p.confidence < 0.75);
}

/**
 * Schedules a one-time background probe for a model the user is about to use, so its reasoning
 * levels show up without anyone pressing "Run probes". A log row marks the attempt, so each model is
 * tried once; the per-user spend cap still applies.
 */
export async function scheduleAutoProbe(
  ctx: MutationCtx,
  userId: Id<"users">,
  ref: string
): Promise<boolean> {
  const parsed = parseModelRef(ref);
  if (!parsed) return false;
  const provider = await ctx.db
    .query("providers")
    .withIndex("by_user_provider", (q) =>
      q.eq("userId", userId).eq("providerId", parsed.providerId)
    )
    .first();
  if (!provider) return false;
  const byModel = (q: any) =>
    q.eq("userId", userId).eq("providerId", parsed.providerId).eq("modelId", parsed.modelId);
  const prof = await ctx.db.query("capabilityProfiles").withIndex("by_user_model", byModel).first();
  if (!needsCheck(prof ?? registryProfile(provider.baseUrl, parsed.modelId))) return false;
  const tried = await ctx.db.query("probeLogs").withIndex("by_user_model", byModel).first();
  if (tried) return false;
  await ctx.db.insert("probeLogs", {
    userId,
    ...parsed,
    probe: "auto",
    request: null,
    status: 0,
    result: "scheduled",
    costUsd: 0,
    ts: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.probes.auto, { userId, ref });
  return true;
}

export const ensure = mutation({
  args: { ref: v.string() },
  handler: async (ctx, { ref }) => scheduleAutoProbe(ctx, await requireUser(ctx), ref),
});

export const auto = internalAction({
  args: { userId: v.id("users"), ref: v.string() },
  handler: async (ctx, { userId, ref }) => {
    try {
      await runProbes(ctx, userId, ref, AUTO);
    } catch (err) {
      console.warn(`auto probe ${ref}: ${errorMessage(err)}`);
    }
  },
});

async function runProbes(
  ctx: ActionCtx,
  userId: Id<"users">,
  ref: string,
  probes?: string[]
): Promise<ProbeRun> {
  const parsed = parseModelRef(ref);
  if (!parsed) throw new ConvexError("Unknown model.");
  const ep = await endpointFor(ctx, userId, parsed.providerId);
  if (!ep) throw new ConvexError("Provider not found.");
  const current = await ctx.runQuery(internal.models.profileInternal, { userId, ...parsed });
  if (!current) throw new ConvexError("Model not found.");
  if (current.source === "manual")
    throw new ConvexError("This model has a manual override. Clear it before probing.");
  const settings = await ctx.runQuery(internal.settings.forUser, { userId });
  const modelCtx = await ctx.runQuery(internal.engine.data.modelContext, { userId, ref });
  const price = modelCtx?.pricing ?? FALLBACK_PRICE;
  const wanted = probes?.length
    ? probes.filter((p): p is ProbeName => (ALL as string[]).includes(p))
    : (
        await decisionProvider().probeTriage(
          current,
          ALL.filter((p) => p !== "web_search")
        )
      ).choice;
  const who = { userId, ...parsed };
  const maxField = {
    value: (current.params?.maxTokensField ?? "max_tokens") as
      "max_tokens" | "max_completion_tokens",
  };
  const user = [{ role: "user", content: PROMPT }];
  const ran: string[] = [];
  const skipped: string[] = [];
  const findings: string[] = [];
  let spent = settings.probeSpentUsd;

  const reasoning: CapabilityProfile["reasoning"] = { ...current.reasoning };
  const features = { ...current.features };
  let sawReasoningText = false;
  let effortField: string | null = null;
  let levels: string[] = [];

  const can = (p: ProbeName) => {
    const est = costOf(price, ...EST_TOKENS[p]);
    if (spent + est > settings.probeSpendCapUsd) {
      skipped.push(`${p} (spend cap)`);
      return false;
    }
    spent += est;
    ran.push(p);
    return true;
  };
  const go = async (p: ProbeName, body: Record<string, unknown>) => {
    const r = await send(
      ctx,
      ep,
      who,
      p,
      { messages: user, max_tokens: 16, ...body },
      price,
      maxField
    );
    if (r.res?.reasoning) sawReasoningText = true;
    return r;
  };

  if (wanted.includes("basic") && can("basic")) {
    const r = await go("basic", {});
    if (!r.ok) {
      const msg =
        r.status === 401 || r.status === 403
          ? `The provider rejected the API key (${r.status}). Open this provider and paste the key again.`
          : r.status === 404
            ? "The provider doesn't recognise this model or path. Check the base URL (it usually ends in /v1)."
            : `The test request failed (${r.status || "network"}). ${(r.error ?? "").slice(0, 160)}`;
      throw new ConvexError(msg);
    }
    features.streaming = true;
  }
  if (wanted.includes("effort_flat") && can("effort_flat")) {
    const ok = await go("effort_flat", { reasoning_effort: "low" });
    if (ok.ok) {
      effortField = "reasoning_effort";
      const bad = await go("effort_flat", { reasoning_effort: "x-invalid-level" });
      const text = (bad.error ?? "").toLowerCase();
      levels = LEVEL_WORDS.filter((w) => new RegExp(`["'\\s\\[]${w}["'\\],]`).test(text));
      if (bad.ok) findings.push("reasoning_effort accepted any value (probably ignored).");
    }
  }
  if (!effortField && wanted.includes("effort_nested") && can("effort_nested")) {
    const r = await go("effort_nested", { reasoning: { effort: "low" } });
    if (r.ok) effortField = "reasoning.effort";
  }
  let budgetField: string | null = null;
  if (!effortField && wanted.includes("budget") && can("budget")) {
    const a = await go("budget", { reasoning: { max_tokens: 1024 }, max_tokens: 1100 });
    if (a.ok) budgetField = "reasoning.max_tokens";
    else {
      const b = await go("budget", {
        thinking: { type: "enabled", budget_tokens: 1024 },
        max_tokens: 1100,
      });
      if (b.ok) budgetField = "thinking.budget_tokens";
    }
  }
  let toggleField: string | null = null;
  if (!effortField && !budgetField && wanted.includes("toggle") && can("toggle")) {
    const r = await go("toggle", { chat_template_kwargs: { enable_thinking: false } });
    if (r.ok && !r.res?.reasoning) toggleField = "chat_template_kwargs.enable_thinking";
  }

  if (effortField) {
    const lv = levels.length ? levels.filter((l) => l !== "default") : ["low", "medium", "high"];
    Object.assign(reasoning, {
      style: "effort",
      field: effortField,
      levels: lv,
      defaultLevel: lv.includes("medium") ? "medium" : lv[0],
      budgets: undefined,
    });
    findings.push(`Reasoning effort via ${effortField}: ${lv.join(", ")}.`);
  } else if (budgetField) {
    Object.assign(reasoning, {
      style: "budget",
      field: budgetField,
      levels: ["low", "medium", "high"],
      budgets: { low: 2048, medium: 8192, high: 24576 },
      defaultLevel: "medium",
    });
    findings.push(`Reasoning budget via ${budgetField}.`);
  } else if (toggleField) {
    Object.assign(reasoning, {
      style: "toggle",
      field: toggleField,
      levels: ["on"],
      defaultLevel: "on",
    });
    findings.push("Reasoning can be switched on/off.");
  } else if (ran.some((p) => ["effort_flat", "effort_nested", "budget", "toggle"].includes(p))) {
    Object.assign(reasoning, {
      style: "none",
      levels: [],
      defaultLevel: "off",
      field: undefined,
      budgets: undefined,
    });
    findings.push("No reasoning control accepted.");
  }

  if (reasoning.style === "effort" && wanted.includes("noop") && can("noop")) {
    const q = [{ role: "user", content: "What is 17*23? Answer with just the number." }];
    const path =
      reasoning.field === "reasoning.effort"
        ? (lv: string) => ({ reasoning: { effort: lv } })
        : (lv: string) => ({ reasoning_effort: lv });
    const lo = await go("noop", { messages: q, max_tokens: 600, ...path(reasoning.levels[0]) });
    const hi = await go("noop", {
      messages: q,
      max_tokens: 600,
      ...path(reasoning.levels[reasoning.levels.length - 1]),
    });
    const a = lo.res?.usage;
    const b = hi.res?.usage;
    if (a?.reportsReasoning && b?.reportsReasoning) {
      reasoning.noop = a.reasoningTokens === b.reasoningTokens && a.reasoningTokens === 0;
      findings.push(
        reasoning.noop
          ? "Effort levels made no difference (no-op)."
          : `Reasoning tokens low/high: ${a.reasoningTokens}/${b.reasoningTokens}.`
      );
    }
  }
  if (wanted.includes("tools") && can("tools")) {
    const r = await go("tools", {
      messages: [{ role: "user", content: "Call the ping tool." }],
      tools: [
        {
          type: "function",
          function: {
            name: "ping",
            description: "Health check",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      max_tokens: 40,
    });
    features.tools = r.ok;
    findings.push(
      r.ok
        ? r.res?.toolCalls.length
          ? "Tool calling works."
          : "Tools accepted (model didn't call one)."
        : "No tool calling; using prompted-JSON cards."
    );
  }
  if (wanted.includes("vision") && can("vision")) {
    const r = await go("vision", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: PIXEL } },
          ],
        },
      ],
    });
    features.vision = r.ok;
    findings.push(r.ok ? "Accepts images." : "No image input.");
  }
  if (
    wanted.includes("web_search") &&
    can("web_search") &&
    current.params?.nativeSearch === "openrouter"
  ) {
    const r = await go("web_search", {
      plugins: [{ id: "web", max_results: 1 }],
      max_tokens: 64,
    });
    features.webSearch = r.ok;
  }
  features.reasoningText = features.reasoningText || sawReasoningText;

  await ctx.runMutation(internal.models.applyProbeResult, {
    userId,
    ...parsed,
    reasoning,
    features,
    maxTokensField: maxField.value,
    confidence: 0.9,
  });
  const profile = await ctx.runQuery(internal.models.profileInternal, { userId, ...parsed });
  return { ran, skipped, findings, profile };
}
