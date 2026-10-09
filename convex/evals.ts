import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { MODEL_COMPONENTS } from "./ai/catalog";
import { OpenUICard, openuiCatalog } from "./ai/openui";
import { jevDecide, type JevQuestion } from "./ai/jev";
import { streamChat, authHeaders } from "./ai/openai";
import { systemPrompt } from "./engine/prompt";
import { endpointFor } from "./lib/endpoint";
import { FenceParser } from "./engine/loop";
import { decisionProvider } from "./ai/decisions";
import { internal } from "./_generated/api";
import { runTurn } from "./engine/turn";
import { uid } from "./lib/util";
import { type Id } from "./_generated/dataModel";
import type { Part } from "./lib/validators";
import { messagesUrl } from "./ai/anthropic";

/**
 * Generative-UI study, run from the CLI against a user's own providers:
 *   npx convex run evals:uiStudy '{"userId":"…","providerId":"7api","models":["gpt-6.1-sol"],"prompts":["…"]}'
 * `jev` asks Jev the candidate routing questions; `models` sends each prompt once to each model with
 * the real system prompt and cards on offer, and reports the card it wrote: the components used,
 * what the parser dropped, and timings. Returns summaries only.
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
            cards: openuiCatalog(),
            web: "app",
            locationTool: false,
            subagents: "off",
            memoryTool: false,
            extra,
          });
          const fence = new FenceParser();
          const card = new OpenUICard();
          const start = Date.now();
          let firstEvent = 0;
          let firstText = 0;
          let firstCard = 0;
          let textLen = 0;
          let cardBody = "";
          let error = "";
          const tools: string[] = [];
          try {
            for await (const ev of streamChat(ep, {
              model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: p },
              ],
              tools: [WEB_SEARCH],
              max_tokens: 8000,
              ...(a.body ?? {}),
            })) {
              firstEvent ||= Date.now() - start;
              if (ev.type === "tool_call" && ev.name) tools.push(ev.name);
              if (ev.type !== "text") continue;
              textLen += ev.delta.length;
              for (const fe of fence.push(ev.delta)) {
                if (fe.type === "text" && fe.text.trim()) firstText ||= Date.now() - start;
                if (
                  fe.type === "partial" &&
                  !firstCard &&
                  /^\s*\w+\s*=/m.test(card.update(fe.body))
                )
                  firstCard = Date.now() - start;
                if (fe.type === "end") cardBody ||= fe.body;
              }
            }
          } catch (e) {
            error = (e as Error).message.slice(0, 400);
          }
          for (const fe of fence.flush()) if (fe.type === "end") cardBody ||= fe.body;
          let shape = "";
          if (cardBody) {
            const r = card.finish(cardBody);
            const used = [
              ...new Set([...card.source.matchAll(/\b([A-Z][A-Za-z]+)\(/g)].map((m) => m[1])),
            ];
            shape = r.ok
              ? `OpenUI[${used.join(",")}] ${card.source.length}ch${r.issues.length ? ` dropped:${r.issues.length} ${r.issues[0].slice(0, 120)}` : ""}`
              : `OpenUI INVALID ${r.error}`;
          }
          results.push({
            model,
            p: p.slice(0, 40),
            ms: Date.now() - start,
            first: firstEvent,
            firstText,
            firstCard,
            text: textLen,
            tools: tools.join(","),
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
 * Copies a finished eval reply into a normal chat for another account (a dev device's anonymous
 * user), so the real cards can be opened and tried in the app. Text and card parts only.
 */
export const scenarioShare = internalMutation({
  args: { messageId: v.id("messages"), userId: v.id("users"), text: v.string() },
  handler: async (ctx, a) => {
    const message = await ctx.db.get(a.messageId);
    if (!message) return null;
    const parts = message.parts.filter((p) => p.type === "text" || p.type === "component");
    const threadId = await ctx.db.insert("threads", {
      userId: a.userId,
      title: `[eval] ${a.text.slice(0, 40)}`,
      modelRef: message.meta?.modelRef ?? "eval",
      mode: "chat",
      reasoningLevel: "low",
      incognito: false,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("messages", {
      threadId,
      userId: a.userId,
      role: "user",
      parts: [{ id: uid("txt"), type: "text", text: a.text }],
      status: "done",
    });
    await ctx.db.insert("messages", {
      threadId,
      userId: a.userId,
      role: "assistant",
      parts,
      status: "done",
      meta: message.meta,
    });
    return threadId;
  },
});

/**
 * Runs real turns (router, search, tools, cards) one after another in throwaway incognito chats and
 * reports what the user would have seen; each chat is deleted afterwards. Decisions are read back
 * from the log, so only one e2e run per user at a time.
 */
/** The photo and screenshot URLs a reply's cards showed. */
function cardPhotos(parts: Part[]): string[] {
  return parts.flatMap((p) =>
    p.type === "component" && p.name === "OpenUI"
      ? ((p.props as { photos?: { url: string | null }[] } | null)?.photos ?? [])
          .map((x) => x.url)
          .filter((u): u is string => Boolean(u))
      : []
  );
}

export const e2e = internalAction({
  args: {
    userId: v.id("users"),
    modelRef: v.string(),
    prompts: v.array(v.string()),
    reasoningLevel: v.optional(v.string()),
    /** Also copy each reply into a normal chat for this account, to open it in the app. */
    shareWith: v.optional(v.id("users")),
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
      // Photos the earlier turns' cards showed, to check the last turn doesn't show them again.
      const earlier = new Set<string>();
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
        if (t !== text) {
          await runTurn(ctx, messageId);
          const prior = await ctx.runQuery(internal.evals.scenarioRead, { messageId });
          for (const url of cardPhotos(prior.message?.parts ?? [])) earlier.add(url);
        }
      }
      try {
        await runTurn(ctx, messageId!);
        const { message, decisions } = await ctx.runQuery(internal.evals.scenarioRead, {
          messageId: messageId!,
        });
        if (a.shareWith)
          await ctx.runMutation(internal.evals.scenarioShare, {
            messageId: messageId!,
            userId: a.shareWith,
            text,
          });
        const dec = Object.fromEntries(decisions.map((d) => [d.kind, d]));
        const pres = dec.presentation?.output as
          { kind: string; visual: number; tool: number } | undefined;
        const cards = (dec.components?.output ?? {}) as Record<string, number>;
        const top = Object.entries(cards).sort((x, y) => y[1] - x[1])[0];
        const parts = (message?.parts ?? []).map((p) => {
          if (p.type === "text") return `text${p.text.length}`;
          if (p.type !== "component") return p.type;
          if (p.name === "OpenUI") {
            // The components the program uses, in the order it first uses them.
            const source = String((p.props as { source?: unknown } | null)?.source ?? "");
            const used = [
              ...new Set([...source.matchAll(/\b([A-Z][A-Za-z]+)\(/g)].map((m) => m[1])),
            ];
            return `OpenUI:${p.status}[${used.join(",")}] ${source.length}ch${p.error ? ` ERR ${p.error.slice(0, 60)}` : ""}`;
          }
          const blocks = (p.props as { blocks?: { type: string; show?: string }[] } | null)?.blocks;
          // ? marks a block with a show condition, {} one with live values in its text.
          const shape = (b: { type: string; show?: string }) =>
            `${b.type}${b.show ? "?" : ""}${/\{[a-z_$][^{}]*\}/i.test(JSON.stringify({ ...b, show: undefined, rows: undefined })) ? "{}" : ""}`;
          return `${p.name}:${p.status}${blocks ? `[${blocks.map(shape).join(",")}]` : ""}${p.error ? ` ERR ${p.error.slice(0, 60)}` : ""}`;
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
          photos: (() => {
            const shown = cardPhotos(message?.parts ?? []);
            const repeated = shown.filter((u) => earlier.has(u)).length;
            return `${shown.length} shown${turns.length > 1 ? `, ${repeated} repeated from earlier turns` : ""}`;
          })(),
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
