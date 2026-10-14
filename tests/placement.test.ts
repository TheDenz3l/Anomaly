import { afterEach, describe, expect, it, vi } from "vitest";
import { registryProfile } from "../convex/ai/registry";
import type { Engine } from "../convex/engine/context";
import { runModelLoop, type LoopTool } from "../convex/engine/loop";
import { CARD_TOPICS, CardPlacer, type Placed } from "../convex/engine/placement";
import type { Sink } from "../convex/engine/writer";
import type { Part } from "../convex/lib/validators";
import { SourceCollector } from "../convex/web/sources";

const movies = CARD_TOPICS.find_showtimes;

/** Streams text through a placer in small pieces and lays out what comes out. */
function layout(text: string, cards: string[], chunk = 3, block?: number): string {
  const p = new CardPlacer();
  for (const id of cards) p.hold(id, movies);
  const out: Placed[] = [];
  for (let i = 0; i < text.length; i += chunk) {
    if (block !== undefined && i === block)
      out.push(...p.beforeBlock(), { type: "card", id: "BLOCK" });
    out.push(...p.push(text.slice(i, i + chunk)));
  }
  out.push(...p.finish());
  return out.map((x) => (x.type === "text" ? x.text : `[${x.id}]`)).join("");
}

describe("placing a tool's cards in the reply", () => {
  it("puts them after the first paragraph of the section about them", () => {
    const text =
      "Two weeks is plenty.\n\n### 1. Places\nCentral Park.\n\n### 3. Movie night\nCatch an IMAX show.\n\n### 4. Plan\nTell me your dates.";
    expect(layout(text, ["shows", "map"])).toBe(
      "Two weeks is plenty.\n\n### 1. Places\nCentral Park.\n\n### 3. Movie night\nCatch an IMAX show.\n\n[shows][map]### 4. Plan\nTell me your dates."
    );
  });

  it("puts them after the opening paragraph when there are no sections", () => {
    expect(layout("Here's what's on tonight.\n\nTimes fill in as they're read.", ["shows"])).toBe(
      "Here's what's on tonight.\n\n[shows]Times fill in as they're read."
    );
  });

  it("puts them at the end of a one-paragraph reply", () => {
    expect(layout("Six films are playing near you.", ["shows"])).toBe(
      "Six films are playing near you.[shows]"
    );
  });

  it("puts them after a paragraph that opens on them in bold", () => {
    const text =
      "Intro.\n\n### Places\nThe park.\n\n**Movie night:** IMAX at Lincoln Square.\nMore.";
    expect(layout(text, ["shows"])).toBe(
      "Intro.\n\n### Places\nThe park.\n\n**Movie night:** IMAX at Lincoln Square.\n[shows]More."
    );
  });

  it("treats a line of bold words as a heading", () => {
    const text = "Intro.\n\n**Places**\nThe park.\n\n**Movies**\nIMAX.";
    expect(layout(text, ["shows"])).toBe(
      "Intro.\n\n**Places**\nThe park.\n\n**Movies**\nIMAX.[shows]"
    );
  });

  it("treats a heading that opens the reply as its title", () => {
    expect(
      layout("### Tonight in Brooklyn\n\nSix films are playing.\n\nTimes fill in.", ["shows"])
    ).toBe("### Tonight in Brooklyn\n\nSix films are playing.\n\n[shows]Times fill in.");
  });

  it("goes at the end when no section is about them", () => {
    expect(layout("### Places\nThe park.\n\n### Food\nPizza.", ["shows"])).toBe(
      "### Places\nThe park.\n\n### Food\nPizza.[shows]"
    );
  });

  it("lands in the same place however the text is chunked", () => {
    const text = "Intro here.\n\n### Movies near you\nIMAX.\n- a\n- b";
    const whole = layout(text, ["shows"], text.length);
    for (const chunk of [1, 2, 5, 9]) expect(layout(text, ["shows"], chunk)).toBe(whole);
  });

  it("go before a card the model writes after its opening paragraph", () => {
    const text = "Here's the plan.\n\nMore after the card.";
    expect(layout(text, ["shows"], 1, 18)).toBe(
      "Here's the plan.\n\n[shows][BLOCK]More after the card."
    );
  });

  it("leaves text alone when nothing is waiting", () => {
    const text = "### A\n**b** c\n\nd";
    expect(layout(text, [])).toBe(text);
  });
});

/* ------------------------------------------------------------------ in the reply stream */

class HoldingSink implements Sink {
  parts: Part[] = [];
  held = new Map<string, Part>();
  stopped = false;
  private n = 0;
  text(d: string) {
    const last = this.parts[this.parts.length - 1];
    if (last?.type === "text") last.text += d;
    else this.parts.push({ id: `t${this.n++}`, type: "text", text: d });
  }
  thinking() {}
  add(p: Part) {
    this.parts.push(p);
    return p.id;
  }
  hold(p: Part) {
    this.held.set(p.id, p);
    return p.id;
  }
  release(id: string) {
    const p = this.held.get(id);
    if (p) this.parts.push(p);
    this.held.delete(id);
  }
  isHeld(id: string) {
    return this.held.has(id);
  }
  update(id: string, fn: (p: Part) => Part) {
    this.parts = this.parts.map((p) => (p.id === id ? fn(p) : p));
  }
  get(id: string) {
    return this.parts.find((p) => p.id === id);
  }
  last() {
    return this.parts[this.parts.length - 1];
  }
  find(fn: (p: Part) => boolean) {
    return this.parts.find(fn);
  }
  closeThinking() {}
  remove(id: string) {
    this.parts = this.parts.filter((p) => p.id !== id);
  }
  async tick() {
    return false;
  }
}

const sse = (chunks: string[]) =>
  new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const event = (delta: object, finish?: string) =>
  `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;

afterEach(() => vi.unstubAllGlobals());

describe("a tool's cards in the reply stream", () => {
  it("wait for the section the model writes about them", async () => {
    const reply =
      "A great trip.\n\n### 1. Places\nThe park.\n\n### 2. Movie night\nIMAX it is.\n\n### 3. Plan\nDates?";
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        call++ === 0
          ? sse([
              event({
                tool_calls: [
                  {
                    index: 0,
                    id: "c1",
                    type: "function",
                    function: { name: "find_showtimes", arguments: '{"near":"New York"}' },
                  },
                ],
              }),
              event({}, "tool_calls"),
              "data: [DONE]\n\n",
            ])
          : sse([
              ...reply.match(/[\s\S]{1,4}/g)!.map((c) => event({ content: c })),
              event({}, "stop"),
              "data: [DONE]\n\n",
            ])
      )
    );
    const sink = new HoldingSink();
    const showtimes: LoopTool = {
      def: {
        type: "function",
        function: { name: "find_showtimes", description: "", parameters: { type: "object" } },
      } as LoopTool["def"],
      run: async () => {
        const id = sink.hold({
          id: "cmp_movies",
          type: "component",
          name: "MovieShowtimes",
          props: {},
          status: "ready",
          fallbackText: "",
        });
        return { content: "Shown.", cards: [id] };
      },
    };
    await runModelLoop({
      engine: {
        profile: registryProfile("https://api.example.com/v1", "gpt-4o"),
        modelId: "gpt-4o",
        endpoint: { baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
      } as unknown as Engine,
      sink,
      messages: [{ role: "user", content: "Trip to New York, a movie too" }],
      tools: [showtimes],
      level: "off",
      difficulty: "easy",
      sources: new SourceCollector(),
    });
    const order = sink.parts.map((p) => (p.type === "text" ? p.text : `[${p.id}]`));
    expect(order).toEqual([
      "A great trip.\n\n### 1. Places\nThe park.\n\n### 2. Movie night\nIMAX it is.\n\n",
      "[cmp_movies]",
      "### 3. Plan\nDates?",
    ]);
  });
});
