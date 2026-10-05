import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { decisionProvider } from "./ai/decisions";
import { authHeaders, joinUrl } from "./ai/openai";
import { requireUser } from "./lib/auth";
import { endpointFor } from "./lib/endpoint";
import { parseModelRef } from "./lib/util";

/**
 * Voice (PRD §3.11). On-device recognition and expo-speech are the defaults (client-side);
 * these actions back the optional "endpoint" modes and hands-free turn-taking.
 */

async function voiceEndpoint(
  ctx: Parameters<typeof endpointFor>[0],
  userId: Parameters<typeof endpointFor>[1],
  ref: string | null,
  fallbackModel: string
) {
  const settings = await ctx.runQuery(internal.settings.forUser, { userId });
  const chosen = ref ?? settings.defaultModelRef;
  const parsed = chosen ? parseModelRef(chosen) : null;
  if (!parsed) throw new ConvexError("Pick a provider for voice in Settings.");
  const ep = await endpointFor(ctx, userId, parsed.providerId);
  if (!ep) throw new ConvexError("Voice provider not found.");
  return { ep, model: ref ? parsed.modelId : fallbackModel, settings };
}

export const transcribe = action({
  args: { storageId: v.id("_storage"), language: v.optional(v.string()) },
  handler: async (ctx, { storageId, language }): Promise<{ text: string }> => {
    const userId = await requireUser(ctx);
    const settings = await ctx.runQuery(internal.settings.forUser, { userId });
    const { ep, model } = await voiceEndpoint(
      ctx,
      userId,
      settings.transcriptionModelRef,
      "whisper-1"
    );
    const blob = await ctx.storage.get(storageId);
    if (!blob) throw new ConvexError("Recording not found.");
    try {
      const form = new FormData();
      form.append("file", blob, "audio.m4a");
      form.append("model", model);
      if (language) form.append("language", language);
      const res = await fetch(joinUrl(ep.baseUrl, "/audio/transcriptions"), {
        method: "POST",
        headers: authHeaders(ep, false),
        body: form,
      });
      const body = await res.text();
      if (!res.ok)
        throw new ConvexError(`Transcription failed (${res.status}): ${body.slice(0, 200)}`);
      const json = JSON.parse(body);
      return { text: String(json.text ?? "") };
    } finally {
      await ctx.storage.delete(storageId);
    }
  },
});

export const speak = action({
  args: { text: v.string(), voice: v.optional(v.string()) },
  handler: async (ctx, { text, voice }): Promise<{ url: string | null }> => {
    const userId = await requireUser(ctx);
    const settings = await ctx.runQuery(internal.settings.forUser, { userId });
    const { ep, model } = await voiceEndpoint(ctx, userId, settings.speechModelRef, "tts-1");
    const input = text.slice(0, 4000);
    if (!input.trim()) return { url: null };
    const res = await fetch(joinUrl(ep.baseUrl, "/audio/speech"), {
      method: "POST",
      headers: authHeaders(ep),
      body: JSON.stringify({
        model,
        input,
        voice: voice ?? settings.voiceId ?? "alloy",
        response_format: "mp3",
      }),
    });
    if (!res.ok)
      throw new ConvexError(`Speech failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const audio = await res.blob();
    const storageId = await ctx.storage.store(
      new Blob([await audio.arrayBuffer()], { type: "audio/mpeg" })
    );
    return { url: await ctx.storage.getUrl(storageId) };
  },
});

/** Hands-free mode: should the app keep listening, send, or stop speaking? */
export const turnTaking = action({
  args: { transcript: v.string(), silenceMs: v.number() },
  handler: async (
    ctx,
    args
  ): Promise<{ choice: "continue" | "end" | "interrupt"; confidence: number }> => {
    await requireUser(ctx);
    const d = await decisionProvider().turnTaking(args);
    return { choice: d.choice, confidence: d.confidence };
  },
});
