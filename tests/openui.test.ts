import { createStreamingParser } from "@openuidev/lang-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasFollowUps,
  openuiCatalog,
  OpenUICard,
  openuiDirective,
  readOpenUI,
} from "../convex/ai/openui";
import { OPENUI_TOOLS } from "../convex/ai/openuiTools";
import { registryProfile } from "../convex/ai/registry";
import type { Engine } from "../convex/engine/context";
import { runModelLoop } from "../convex/engine/loop";
import type { Sink } from "../convex/engine/writer";
import type { Part } from "../convex/lib/validators";
import { SourceCollector } from "../convex/web/sources";
import { openuiLibrary, openuiSource } from "../src/genui/openui/library";
import { collectArtifacts } from "../src/lib/artifacts";
import type { Message, Thread } from "../src/lib/types";

/** The ```openui examples in the model's prompt, as the model would write them. */
function promptExamples(): string[] {
  return [...openuiCatalog().matchAll(/```openui\n([\s\S]*?)```/g)].map((m) => m[1]);
}

describe("the card prompt", () => {
  it("documents the library, actions, live data and edits", () => {
    const p = openuiCatalog();
    expect(p).toContain("Hero(title: string, subtitle?: string, image?: string)");
    expect(p).toContain("Map(places: any[], title?: string, center?: any)");
    expect(p).toContain("@ToAssistant");
    expect(p).toContain("$binding");
    expect(p).toContain("weather({location: string})");
    expect(p).toContain("```openui-edit");
    expect(promptExamples()).toHaveLength(3);
  });

  it("parses its own examples without dropping anything", () => {
    for (const ex of promptExamples()) {
      const r = readOpenUI(`\n${ex}`);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) expect(r.issues).toEqual([]);
    }
  });

  it("names the component the router is sure of", () => {
    expect(openuiDirective("visual", "Compare")).toContain("a Compare");
    expect(openuiDirective("visual", "Blocks")).not.toContain("Build it around");
  });
});

describe("reading a card", () => {
  it("reads an openui-lang fence tag and gives a voice fallback", () => {
    const r = readOpenUI('-lang\nroot = Root([c])\nc = Callout("Gravity did it.", "note")\n');
    expect(r).toMatchObject({ ok: true, fallbackText: "Gravity did it." });
    expect(openuiSource("-lang\nroot = Root([])")).toBe("root = Root([])");
  });

  it("rejects a block with nothing to draw", () => {
    expect(readOpenUI("\nThe pyramids were built by paid crews.\n").ok).toBe(false);
    expect(readOpenUI("\n\n").ok).toBe(false);
  });

  it("knows when a card brings its own follow-ups", () => {
    expect(hasFollowUps('root = Root([b])\nb = Buttons([Button("More")])')).toBe(true);
    expect(hasFollowUps('root = Root([c])\nc = Callout("x")')).toBe(false);
  });

  it("draws top-level children one by one as the block streams", () => {
    const src = promptExamples()[0];
    const sp = createStreamingParser(openuiLibrary().toJSONSchema(), "Root");
    const counts: number[] = [];
    for (let i = 0; i < src.length; i += 30) {
      const n =
        (sp.push(src.slice(i, i + 30)).root?.props.children as unknown[] | undefined)?.filter(
          Boolean
        ).length ?? 0;
      if (counts.at(-1) !== n) counts.push(n);
    }
    expect(counts.at(-1)).toBe(7);
    expect(counts.length).toBeGreaterThan(3);
  });
});

describe("photos for a card", () => {
  const program = [
    "root = Root([hero, steps])",
    'hero = Hero("Kyoto", "Two days", "Fushimi Inari torii gates Kyoto")',
    'steps = Steps([Step("Fushimi Inari", "Walk the gates", "7:00", "Fushimi Inari torii gates"), Step("Gion", "Dusk", "17:00", "https://example.com/gion.jpg")])',
  ].join("\n");

  it("gives each phrase a different photo, in the order the card names them", async () => {
    // Both phrases find the same article first: the second gets its next-best photo.
    const finder = vi.fn(async (q: string) =>
      q.includes("Kyoto")
        ? ["https://img/a.jpg", "https://img/b.jpg"]
        : ["https://img/a.jpg", "https://img/c.jpg"]
    );
    const card = new OpenUICard({ findPhotos: finder });
    expect(card.finish(`\n${program}`).ok).toBe(true);
    await card.settled();
    expect(card.photos()).toEqual([
      { q: "Fushimi Inari torii gates Kyoto", url: "https://img/a.jpg" },
      { q: "Fushimi Inari torii gates", url: "https://img/c.jpg" },
      { q: "https://example.com/gion.jpg", url: "https://example.com/gion.jpg" },
    ]);
    // A URL is shown as written, never looked up.
    expect(finder).toHaveBeenCalledTimes(2);
  });

  it("waits for a statement to finish before looking up its phrase", () => {
    const finder = vi.fn(async () => ["https://img/a.jpg"]);
    const card = new OpenUICard({ findPhotos: finder });
    card.update('\nroot = Root([hero])\nhero = Hero("Kyoto", "Two days", "Fushimi In');
    expect(finder).not.toHaveBeenCalled();
    card.update('\nroot = Root([hero])\nhero = Hero("Kyoto", "Two days", "Fushimi Inari")\n');
    expect(finder).toHaveBeenCalledWith("Fushimi Inari", { kind: "photo" });
  });

  it("looks up shop photos for products and the items compared beside them", async () => {
    const finder = vi.fn(async () => [] as string[]);
    const card = new OpenUICard({ findPhotos: finder });
    card.finish(
      [
        "root = Root([buy, vs, h])",
        'h = Hero("Headphones", null, "Studio headphones")',
        'buy = Products([Product("XM5", 189, "EUR", "idealo.de", null, "Sony WH-1000XM5")])',
        'vs = Compare([Item("XM5", null, "Sony XM5"), Item("PX7", null, "B&W PX7")], [Row("Price", ["€189", "€179"])])',
      ].join("\n")
    );
    await card.settled();
    expect(finder).toHaveBeenCalledWith("Sony WH-1000XM5", { kind: "product" });
    expect(finder).toHaveBeenCalledWith("Sony XM5", { kind: "product" });
    expect(finder).toHaveBeenCalledWith("Studio headphones", { kind: "photo" });
  });

  it("never shows a photo the chat already showed, except a product's own", async () => {
    const finder = vi.fn(async (q: string) =>
      q === "Bread" ? ["https://img/seen.jpg", "https://img/new.jpg"] : ["https://img/seen.jpg"]
    );
    const card = new OpenUICard({
      findPhotos: finder,
      seen: new Set(["https://img/seen.jpg", "https://img/old.jpg"]),
    });
    card.finish(
      [
        "root = Root([a, b, c, d])",
        'a = Image("Bread")',
        'b = Image("Wheat")',
        'c = Image("https://img/old.jpg")',
        'd = Products([Product("Loaf", 3, "EUR", "Shop", null, "Loaf of bread")])',
      ].join("\n")
    );
    await card.settled();
    expect(card.photos()).toEqual([
      { q: "Bread", url: "https://img/new.jpg" },
      { q: "Wheat", url: null },
      { q: "https://img/old.jpg", url: null },
      { q: "Loaf of bread", url: "https://img/seen.jpg" },
    ]);
  });

  it("asks for a screenshot of the page a Screenshot names", async () => {
    const finder = vi.fn(async () => ["https://storage/shot.png"]);
    const card = new OpenUICard({ findPhotos: finder });
    card.finish('root = Root([s])\ns = Screenshot("https://linear.app", "Linear\'s home page")');
    await card.settled();
    expect(finder).toHaveBeenCalledWith("https://linear.app", { kind: "screenshot" });
    expect(card.photos()).toEqual([
      { q: "screenshot:https://linear.app", url: "https://storage/shot.png" },
    ]);
  });

  it("settles a phrase with nothing found as no photo", async () => {
    const card = new OpenUICard({ findPhotos: async () => [] });
    card.finish('\nroot = Root([i])\ni = Image("An abstract idea")');
    await card.settled();
    expect(card.photos()).toEqual([{ q: "An abstract idea", url: null }]);
  });
});

describe("changing the last card", () => {
  const base = [
    'root = Root([hero, days, more], "sand")',
    'hero = Hero("2 Days in Kyoto")',
    'days = Tabs([Tab("Day 1", [d1]), Tab("Day 2", [d2])])',
    'd1 = Steps([Step("Fushimi Inari")])',
    'd2 = Steps([Step("Arashiyama")])',
    'more = Buttons([Button("Add Nara")])',
  ].join("\n");

  it("merges an edit into the card it changes", () => {
    const card = new OpenUICard({ base: { source: base } });
    const r = card.finish(
      '-edit\ndays = Tabs([Tab("Day 1", [d1]), Tab("Day 2", [d2]), Tab("Nara", [d3])])\nd3 = Steps([Step("Todai-ji")])\n'
    );
    expect(r.ok).toBe(true);
    expect(card.source).toContain('hero = Hero("2 Days in Kyoto")');
    expect(card.source).toContain('Tab("Nara", [d3])');
    expect(card.source).toContain('d3 = Steps([Step("Todai-ji")])');
  });

  it("keeps the photos the card already showed when it's edited", async () => {
    const finder = vi.fn(async () => ["https://img/new.jpg"]);
    const card = new OpenUICard({
      base: {
        source: base.replace(
          'Hero("2 Days in Kyoto")',
          'Hero("2 Days in Kyoto", null, "Kyoto skyline")'
        ),
        photos: [{ q: "Kyoto skyline", url: "https://img/kyoto.jpg" }],
      },
      findPhotos: finder,
      seen: new Set(["https://img/kyoto.jpg"]),
    });
    card.finish('-edit\nd2 = Steps([Step("Arashiyama", null, null, "Bamboo grove")])\n');
    await card.settled();
    expect(card.photos()).toEqual([
      { q: "Kyoto skyline", url: "https://img/kyoto.jpg" },
      { q: "Bamboo grove", url: "https://img/new.jpg" },
    ]);
    expect(finder).toHaveBeenCalledTimes(1);
  });

  it("treats a plain block as a new card even when there was one before", () => {
    const card = new OpenUICard({ base: { source: base } });
    card.finish('\nroot = Root([c])\nc = Callout("Something else")\n');
    expect(card.source).not.toContain("Kyoto");
  });
});

describe("live data tools", () => {
  it("check their arguments before running", () => {
    expect(OPENUI_TOOLS.places.args.safeParse({ kind: "cafe", near: "Lisbon" }).success).toBe(true);
    expect(OPENUI_TOOLS.places.args.safeParse({ kind: "casino", near: "Lisbon" }).success).toBe(
      false
    );
    expect(OPENUI_TOOLS.weather.args.safeParse({}).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ cards in the reply stream */

const sse = (chunks: string[]) =>
  new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const finish = () =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
/** Splits text into small deltas, the way a model streams it. */
const stream = (text: string, size = 7) => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(delta(text.slice(i, i + size)));
  return out;
};

class MemorySink implements Sink {
  parts: Part[] = [];
  stopped = false;
  /** Every source the card showed while it streamed. */
  sources: string[] = [];
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
  update(id: string, fn: (p: Part) => Part) {
    this.parts = this.parts.map((p) => (p.id === id ? fn(p) : p));
    const p = this.get(id);
    const source = (p?.type === "component" && (p.props as { source?: string }).source) || "";
    if (source && this.sources.at(-1) !== source) this.sources.push(source);
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

const engine = {
  profile: registryProfile("https://api.example.com/v1", "gpt-4o"),
  modelId: "gpt-4o",
  endpoint: { baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
} as unknown as Engine;

const loop = (sink: Sink, extra: { cardBase?: { source: string } } = {}) =>
  runModelLoop({
    engine,
    sink,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "How were the pyramids built?" },
    ],
    tools: [],
    cards: true,
    findPhotos: async (q) => [`https://img/${encodeURIComponent(q)}.jpg`],
    level: "off",
    difficulty: "easy",
    sources: new SourceCollector(),
    ...extra,
  });

const program = [
  'root = Root([hero, short], "sand")',
  'hero = Hero("How the Pyramids Were Built", "Copper, sledges, ramps", "Great Pyramid of Giza")',
  'short = Callout("Paid crews hauled blocks up ramps.", "note")',
].join("\n");

afterEach(() => vi.unstubAllGlobals());

describe("cards in the reply stream", () => {
  it("draws text, card and text from one model call, with the card's photos", async () => {
    const fetch = vi.fn(async () =>
      sse([...stream(`Here's how.\n\n\`\`\`openui\n${program}\n\`\`\`\n\nAsk me more.`), finish()])
    );
    vi.stubGlobal("fetch", fetch);
    const sink = new MemorySink();
    const result = await loop(sink);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sink.parts.map((p) => p.type)).toEqual(["text", "component", "text"]);
    const card = sink.parts[1] as Extract<Part, { type: "component" }>;
    expect(card).toMatchObject({
      name: "OpenUI",
      status: "ready",
      fallbackText: "Paid crews hauled blocks up ramps.",
    });
    expect(card.props).toMatchObject({
      source: program,
      photos: [{ q: "Great Pyramid of Giza", url: "https://img/Great%20Pyramid%20of%20Giza.jpg" }],
      photosDone: true,
    });
    // The card grew on screen while it streamed, before the block closed.
    expect(sink.sources.length).toBeGreaterThan(1);
    expect((sink.parts[0] as { text: string }).text).not.toContain("```");
    expect(result.componentsShown).toEqual(["OpenUI"]);
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
    );
    expect(body.tools ?? []).toEqual([]);
  });

  it("merges an edit block into the last card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          ...stream('Added it.\n```openui-edit\nshort = Callout("Now with ramps.", "tip")\n```'),
          finish(),
        ])
      )
    );
    const sink = new MemorySink();
    await loop(sink, { cardBase: { source: program } });
    const card = sink.parts.find((p) => p.type === "component") as Extract<
      Part,
      { type: "component" }
    >;
    expect(card.status).toBe("ready");
    const source = (card.props as { source: string }).source;
    expect(source).toContain("How the Pyramids Were Built");
    expect(source).toContain('short = Callout("Now with ramps.", "tip")');
  });

  it("marks a block with nothing to draw as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse([...stream("```openui\nnot a program at all\n```"), finish()]))
    );
    const sink = new MemorySink();
    await loop(sink);
    expect(sink.parts.find((p) => p.type === "component")).toMatchObject({ status: "invalid" });
  });

  it("leaves other code blocks in the text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse([...stream("Run:\n```bash\nls\n```\nDone."), finish()]))
    );
    const sink = new MemorySink();
    await loop(sink);
    expect(sink.parts.map((p) => p.type)).toEqual(["text"]);
    expect((sink.parts[0] as { text: string }).text).toContain("```bash\nls\n```");
  });
});

describe("cards in Artifacts", () => {
  const thread = { id: "t1", title: "Chat title", incognito: false } as unknown as Thread;
  const message = (source: string) =>
    ({
      id: "m1",
      threadId: "t1",
      role: "assistant",
      status: "done",
      createdAt: 1,
      parts: [
        {
          id: "c1",
          type: "component",
          name: "OpenUI",
          props: { source },
          status: "ready",
          fallbackText: "",
        },
      ],
    }) as unknown as Message;
  const listed = (source: string) =>
    collectArtifacts({ t1: thread }, { t1: [message(source)] })[0] as Record<string, unknown>;

  it("names a card by its cover and sorts it by what it does", () => {
    expect(
      listed(
        'root = Root([h, w])\nh = Hero("A Weekend \\"Away\\"")\nw = Query("weather", {location: "Lisbon"}, null)'
      )
    ).toMatchObject({
      title: 'A Weekend "Away"',
      kind: "Live app",
      group: "apps",
    });
    expect(
      listed('root = Root([c])\nc = Compare([Item("A"), Item("B")], [Row("x", ["1", "2"])])')
    ).toMatchObject({
      title: "Chat title",
      kind: "Comparison",
      group: "data",
    });
    expect(listed('root = Root([s])\ns = Screenshot("https://linear.app")')).toMatchObject({
      kind: "Website",
    });
    expect(listed('root = Root([q])\nq = Quiz("Why?", ["a", "b"], 0)')).toMatchObject({
      kind: "Lesson",
    });
  });
});
