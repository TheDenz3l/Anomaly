import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBalance } from "../convex/ai/balance";
import { streamErrorStatus, toMessagesBody } from "../convex/ai/anthropic";
import {
  classifyError,
  complete,
  LlmError,
  requestJson,
  streamChat,
  type Endpoint,
} from "../convex/ai/openai";
import { mergeHeaders } from "../convex/providers";
import { formatAmount } from "../src/lib/balance";

const ep: Endpoint = { baseUrl: "https://api.example.com/v1", apiKey: "sk-test" };

const sse = (lines: string[], init: ResponseInit = {}) =>
  new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });

const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

async function collect(gen: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("classifyError", () => {
  it("treats running out of credit as permanent, not a rate limit", () => {
    const body = JSON.stringify({
      error: { code: "insufficient_quota", message: "You exceeded your current quota" },
    });
    expect(classifyError(429, body)).toBe("auth");
  });
  it("checks the status before the context-overflow wording", () => {
    expect(classifyError(429, "too many tokens per minute")).toBe("rate_limit");
    expect(classifyError(503, "maximum context length")).toBe("server");
    expect(classifyError(400, "maximum context length is 8192")).toBe("context_overflow");
  });
});

describe("streamChat", () => {
  it("sends nothing when the signal is already aborted", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const ac = new AbortController();
    ac.abort();
    expect(await collect(streamChat(ep, { model: "m" }, ac.signal))).toEqual([]);
    await expect(requestJson(ep, "/models", { signal: ac.signal })).rejects.toBeInstanceOf(
      LlmError
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a stream that ends without a finish as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse([chunk({ choices: [{ delta: { content: "Hi" } }] })]))
    );
    const err = await collect(streamChat(ep, { model: "m" })).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("network");
    expect(err.message).toBe("The provider stopped mid-reply.");
  });

  it("reads a last event that has no trailing newline", async () => {
    const last = `data: ${JSON.stringify({ choices: [{ delta: { content: "!" }, finish_reason: "stop" }] })}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse([chunk({ choices: [{ delta: { content: "Hi" } }] }), last]))
    );
    const res = await complete(ep, { model: "m" });
    expect(res.text).toBe("Hi!");
    expect(res.finish).toBe("stop");
  });

  it("maps stream error events by type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([chunk({ error: { type: "invalid_request_error", message: "bad field" } })])
      )
    );
    const err = await collect(streamChat(ep, { model: "m" })).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.kind).toBe("bad_param");
    expect(streamErrorStatus({ type: "authentication_error" })).toBe(401);
    expect(streamErrorStatus({ type: "rate_limit_error" })).toBe(429);
    expect(classifyError(streamErrorStatus({ type: "overloaded_error" }), "")).toBe("server");
    expect(classifyError(streamErrorStatus({ type: "api_error" }), "")).toBe("server");
  });

  it("cancels the body when the consumer stops early", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(chunk({ choices: [{ delta: { content: "a" } }] })));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }))
    );
    for await (const _ev of streamChat(ep, { model: "m" })) break;
    await new Promise((r) => setTimeout(r, 0));
    expect(cancel).toHaveBeenCalled();
  });

  it("gives up on an error body that never finishes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream({
          start(c) {
            init.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
          },
        });
        return new Response(body, { status: 500 });
      })
    );
    const err = await collect(streamChat(ep, { model: "m" }, undefined, 50)).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toBe("The provider didn't respond in time.");
  });

  it("keeps credentials and the query string out of messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        throw new Error(`error sending request for url (${url})`);
      })
    );
    const leaky = { baseUrl: "https://user:pw@api.example.com/v1?key=secret" };
    const err = await collect(streamChat(leaky, { model: "m" })).catch((e) => e);
    expect(err.message).toContain("https://api.example.com/v1");
    expect(err.message).not.toMatch(/secret|pw@|user:/);
    const err2 = await requestJson(leaky, "/models").catch((e) => e);
    expect(err2.message).not.toMatch(/secret|pw@/);
  });
});

describe("redirects", () => {
  it("refuses to follow a redirect to another host", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/v1/models" } })
    );
    vi.stubGlobal("fetch", fetch);
    const err = await requestJson(ep, "/models").catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toContain("evil.example");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a same-origin redirect with the key", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/v1/models")
        ? new Response(null, { status: 301, headers: { location: "/v2/models" } })
        : new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetch);
    expect(await requestJson(ep, "/models")).toEqual({ data: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1] as unknown[])[0]).toBe("https://api.example.com/v2/models");
  });

  it("stops after three redirects", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/loop" } })
    );
    vi.stubGlobal("fetch", fetch);
    await expect(requestJson(ep, "/models")).rejects.toThrow(/too many times/);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("anthropic", () => {
  it("drops thinking when tool_choice forces a tool", () => {
    const req = toMessagesBody({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "ping", description: "", parameters: {} } }],
      tool_choice: "required",
      reasoning_effort: "high",
    });
    expect(req.thinking).toBeUndefined();
    expect(req.tool_choice).toEqual({ type: "any" });
  });
});

describe("mergeHeaders", () => {
  const previous = [
    { key: "X-Api-Token", value: "real-secret" },
    { key: "HTTP-Referer", value: "https://app.example" },
  ];
  const hints = [
    { key: "X-Api-Token", value: "real…cret" },
    { key: "HTTP-Referer", value: "https://app.example" },
  ];

  it("keeps secrets for unchanged headers, even renamed or padded", () => {
    expect(
      mergeHeaders(
        [
          { key: "  X-Token ", value: "real…cret" },
          { key: "HTTP-Referer", value: "https://app.example" },
        ],
        previous,
        hints
      )
    ).toEqual([
      { key: "X-Token", value: "real-secret" },
      { key: "HTTP-Referer", value: "https://app.example" },
    ]);
  });

  it("stores new values and drops blank keys", () => {
    expect(
      mergeHeaders(
        [
          { key: "X-Api-Token", value: "new" },
          { key: "  ", value: "x" },
        ],
        previous,
        hints
      )
    ).toEqual([{ key: "X-Api-Token", value: "new" }]);
  });
});

describe("balances", () => {
  it("formats large amounts without cents", () => {
    expect(formatAmount(12345.67)).toBe("$12,346");
    expect(formatAmount(12.5)).toBe("$12.50");
  });

  it("reports a rejected key on an unknown host instead of calling it unsupported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }))
    );
    const err = await fetchBalance({ baseUrl: "https://gateway.example", apiKey: "k" }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("auth");
  });

  it("still returns null for a gateway without the routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 }))
    );
    expect(await fetchBalance({ baseUrl: "https://gateway.example/v1", apiKey: "k" })).toBeNull();
  });
});
