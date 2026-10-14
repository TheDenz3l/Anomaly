// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server";
import { toChatMessages } from "../convex/engine/history";
import { pickVisionModel, rankVisionModels, type VisionCandidate } from "../convex/lib/vision";
import { signedIn } from "./convex";

const m = (
  providerId: string,
  id: string,
  vision: boolean,
  source = "registry"
): VisionCandidate => ({
  providerId,
  id,
  name: id,
  profile: { features: { vision }, source },
});

describe("pickVisionModel", () => {
  const current = { providerId: "xai", id: "grok-text" };

  it("prefers a vision model from the provider the user picked", () => {
    const pick = pickVisionModel(
      [
        m("openrouter", "google/gemini-2.5-flash", true),
        m("xai", "grok-4", true),
        m("xai", "grok-text", false),
      ],
      current
    );
    expect(pick?.id).toBe("grok-4");
  });

  it("falls back to another provider, and to nothing when none can see", () => {
    expect(pickVisionModel([m("openai", "gpt-4o-mini", true)], current)?.providerId).toBe("openai");
    expect(
      pickVisionModel([m("xai", "grok-text", false), m("openai", "o3-mini", false)], current)
    ).toBeNull();
  });

  it("skips the current model, unusable providers and image generators", () => {
    const pick = pickVisionModel(
      [m("xai", "grok-2-image", true), m("openai", "gpt-image-1", true), m("down", "gpt-4o", true)],
      current,
      { usable: (id) => id !== "down" }
    );
    expect(pick).toBeNull();
  });

  it("aims for the fast, cheap tier over flagships, even ones already verified", () => {
    const list = [
      m("7api", "claude-fable-5", true, "probe"),
      m("7api", "claude-opus-5-5", true),
      m("7api", "claude-sonnet-5-5", true),
      m("7api", "claude-haiku-5-5", true),
    ];
    expect(pickVisionModel(list, { providerId: "7api", id: "glm-5.3-flash" })?.id).toBe(
      "claude-haiku-5-5"
    );
  });

  it("reads gemini as gemini, not mini, and lets published prices settle a tier", () => {
    const priced = (id: string, perMillion: number) => ({
      ...m("or", id, true),
      pricing: { prompt: perMillion / 1e6, completion: (perMillion * 4) / 1e6 },
    });
    const list = [priced("google/gemini-2.5-pro", 1.25), priced("google/gemini-2.5-flash", 0.3)];
    expect(pickVisionModel(list, { providerId: "or", id: "x" })?.id).toBe(
      "google/gemini-2.5-flash"
    );
    const ranked = rankVisionModels(
      [priced("openai/gpt-6-luna", 0.1), priced("openai/gpt-6-luna-mini", 0.02)],
      { providerId: "or", id: "x" }
    );
    expect(ranked.map((x) => x.id)).toEqual(["openai/gpt-6-luna-mini", "openai/gpt-6-luna"]);
  });
});

describe("photo descriptions", () => {
  it("go to a model that can't see images in place of the photo", async () => {
    const msg = {
      role: "user",
      parts: [
        { id: "i1", type: "image", description: "A tweet that reads: hello", describedBy: "a/b" },
        { id: "t1", type: "text", text: "What does it say?" },
      ],
    } as unknown as Doc<"messages">;
    const out = await toChatMessages({} as ActionCtx, [msg], { vision: false, maxChars: 10_000 });
    expect(out.droppedImages).toBe(0);
    expect(out.messages[0].content).toContain("<photo_description>\nA tweet that reads: hello");
    expect(out.messages[0].content).toContain("What does it say?");
  });

  it("are cached on the photo they describe", async () => {
    const { t, userId } = await signedIn();
    const messageId = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("threads", {
        userId,
        title: "Photo",
        modelRef: "xai/grok-text",
        mode: "chat",
        reasoningLevel: "auto",
        incognito: false,
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("messages", {
        threadId,
        userId,
        role: "user",
        status: "done",
        parts: [
          { id: "i1", type: "image" },
          { id: "i2", type: "image" },
        ],
      });
    });
    await t.mutation(internal.engine.data.setImageDescriptions, {
      messageId,
      items: [{ partId: "i2", description: "A cat", by: "xai/grok-4" }],
    });
    const parts = (await t.run((ctx) => ctx.db.get(messageId)))!.parts;
    expect(parts[0]).toEqual({ id: "i1", type: "image" });
    expect(parts[1]).toMatchObject({ description: "A cat", describedBy: "xai/grok-4" });
  });
});
