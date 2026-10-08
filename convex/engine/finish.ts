import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { LlmError } from "../ai/openai";
import { textOf } from "../lib/messages";
import { errorMessage, uid } from "../lib/util";
import type { ReplyMeta } from "../lib/validators";
import type { SourceCollector } from "../web/sources";
import { estimateCost, flushRecords, learn, type Engine } from "./context";
import type { LoopResult } from "./loop";
import type { PartWriter } from "./writer";

/** Sources bar last (PRD §3.2), meta chip, learning signals, decision log — then mark done. */
export async function finishTurn(
  engine: Engine,
  sink: PartWriter,
  o: {
    messageId: Id<"messages">;
    sources: SourceCollector;
    result?: LoopResult;
    meta: ReplyMeta;
    kind?: "report";
  }
): Promise<void> {
  const list = o.sources.all();
  sink.dropUnusedPreloads();
  for (const p of sink.parts) if (p.type === "sources") sink.remove(p.id);
  const hasContent = sink.parts.some(
    (p) => (p.type === "text" && p.text.trim()) || p.type === "component"
  );
  if (!hasContent && !sink.stopped) {
    sink.text(
      "I couldn't put together an answer this time. Try rephrasing, or pick a different model."
    );
  }
  if (list.length) sink.add({ id: uid("src"), type: "sources", sources: list });

  const r = o.result;
  const meta: ReplyMeta = {
    ...o.meta,
    ...(r
      ? {
          levelSent: r.levelSent,
          reasoningTokens: r.reasoningTokens,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          costUsd: r.costUsd ?? estimateCost(engine, r.promptTokens, r.completionTokens),
        }
      : {}),
    ...(o.kind ? { kind: o.kind } : {}),
  };
  if (r && !sink.stopped) {
    learn(engine, {
      kind: "reasoning_tokens",
      levelSent: r.levelSent,
      tokens: r.reasoningTokens,
      reported: r.reasoningReported,
    });
    if (r.reasoningSeen) learn(engine, { kind: "reasoning_text_seen" });
    learn(engine, { kind: "success" });
  }
  await sink.finish({
    status: sink.stopped ? "stopped" : "done",
    meta,
    searchText: engine.thread.incognito ? undefined : textOf(sink.parts),
  });
  await Promise.allSettled([
    engine.ctx.runMutation(internal.engine.data.recordTurn, {
      messageId: o.messageId,
      reasoning: r
        ? {
            modelRef: meta.modelRef,
            levelRequested: meta.levelRequested,
            levelSent: meta.levelSent,
            reasoningTokens: meta.reasoningTokens,
            outcome: sink.stopped ? "stopped" : "ok",
          }
        : undefined,
      sources: list,
    }),
    flushRecords(engine, o.messageId),
    r
      ? engine.ctx.runMutation(internal.providers.recordUsage, {
          userId: engine.userId,
          providerId: engine.providerId,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          costUsd: meta.costUsd,
        })
      : null,
  ]);
}

export function friendlyError(e: unknown, engine: Engine | null): string {
  if (e instanceof ConvexError) return typeof e.data === "string" ? e.data : errorMessage(e.data);
  if (e instanceof LlmError) {
    const where = engine ? engine.endpoint.baseUrl : "the provider";
    switch (e.kind) {
      case "auth":
        return `The provider rejected the API key (${e.status}). Update it in Settings → Providers.`;
      case "not_found":
        return `The model ${engine?.modelId ?? ""} wasn't found at ${where}. Pick another model.`;
      case "rate_limit":
        return "The provider is rate-limiting requests. Try again in a minute.";
      case "context_overflow":
        return "This chat is longer than the model's context window. Start a new chat, or pick a model with a larger window.";
      case "network":
        return `Couldn't reach ${where}. Local servers (LM Studio, Ollama) need to be exposed with a tunnel, since replies run in Convex's cloud.`;
      default:
        return `The model request failed: ${e.message}`;
    }
  }
  return `Something went wrong: ${errorMessage(e)}`;
}

export async function failTurn(
  engine: Engine | null,
  sink: PartWriter,
  e: unknown,
  meta: ReplyMeta
): Promise<void> {
  const msg = friendlyError(e, engine);
  console.error("turn failed", errorMessage(e));
  sink.text(`${sink.parts.some((p) => p.type === "text") ? "\n\n" : ""}${msg}`);
  await sink.finish({ status: sink.stopped ? "stopped" : "error", error: msg, meta });
  if (engine) await flushRecords(engine).catch(() => {});
}
