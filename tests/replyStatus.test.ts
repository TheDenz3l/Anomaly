import { describe, expect, it } from "vitest";
import {
  contentMoving,
  displayParts,
  formatClock,
  formatDuration,
  reasoningHeadline,
  replyStatus,
} from "@/lib/replyStatus";
import type { Message, Part, SearchPart, Source } from "@/lib/types";

const meta = { modelRef: "p/m", levelRequested: "medium", levelSent: "medium", reasoningTokens: 0 };

function reply(parts: Part[], extra: Partial<Message> = {}): Message {
  return {
    id: "m1",
    threadId: "t1",
    role: "assistant",
    parts,
    createdAt: 1000,
    status: "streaming",
    meta,
    ...extra,
  };
}

const source = (n: number): Source => ({
  id: `s${n}`,
  url: `https://site${n}.com/page`,
  title: `Page ${n}`,
  snippet: "",
  origin: "native",
});

const search = (phase: SearchPart["phase"], sources: Source[] = []): SearchPart => ({
  id: `search-${phase}`,
  type: "search",
  queries: ["best ramen tokyo"],
  sources,
  phase,
});

describe("replyStatus while streaming", () => {
  it("thinks before the first output on a reasoning model, works on the rest", () => {
    expect(replyStatus(reply([]))).toMatchObject({
      phase: "thinking",
      label: "Thinking",
      live: true,
    });
    const off = reply([], { meta: { ...meta, levelSent: "off" } });
    expect(replyStatus(off)).toMatchObject({ phase: "working", label: "Working" });
  });

  it("shows the latest reasoning headline as the detail", () => {
    const text = "**Planning the trip**\nfirst...\n\n**Checking opening hours**\nmore";
    const s = replyStatus(reply([{ id: "r", type: "thinking", text, done: false }]));
    expect(s).toMatchObject({
      phase: "thinking",
      detail: "Checking opening hours",
      expandable: true,
    });
  });

  it("follows a search from the query to the pages it reads", () => {
    expect(replyStatus(reply([search("searching")]))).toMatchObject({
      phase: "searching",
      detail: "best ramen tokyo",
    });
    const reading = replyStatus(reply([search("reading", [source(1), source(2)])]));
    expect(reading).toMatchObject({ phase: "reading", label: "Reading" });
    expect(reading?.sites).toEqual(["https://site1.com/page", "https://site2.com/page"]);
  });

  it("writes while text streams and builds while a card does", () => {
    expect(replyStatus(reply([{ id: "x", type: "text", text: "Hi" }]))?.phase).toBe("writing");
    const card: Part = {
      id: "c",
      type: "component",
      name: "Weather",
      props: {},
      status: "streaming",
      fallbackText: "",
    };
    expect(replyStatus(reply([card]))).toMatchObject({ phase: "building", detail: "the forecast" });
    const image: Part = {
      ...card,
      name: "ImageGeneration",
      status: "ready",
      props: { state: "working" },
    };
    expect(replyStatus(reply([image]))?.phase).toBe("imaging");
  });

  it("goes back to thinking between steps once a search is done", () => {
    expect(replyStatus(reply([search("done", [source(1)])]))?.phase).toBe("thinking");
  });
});

describe("replyStatus once the reply ends", () => {
  it("says how long the reply took and counts its sources", () => {
    const s = replyStatus(
      reply([search("done", [source(1), source(2), source(3)])], { status: "done", workedMs: 9400 })
    );
    expect(s).toMatchObject({ phase: "done", live: false, label: "Worked for 9s", sourceCount: 3 });
  });

  it("falls back to the reasoning time for replies from before replies kept their time", () => {
    const s = replyStatus(
      reply([{ id: "r", type: "thinking", text: "", done: true, durationMs: 4200 }], {
        status: "done",
      })
    );
    expect(s).toMatchObject({ label: "Thought for 4s", expandable: false });
  });

  it("has no line for an old plain answer", () => {
    expect(
      replyStatus(reply([{ id: "x", type: "text", text: "Hi" }], { status: "done" }))
    ).toBeNull();
  });

  it("marks stopped and failed replies", () => {
    expect(replyStatus(reply([], { status: "stopped", workedMs: 3000 }))).toMatchObject({
      phase: "stopped",
      label: "Stopped after 3s",
    });
    expect(replyStatus(reply([], { status: "error" }))?.phase).toBe("error");
  });
});

describe("helpers", () => {
  it("folds later searches into the first and merges neighbouring reasoning", () => {
    const parts = displayParts([
      { id: "a", type: "thinking", text: "one", done: true, durationMs: 1000 },
      { id: "b", type: "thinking", text: "two", done: true, durationMs: 2000 },
      search("done", [source(1)]),
      { id: "x", type: "text", text: "Hi" },
      { ...search("reading", [source(1), source(2)]), id: "search-2", queries: ["more"] },
    ]);
    expect(parts.map((p) => p.type)).toEqual(["thinking", "search", "text"]);
    expect(parts[0]).toMatchObject({ text: "one\n\ntwo", durationMs: 3000 });
    expect(parts[1]).toMatchObject({ phase: "reading", queries: ["best ramen tokyo", "more"] });
    expect((parts[1] as SearchPart).sources).toHaveLength(2);
  });

  it("formats durations and the running clock", () => {
    expect(formatDuration(200)).toBe("1s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatClock(0)).toBe("0s");
    expect(formatClock(65)).toBe("1m 05s");
  });

  it("reads headlines only from bold lines on their own", () => {
    expect(reasoningHeadline("Some **inline** bold")).toBeUndefined();
    expect(reasoningHeadline("**Weighing options:**\ntext")).toBe("Weighing options");
  });

  it("treats text and building cards as moving, steps as not", () => {
    expect(contentMoving({ id: "x", type: "text", text: "" })).toBe(true);
    expect(contentMoving(search("reading"))).toBe(false);
    expect(contentMoving(undefined)).toBe(false);
  });
});
