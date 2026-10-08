import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { ChatMessage, ContentPart } from "../ai/openai";
import { toBase64 } from "../lib/crypto";
import { truncate } from "../lib/util";
import { wrapUntrusted } from "./prompt";
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

/** Files in this many recent user turns go to the model in full (up to the cap); older ones as an excerpt. */
const FILE_TURNS = 3;
const FILE_MAX_CHARS = 120_000;
const OLD_FILE_CHARS = 4_000;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "PDF", "DOCX", "CSV": what the file is, in the word people use for it. */
function typeLabel(name: string, mime: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  if (ext) return ext.toUpperCase();
  const sub = mime.split("/")[1]?.split(/[;+]/)[0];
  return sub && sub !== "octet-stream" ? sub.toUpperCase() : "file";
}

/**
 * An attached file as the model reads it: a line saying what it is, then its text in an untrusted
 * content block, cut to `cap` characters. The text is read on upload; a file whose read
 * hasn't finished yet is read now, so the reply never answers without it.
 */
async function fileBlock(
  ctx: ActionCtx,
  p: Extract<Part, { type: "file" }>,
  cap: number
): Promise<string> {
  const name = p.name.replace(/["<>\n]/g, "");
  if (!p.storageId) return `[Attached file: ${name} (not uploaded)]`;
  let row = await ctx.runQuery(internal.attachments.byStorage, { storageId: p.storageId });
  if (row && (!row.extract || row.extract === "pending")) {
    await ctx.runAction(internal.files.extract, { storageId: p.storageId });
    row = await ctx.runQuery(internal.attachments.byStorage, { storageId: p.storageId });
  }
  const pages = row?.pages
    ? `, ${row.pages} ${/\.(xlsx|ods)$/i.test(name) ? "sheets" : /\.(pptx|odp)$/i.test(name) ? "slides" : "pages"}`
    : "";
  const head = `[Attached file: ${name} (${typeLabel(name, p.mime)}${pages}, ${humanSize(p.size)})]`;
  const blob = row?.textStorageId ? await ctx.storage.get(row.textStorageId) : null;
  if (!blob)
    return `${head}\nIts contents couldn't be read: ${row?.extractNote ?? "the file is no longer available."}`;
  const text = await blob.text();
  const cut = text.length > cap;
  const body = cut ? text.slice(0, cap) : text;
  const note = cut
    ? `\n[Only the first ${cap.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters are included. Say so if the answer may depend on the rest.]`
    : "";
  // The file's text is data, like a web page: instructions inside it are never followed.
  return `${head}\n${wrapUntrusted(`attached file: ${name}`, body)}${note}`;
}

function assistantText(m: Doc<"messages">, detailed: boolean): string {
  const out: string[] = [];
  for (const p of m.parts) {
    if (p.type === "text") out.push(p.text);
    else if (p.type === "component") {
      // A Blocks card is the answer itself, so later turns always see what it said.
      const answer = p.name === "Blocks";
      const props =
        (detailed || answer) && p.status === "ready"
          ? ` props: ${truncate(JSON.stringify(p.props), answer ? 4000 : 1800)}`
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
  const fileFrom = userIdx[Math.max(0, userIdx.length - FILE_TURNS)] ?? 0;
  const fileCap = Math.min(FILE_MAX_CHARS, Math.floor(opts.maxChars * 0.6));

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === "assistant") {
      const text = assistantText(m, i >= detailFrom);
      if (!text) continue;
      out.push({ role: "assistant", content: text });
      continue;
    }
    const content: ContentPart[] = [];
    const files = m.parts.filter((p) => p.type === "file").length;
    for (const p of m.parts) {
      if (p.type === "file") {
        const cap = i >= fileFrom ? Math.max(8_000, Math.floor(fileCap / files)) : OLD_FILE_CHARS;
        content.push({ type: "text", text: await fileBlock(ctx, p, cap) });
        continue;
      }
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
              p.type === "text"
                ? p.text
                : p.type === "ui_event"
                  ? `[picked: ${p.label}]`
                  : p.type === "file"
                    ? `[attached file: ${p.name}]`
                    : ""
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
  /** Files attached to it (not photos). */
  files: number;
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
      files: m.parts.filter((p) => p.type === "file").length,
      event,
      message: m,
    };
  }
  return { text: "", images: 0, files: 0, event: null, message: null };
}
