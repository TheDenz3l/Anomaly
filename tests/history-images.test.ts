import { describe, expect, it } from "vitest";
import type { Doc } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server";
import { emptyReply } from "../convex/engine/finish";
import { MAX_IMAGES, recentImageIds, toChatMessages } from "../convex/engine/history";

const photo = (id: string) => ({ id, type: "image", uri: `https://example.com/${id}.jpg` });
const user = (parts: unknown[]) => ({ role: "user", parts }) as unknown as Doc<"messages">;
const say = (text: string) => user([{ id: `t-${text}`, type: "text", text }]);
const reply = (text: string) =>
  ({
    role: "assistant",
    parts: [{ id: `a-${text}`, type: "text", text }],
  }) as unknown as Doc<"messages">;

const images = (content: unknown) =>
  Array.isArray(content) ? content.filter((c) => c.type === "image_url").length : 0;

describe("photos in a chat", () => {
  it("stay in front of a model that can see them a few messages later", async () => {
    const history = [
      user([photo("p1"), { id: "t0", type: "text", text: "Who is this?" }]),
      reply("Someone in a white tuxedo."),
      say("That's not Asha Sharma?"),
      reply(""),
      say("Why, what's the issue?"),
    ];
    const out = await toChatMessages({} as ActionCtx, history, { vision: true, maxChars: 50_000 });
    expect(images(out.messages[0].content)).toBe(1);
    expect(JSON.stringify(out.messages)).not.toContain("can't see");
  });

  it("keep only the newest few, and say plainly why an older one isn't shown", async () => {
    const history = Array.from({ length: MAX_IMAGES + 1 }, (_, i) =>
      user([photo(`p${i}`), { id: `t${i}`, type: "text", text: `photo ${i}` }])
    );
    expect([...recentImageIds(history)]).toEqual(["p4", "p3", "p2", "p1"]);
    const out = await toChatMessages({} as ActionCtx, history, { vision: true, maxChars: 50_000 });
    const text = JSON.stringify(out.messages);
    expect(text).toContain("You saw it when it was sent");
    expect(text).not.toContain("can't see");
  });

  it("still tell a model that can't see that it can't, when nothing described the photo", async () => {
    const out = await toChatMessages({} as ActionCtx, [user([photo("p1")])], {
      vision: false,
      maxChars: 10_000,
    });
    expect(out.droppedImages).toBe(1);
    expect(out.messages[0].content).toContain("can't see");
  });
});

describe("emptyReply", () => {
  it("names the safety filter only when the provider says it stopped the reply", () => {
    expect(emptyReply("content_filter")).toContain("safety filter");
    expect(emptyReply("SAFETY")).toContain("safety filter");
    expect(emptyReply("stop")).toContain("couldn't put together an answer");
    expect(emptyReply()).toContain("couldn't put together an answer");
  });
});
