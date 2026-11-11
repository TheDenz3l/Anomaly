import { afterEach, describe, expect, it, vi } from "vitest";
import { registryProfile } from "../convex/ai/registry";
import type { Engine } from "../convex/engine/context";
import { flattenTools, runModelLoop, type LoopTool } from "../convex/engine/loop";
import type { Sink } from "../convex/engine/writer";
import type { Part } from "../convex/lib/validators";
import { SourceCollector } from "../convex/web/sources";

class TextSink implements Sink {
  parts: Part[] = [];
  stopped = false;
  text(d: string) {
    const last = this.parts[this.parts.length - 1];
    if (last?.type === "text") last.text += d;
    else this.parts.push({ id: `t${this.parts.length}`, type: "text", text: d });
  }
  thinking() {}
  add(p: Part) {
    this.parts.push(p);
    return p.id;
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
const searchCall = (id: string) =>
  sse([
    event({
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name: "web_search", arguments: '{"query":"x"}' },
        },
      ],
    }),
    event({}, "tool_calls"),
    "data: [DONE]\n\n",
  ]);
const answer = (text: string) =>
  sse([event({ content: text }), event({}, "stop"), "data: [DONE]\n\n"]);

const search: LoopTool = {
  def: {
    type: "function",
    function: { name: "web_search", description: "", parameters: { type: "object" } },
  } as LoopTool["def"],
  run: async () => ({ content: "Results: she is a tech executive.", web: "results" }),
};

const run = (sink: Sink) =>
  runModelLoop({
    engine: {
      profile: registryProfile("https://api.example.com/v1", "gpt-4o"),
      modelId: "gemini-4-argon",
      endpoint: { baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
    } as unknown as Engine,
    sink,
    messages: [{ role: "user", content: "Who is this?" }],
    tools: [search],
    webRounds: 1,
    level: "off",
    difficulty: "easy",
    sources: new SourceCollector(),
  });

afterEach(() => vi.unstubAllGlobals());

describe("a final step that only calls a tool", () => {
  it("gets asked again for the answer instead of ending empty", async () => {
    const replies = [searchCall("c1"), searchCall("c2"), answer("She's a tech executive.")];
    const fetch = vi.fn(async () => replies.shift()!);
    vi.stubGlobal("fetch", fetch);
    const sink = new TextSink();
    const result = await run(sink);
    expect(sink.parts).toMatchObject([{ type: "text", text: "She's a tech executive." }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const third = JSON.parse(
      (fetch.mock.calls[2] as unknown as [string, RequestInit])[1].body as string
    );
    expect(third.tools).toBeUndefined();
    expect(third.messages.at(-1).content).toContain("No more tools are available");
    expect(result.timings[1].finish).toBe("stray_tool_calls(web_search)");
  });

  it("gets the tool exchanges as plain text on the second retry", async () => {
    const replies = [searchCall("c1"), searchCall("c2"), searchCall("c3"), answer("Done.")];
    const fetch = vi.fn(async () => replies.shift()!);
    vi.stubGlobal("fetch", fetch);
    const sink = new TextSink();
    await run(sink);
    expect(sink.parts).toMatchObject([{ type: "text", text: "Done." }]);
    const last = JSON.parse(
      (fetch.mock.calls[3] as unknown as [string, RequestInit])[1].body as string
    );
    expect(JSON.stringify(last.messages)).not.toContain("tool_call");
    expect(JSON.stringify(last.messages)).toContain("[Tool result]");
  });

  it("stops after two retries", async () => {
    const fetch = vi.fn(async () => searchCall("c"));
    vi.stubGlobal("fetch", fetch);
    await run(new TextSink());
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("flattenTools", () => {
  it("writes calls and results as text and keeps everything else", () => {
    const out = flattenTools([
      { role: "system", content: "sys" },
      { role: "user", content: "Who?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "web_search", arguments: '{"q":1}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "found" },
    ]);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "Who?" },
      { role: "assistant", content: '[Called web_search({"q":1})]' },
      { role: "user", content: "[Tool result]\nfound" },
    ]);
  });
});
