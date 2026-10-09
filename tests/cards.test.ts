// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { signedIn } from "./convex";

type T = Awaited<ReturnType<typeof signedIn>>["t"];

/** A chat holding one reply with an OpenUI card (and a Weather card a tool drew). */
async function chatWithCard(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const threadId = await ctx.db.insert("threads", {
      userId,
      title: "Bill",
      modelRef: "p/m",
      mode: "chat",
      reasoningLevel: "off",
      incognito: false,
      updatedAt: Date.now(),
    });
    const messageId = await ctx.db.insert("messages", {
      threadId,
      userId,
      role: "assistant",
      status: "done",
      parts: [
        {
          id: "cmp_card",
          type: "component",
          name: "OpenUI",
          props: {
            source: 'root = Root([s])\n$people = 4\ns = Slider($people, 1, 12, 1, "People")',
          },
          status: "ready",
          fallbackText: "A splitter.",
        },
        {
          id: "cmp_wx",
          type: "component",
          name: "Weather",
          props: {},
          status: "ready",
          fallbackText: "Sunny.",
        },
      ],
    });
    return { threadId, messageId };
  });
}

describe("a card's saved state", () => {
  it("is saved on the card for its owner", async () => {
    const { t, userId, as } = await signedIn();
    const { threadId, messageId } = await chatWithCard(t, userId);
    await as.mutation(api.messages.saveCardState, {
      threadId,
      componentId: "cmp_card",
      state: [
        { k: "$people", v: 9 },
        { k: "tabs", v: 2, field: true },
      ],
    });
    const m = await t.run((ctx) => ctx.db.get(messageId));
    const card = m!.parts[0] as { props: { source: string; state: unknown } };
    expect(card.props.state).toEqual([
      { k: "$people", v: 9 },
      { k: "tabs", v: 2, field: true },
    ]);
    // The program itself is untouched.
    expect(card.props.source).toContain("Slider($people");
  });

  it("can't be written to someone else's chat", async () => {
    const owner = await signedIn();
    const { threadId } = await chatWithCard(owner.t, owner.userId);
    const strangerId = await owner.t.run((ctx) => ctx.db.insert("users", {}));
    const stranger = owner.t.withIdentity({ subject: `${strangerId}|test-session` });
    await expect(
      stranger.mutation(api.messages.saveCardState, {
        threadId,
        componentId: "cmp_card",
        state: [{ k: "$people", v: 1 }],
      })
    ).rejects.toThrow(/Chat not found/);
  });

  it("only goes on OpenUI cards", async () => {
    const { t, userId, as } = await signedIn();
    const { threadId, messageId } = await chatWithCard(t, userId);
    await as.mutation(api.messages.saveCardState, {
      threadId,
      componentId: "cmp_wx",
      state: [{ k: "$x", v: 1 }],
    });
    const m = await t.run((ctx) => ctx.db.get(messageId));
    expect((m!.parts[1] as { props: object }).props).toEqual({});
  });
});

describe("rate limits", () => {
  const limits = (limit: number) => [{ key: "k:min", limit, windowMs: 60_000 }];

  it("allow up to the limit in a window, then say when to come back", async () => {
    const { t } = await signedIn();
    for (let i = 0; i < 3; i++)
      expect(await t.mutation(internal.rateLimit.hit, { limits: limits(3) })).toEqual({ ok: true });
    const refused = await t.mutation(internal.rateLimit.hit, { limits: limits(3) });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.retryAfterMs).toBeGreaterThan(0);
  });

  it("count a call against every limit only when all of them have room", async () => {
    const { t } = await signedIn();
    const both = [
      { key: "a", limit: 1, windowMs: 60_000 },
      { key: "b", limit: 5, windowMs: 60_000 },
    ];
    await t.mutation(internal.rateLimit.hit, { limits: both });
    expect((await t.mutation(internal.rateLimit.hit, { limits: both })).ok).toBe(false);
    // The refused call didn't use up b.
    const b = await t.run((ctx) =>
      ctx.db
        .query("rateLimits")
        .withIndex("by_key", (q) => q.eq("key", "b"))
        .first()
    );
    expect(b?.count).toBe(1);
  });
});

describe("card tools", () => {
  it("refuse tools that don't exist and arguments that don't fit", async () => {
    const { as } = await signedIn();
    await expect(as.action(api.cardTools.call, { name: "web_search", args: {} })).rejects.toThrow(
      /no "web_search" tool/
    );
    await expect(
      as.action(api.cardTools.call, { name: "places", args: { kind: "casino", near: "Lisbon" } })
    ).rejects.toThrow(/Bad arguments for places/);
  });

  it("need a signed-in user", async () => {
    const { t } = await signedIn();
    await expect(
      t.action(api.cardTools.call, { name: "weather", args: { location: "Lisbon" } })
    ).rejects.toThrow(/Sign in first/);
  });
});
