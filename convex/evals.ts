import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  componentTools,
  MODEL_COMPONENTS,
  partialProps,
  validateToolArgs,
  promptedCatalog,
} from "./ai/catalog";
import { jevDecide, type JevQuestion } from "./ai/jev";
import { streamChat, ToolCallAccumulator, authHeaders } from "./ai/openai";
import { systemPrompt } from "./engine/prompt";
import { endpointFor } from "./lib/endpoint";
import { FenceParser } from "./engine/loop";
import { decisionProvider } from "./ai/decisions";
import { internal } from "./_generated/api";
import { runTurn } from "./engine/turn";
import { uid } from "./lib/util";
import { type Id } from "./_generated/dataModel";
import { messagesUrl } from "./ai/anthropic";

/**
 * Generative-UI study, run from the CLI against a user's own providers:
 *   npx convex run evals:uiStudy '{"userId":"…","providerId":"7api","models":["gpt-6.1-sol"],"prompts":["…"]}'
 * `jev` asks Jev the candidate routing questions; `models` sends each prompt once to each model with
 * the real system prompt and card tools and reports what it did. Returns summaries only.
 */

const WEB_SEARCH = {
  type: "function" as const,
  function: {
    name: "web_search",
    description: "Search the web for current information.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
};

export const uiStudy = internalAction({
  args: {
    userId: v.id("users"),
    providerId: v.string(),
    prompts: v.array(v.string()),
    models: v.optional(v.array(v.string())),
    jev: v.optional(v.any()),
    directive: v.optional(v.record(v.string(), v.string())),
    concurrency: v.optional(v.number()),
    /** Cards written as ```component fences in the text stream instead of tool calls. */
    inline: v.optional(v.boolean()),
    /** Run the app's own per-turn router (Jev with heuristic fallback) and report the presentation. */
    router: v.optional(v.boolean()),
    /** Merged into every request body (reasoning settings, tool_choice…) to reproduce endpoint errors. */
    body: v.optional(v.any()),
  },
  handler: async (ctx, a) => {
    const out: Record<string, unknown> = {};
    if (a.jev) {
      const questions = a.jev as Record<string, JevQuestion>;
      out.jev = await Promise.all(
        a.prompts.map(async (p) => {
          const r = await jevDecide(
            { message: p, has_images: false, previous_reply: "" },
            questions,
            4000
          );
          if (!r) return { p, error: "jev failed" };
          const ans: Record<string, unknown> = {};
          for (const [k, x] of Object.entries(r.answers)) {
            const probs = (x as { probabilities?: Record<string, number> }).probabilities;
            ans[k] = probs
              ? Object.fromEntries(
                  Object.entries(probs)
                    .filter(([, n]) => n >= 0.05)
                    .sort((m, n) => n[1] - m[1])
                    .map(([c, n]) => [c, Math.round(n * 100) / 100])
                )
              : x;
          }
          return { p: p.slice(0, 50), ms: r.ms, ...ans };
        })
      );
    }
    if (a.router) {
      const dp = decisionProvider();
      out.router = await Promise.all(
        a.prompts.map(async (p) => {
          const d = await dp.turn({
            text: p,
            hasImages: false,
            researchMode: false,
            subagentMode: "auto",
            components: MODEL_COMPONENTS,
          });
          const pr = d.presentation;
          return {
            p: p.slice(0, 44),
            intent: `${d.intent.choice}@${d.intent.confidence}`,
            presentation: `${pr.choice.kind}@${pr.confidence} v${pr.choice.visual.toFixed(2)} t${pr.choice.tool.toFixed(2)} (${pr.provider})`,
            cards: d.components.choice,
          };
        })
      );
    }
    if (a.models?.length) {
      const ep = await endpointFor(ctx, a.userId, a.providerId);
      if (!ep) throw new Error("provider not found");
      const jobs = a.models.flatMap((model) => a.prompts.map((p) => ({ model, p })));
      const results: unknown[] = [];
      const limit = a.concurrency ?? 4;
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const { model, p } = jobs[next++];
          const extra = a.directive?.[p] ? [a.directive[p]] : [];
          const system = systemPrompt({
            now: Date.now(),
            customInstructions: "",
            memories: [],
            incognito: false,
            components: !a.inline,
            promptedCatalog: a.inline ? promptedCatalog(["Blocks"]) : undefined,
            web: "app",
            locationTool: false,
            subagents: "off",
            memoryTool: false,
            extra,
          });
          const calls = new ToolCallAccumulator();
          const fence = new FenceParser();
          const fenced: string[] = [];
          const start = Date.now();
          let firstEvent = 0;
          let firstBlock = 0;
          let textLen = 0;
          let error = "";
          try {
            for await (const ev of streamChat(ep, {
              model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: p },
              ],
              ...(a.inline ? {} : { tools: [...componentTools(MODEL_COMPONENTS), WEB_SEARCH] }),
              max_tokens: 8000,
              ...(a.body ?? {}),
            })) {
              firstEvent ||= Date.now() - start;
              if (ev.type === "text") {
                textLen += ev.delta.length;
                for (const fe of fence.push(ev.delta)) {
                  if (
                    fe.type === "partial" &&
                    !firstBlock &&
                    partialProps("Blocks", fe.body, "props")
                  )
                    firstBlock = Date.now() - start;
                  if (fe.type === "end") fenced.push(fe.body);
                }
              }
              if (ev.type !== "tool_call") continue;
              const { index } = calls.push(ev);
              const c = calls.get(index);
              if (!firstBlock && c?.name === "ui_Blocks" && partialProps("Blocks", c.args))
                firstBlock = Date.now() - start;
            }
          } catch (e) {
            error = (e as Error).message.slice(0, 400);
          }
          for (const fe of fence.flush()) if (fe.type === "end") fenced.push(fe.body);
          const tc = calls.list();
          const names = tc.map((c) => c.function.name);
          const inlineArgs = fenced.length
            ? JSON.stringify({ ...(JSON.parse(fenced[0]).props ?? {}), fallbackText: "x" })
            : null;
          const blocks =
            tc.find((c) => c.function.name === "ui_Blocks") ??
            (inlineArgs ? { function: { name: "inline", arguments: inlineArgs } } : undefined);
          let shape = "";
          if (blocks) {
            try {
              const r = validateToolArgs("Blocks", JSON.parse(blocks.function.arguments));
              shape = r.ok
                ? (r.props as { blocks: { type: string }[] }).blocks.map((b) => b.type).join(",")
                : `INVALID ${r.error}`;
            } catch {
              shape = "INVALID json";
            }
          }
          results.push({
            model,
            p: p.slice(0, 40),
            ms: Date.now() - start,
            first: firstEvent,
            firstBlock,
            text: textLen,
            tools: [...names, ...(fenced.length ? ["inline"] : [])].join(","),
            shape,
            error,
          });
        }
      };
      await Promise.all(Array.from({ length: limit }, worker));
      out.models = results;
    }
    return out;
  },
});
/* ------------------------------------------------------------------ end to end */

/** A throwaway incognito chat holding one user message and an empty reply for runTurn to fill. */
export const scenarioOpen = internalMutation({
  args: {
    userId: v.id("users"),
    modelRef: v.string(),
    text: v.string(),
    reasoningLevel: v.string(),
    /** Continue this chat instead of starting one (a follow-up turn). */
    threadId: v.optional(v.id("threads")),
  },
  handler: async (ctx, a) => {
    const threadId =
      a.threadId ??
      (await ctx.db.insert("threads", {
        userId: a.userId,
        title: `[eval] ${a.text.slice(0, 40)}`,
        modelRef: a.modelRef,
        mode: "chat",
        reasoningLevel: a.reasoningLevel,
        incognito: true,
        updatedAt: Date.now(),
      }));
    await ctx.db.insert("messages", {
      threadId,
      userId: a.userId,
      role: "user",
      parts: [{ id: uid("txt"), type: "text", text: a.text }],
      status: "done",
    });
    const messageId = await ctx.db.insert("messages", {
      threadId,
      userId: a.userId,
      role: "assistant",
      parts: [],
      status: "streaming",
      meta: {
        modelRef: a.modelRef,
        levelRequested: a.reasoningLevel,
        levelSent: "",
        reasoningTokens: 0,
      },
    });
    return { threadId, messageId };
  },
});

export const scenarioRead = internalQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, a) => {
    const message = await ctx.db.get(a.messageId);
    const rows = await ctx.db
      .query("decisions")
      .withIndex("by_ref", (q) => q.eq("refId", a.messageId))
      .collect();
    const decisions = rows
      .filter((d) => ["intent", "presentation", "components", "search"].includes(d.kind))
      .map((d) => ({ kind: d.kind, output: d.output as unknown, confidence: d.confidence }));
    return { message, decisions };
  },
});

export const scenarioClose = internalMutation({
  args: { threadId: v.id("threads"), userId: v.id("users") },
  handler: async (ctx, { threadId, userId }) => {
    await ctx.db.delete(threadId);
    await ctx.scheduler.runAfter(0, internal.threads.purge, { threadId, userId });
  },
});

/** Sends one raw Anthropic Messages request to a provider and returns the status and a short body. */
export const rawMessages = internalAction({
  args: { userId: v.id("users"), providerId: v.string(), body: v.any() },
  handler: async (ctx, a) => {
    const ep = await endpointFor(ctx, a.userId, a.providerId);
    if (!ep) throw new Error("provider not found");
    const res = await fetch(messagesUrl(ep.baseUrl), {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        ...(ep.apiKey ? { "x-api-key": ep.apiKey } : {}),
        ...authHeaders(ep),
      },
      body: JSON.stringify(a.body),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text.replaceAll(ep.apiKey ?? "\u0000", "<key>").slice(0, 600),
    };
  },
});

/**
 * Runs real turns (router, search, tools, cards) one after another in throwaway incognito chats and
 * reports what the user would have seen; each chat is deleted afterwards. Decisions are read back
 * from the log, so only one e2e run per user at a time.
 */
export const e2e = internalAction({
  args: {
    userId: v.id("users"),
    modelRef: v.string(),
    prompts: v.array(v.string()),
    reasoningLevel: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const out: unknown[] = [];
    // "first || follow-up" runs both turns in one chat and reports the last.
    for (const script of a.prompts) {
      const turns = script.split(" || ");
      const text = turns[turns.length - 1];
      const since = Date.now();
      let threadId: Id<"threads"> | undefined;
      let messageId: Id<"messages"> | undefined;
      for (const t of turns) {
        const opened = await ctx.runMutation(internal.evals.scenarioOpen, {
          userId: a.userId,
          modelRef: a.modelRef,
          text: t,
          reasoningLevel: a.reasoningLevel ?? "medium",
          threadId,
        });
        threadId = opened.threadId;
        messageId = opened.messageId;
        if (t !== text) await runTurn(ctx, messageId);
      }
      try {
        await runTurn(ctx, messageId!);
        const { message, decisions } = await ctx.runQuery(internal.evals.scenarioRead, {
          messageId: messageId!,
        });
        const dec = Object.fromEntries(decisions.map((d) => [d.kind, d]));
        const pres = dec.presentation?.output as
          { kind: string; visual: number; tool: number } | undefined;
        const cards = (dec.components?.output ?? {}) as Record<string, number>;
        const top = Object.entries(cards).sort((x, y) => y[1] - x[1])[0];
        const parts = (message?.parts ?? []).map((p) => {
          if (p.type === "text") return `text${p.text.length}`;
          if (p.type !== "component") return p.type;
          const blocks = (p.props as { blocks?: { type: string }[] } | null)?.blocks;
          return `${p.name}:${p.status}${blocks ? `[${blocks.map((b) => b.type).join(",")}]` : ""}${p.error ? ` ERR ${p.error.slice(0, 60)}` : ""}`;
        });
        out.push({
          p: script.slice(0, 48),
          ms: Date.now() - since,
          intent: dec.intent ? `${String(dec.intent.output)}@${dec.intent.confidence}` : "-",
          pres: pres ? `${pres.kind} v${pres.visual.toFixed(2)} t${pres.tool.toFixed(2)}` : "-",
          card: top ? `${top[0]}@${top[1].toFixed(2)}` : "-",
          search: dec.search ? JSON.stringify(dec.search.output) : "-",
          status: message?.status,
          parts: parts.filter((x) => x !== "thinking" && x !== "sources").join(" "),
          error: message?.error?.slice(0, 120),
        });
      } finally {
        await ctx.runMutation(internal.evals.scenarioClose, {
          threadId: threadId!,
          userId: a.userId,
        });
      }
    }
    return out;
  },
});
