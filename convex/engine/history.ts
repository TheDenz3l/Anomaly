import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { ChatMessage, ContentPart } from "../ai/openai";
import { toBase64 } from "../lib/crypto";
import { truncate } from "../lib/util";
import type { Part } from "../lib/validators";

/** Converts stored thread messages into OpenAI chat messages, within the model's context budget. */

export function describeEvent(p: Extract<Part, { type: "ui_event" }>): string {
  const payload =
    p.payload && Object.keys(p.payload).length
      ? ` payload: ${truncate(JSON.stringify(p.payload), 1500)}`
      : "";
  return `[UI event] The user used the ${p.component} card (id ${p.componentId}): action "${p.action}" — ${p.label}.${payload}`;
}

async function imageUrl(
  ctx: ActionCtx,
  p: Extract<Part, { type: "image" }>
): Promise<string | null> {
  if (p.storageId) {
    const blob = await ctx.storage.get(p.storageId);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return `data:${p.mime ?? blob.type ?? "image/jpeg"};base64,${toBase64(bytes)}`;
  }
  if (p.uri && /^(https:|data:image\/)/.test(p.uri)) return p.uri;
  return null;
}

function assistantText(m: Doc<"messages">, detailed: boolean): string {
  const out: string[] = [];
  for (const p of m.parts) {
    if (p.type === "text") out.push(p.text);
    else if (p.type === "component") {
      const props =
        detailed && p.status === "ready"
          ? ` props: ${truncate(JSON.stringify(p.props), 1800)}`
          : "";
      out.push(
        `[Showed ${p.name} card id=${p.id}${p.status === "invalid" ? " (failed to render)" : ""}: ${p.fallbackText}]${props}`
      );
    }
  }
  return out.join("\n").trim();
}

export async function toChatMessages(
  ctx: ActionCtx,
  history: Doc<"messages">[],
  opts: { vision: boolean; maxChars: number; imageTurns?: number }
): Promise<{ messages: ChatMessage[]; droppedImages: number }> {
  const out: ChatMessage[] = [];
  let droppedImages = 0;
  const userIdx = history.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
  const imageFrom = userIdx[Math.max(0, userIdx.length - (opts.imageTurns ?? 2))] ?? 0;
  const assistantIdx = history
    .map((m, i) => (m.role === "assistant" ? i : -1))
    .filter((i) => i >= 0);
  const detailFrom = assistantIdx[Math.max(0, assistantIdx.length - 2)] ?? 0;

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === "assistant") {
      const text = assistantText(m, i >= detailFrom);
      if (!text) continue;
      out.push({ role: "assistant", content: text });
      continue;
    }
    const content: ContentPart[] = [];
    for (const p of m.parts) {
      if (p.type === "text") content.push({ type: "text", text: p.text });
      else if (p.type === "ui_event") content.push({ type: "text", text: describeEvent(p) });
      else if (p.type === "image") {
        if (opts.vision && i >= imageFrom) {
          const url = await imageUrl(ctx, p);
          if (url) content.push({ type: "image_url", image_url: { url } });
          else content.push({ type: "text", text: "[image unavailable]" });
        } else {
          if (!opts.vision) droppedImages++;
          content.push({
            type: "text",
            text: "[The user attached an image that this model can't see.]",
          });
        }
      }
    }
    if (!content.length) continue;
    const prev = out[out.length - 1];
    const simple = content.every((c) => c.type === "text");
    if (prev?.role === "user") {
      const prevParts: ContentPart[] =
        typeof prev.content === "string" ? [{ type: "text", text: prev.content }] : prev.content;
      const merged = [...prevParts, ...content];
      prev.content = merged.every((c) => c.type === "text")
        ? merged.map((c) => (c as { text: string }).text).join("\n\n")
        : merged;
    } else {
      out.push({
        role: "user",
        content: simple ? content.map((c) => (c as { text: string }).text).join("\n") : content,
      });
    }
  }

  const size = (msg: ChatMessage) =>
    typeof msg.content === "string"
      ? msg.content.length
      : Array.isArray(msg.content)
        ? msg.content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 3000), 0)
        : 0;
  let total = out.reduce((n, msg) => n + size(msg), 0);
  while (total > opts.maxChars && out.length > 1) {
    total -= size(out.shift()!);
  }
  while (out.length && out[0].role !== "user") out.shift();
  return { messages: out, droppedImages };
}

/**
 * The conversation before the latest user message, as plain "User:"/"Assistant:" turns, newest
 * last and cut to `maxChars` from the front. Gives one-shot prompts (like research scoping) the
 * context a follow-up such as "research that" depends on.
 */
export function conversationContext(history: Doc<"messages">[], maxChars = 12_000): string {
  let last = history.length - 1;
  while (last >= 0 && history[last].role !== "user") last--;
  const turns: string[] = [];
  for (let i = 0; i < last; i++) {
    const m = history[i];
    const text =
      m.role === "assistant"
        ? assistantText(m, false)
        : m.parts
            .map((p) =>
              p.type === "text" ? p.text : p.type === "ui_event" ? `[picked: ${p.label}]` : ""
            )
            .filter(Boolean)
            .join("\n");
    if (text.trim()) turns.push(`${m.role === "user" ? "User" : "Assistant"}: ${text.trim()}`);
  }
  const all = turns.join("\n\n");
  return all.length > maxChars ? `…${all.slice(-maxChars)}` : all;
}

/** The input that triggered this turn: the last user message before the reply. */
export function lastInput(history: Doc<"messages">[]): {
  text: string;
  images: number;
  event: Extract<Part, { type: "ui_event" }> | null;
  message: Doc<"messages"> | null;
} {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user") continue;
    const event =
      (m.parts.find((p) => p.type === "ui_event") as
        Extract<Part, { type: "ui_event" }> | undefined) ?? null;
    const text = m.parts
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return {
      text: event ? event.label : text,
      images: m.parts.filter((p) => p.type === "image").length,
      event,
      message: m,
    };
  }
  return { text: "", images: 0, event: null, message: null };
}
