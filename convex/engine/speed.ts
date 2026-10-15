import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, type ActionCtx } from "../_generated/server";
import { openuiCatalog } from "../ai/openui";
import { streamChat, type ChatMessage } from "../ai/openai";
import { buildRequest } from "../ai/reasoning";
import { blendSpeed, PROBE_TIMEOUT_MS, QUICK_MS } from "../lib/profileModel";
import { parseModelRef } from "../lib/util";
import type { Entity } from "../lib/validators";
import { modelAccess } from "./context";
import { profileBrief, profileRequest } from "./profile";
import { systemPrompt } from "./prompt";

/**
 * The speed probe (lib/profileModel.ts): how soon each of a few of the user's models starts
 * writing a profile at low effort. It asks under the instructions a profile is written with,
 * since some models answer a one-line question in a second and take six to read those. Run when
 * a profile opens and the readings are missing or a day old; each try stops at the first words.
 */

const SUBJECT: Entity = {
  name: "Mount Kilimanjaro",
  kind: "place",
  hint: "tallest mountain in Africa",
};

const question = (): ChatMessage[] => [
  {
    role: "system",
    content: systemPrompt({
      now: Date.now(),
      customInstructions: "",
      memories: [],
      incognito: false,
      cards: openuiCatalog(),
      // The same instructions a profile gets, up to its search results.
      web: "provided",
      locationTool: false,
      subagents: "off",
      memoryTool: false,
      extra: [profileBrief(SUBJECT, undefined, false)],
    }),
  },
  { role: "user", content: profileRequest(SUBJECT) },
];

/** Milliseconds to the first words, or PROBE_TIMEOUT_MS when none came. */
async function firstWords(ctx: ActionCtx, userId: Id<"users">, ref: string): Promise<number> {
  const m = await modelAccess(ctx, userId, ref);
  if (!m) return PROBE_TIMEOUT_MS;
  const built = buildRequest({
    model: m.modelId,
    profile: m.profile,
    level: "low",
    difficulty: "easy",
    messages: question(),
    maxTokens: 400,
  });
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), PROBE_TIMEOUT_MS);
  const sent = Date.now();
  try {
    for await (const ev of streamChat(m.endpoint, built.body, stop.signal)) {
      if (ev.type === "text" && ev.delta.trim()) return Date.now() - sent;
    }
  } catch {
    // A refused or failed request is as good as slow here.
  } finally {
    clearTimeout(timer);
    // The first words are all a reading needs.
    stop.abort();
  }
  return PROBE_TIMEOUT_MS;
}

export const probe = internalAction({
  args: { userId: v.id("users"), refs: v.array(v.string()) },
  handler: async (ctx, { userId, refs }) => {
    // One at a time: a relay slows every request it's handed at once, which would time the relay.
    const readings: { ref: string; firstTextMs: number }[] = [];
    for (const ref of refs) {
      // Its queue adds seconds at random, so a slow start gets a second try and the better counts.
      const first = await firstWords(ctx, userId, ref);
      const best =
        first <= QUICK_MS || first >= PROBE_TIMEOUT_MS
          ? first
          : Math.min(first, await firstWords(ctx, userId, ref));
      readings.push({ ref, firstTextMs: best });
    }
    await ctx.runMutation(internal.engine.speed.record, { userId, readings });
    console.log(`[speed] ${readings.map((r) => `${r.ref}=${r.firstTextMs}ms`).join(" ")}`);
  },
});

export const record = internalMutation({
  args: {
    userId: v.id("users"),
    readings: v.array(v.object({ ref: v.string(), firstTextMs: v.number() })),
  },
  handler: async (ctx, { userId, readings }) => {
    const now = Date.now();
    for (const r of readings) {
      const m = parseModelRef(r.ref);
      if (!m) continue;
      const row = await ctx.db
        .query("modelSpeeds")
        .withIndex("by_user_model", (q) =>
          q.eq("userId", userId).eq("providerId", m.providerId).eq("modelId", m.modelId)
        )
        .first();
      const firstTextMs = blendSpeed(row ?? undefined, r.firstTextMs, now);
      if (row) await ctx.db.patch(row._id, { firstTextMs, at: now });
      else await ctx.db.insert("modelSpeeds", { userId, ...m, firstTextMs, at: now });
    }
  },
});
