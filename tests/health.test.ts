import { describe, expect, it } from "vitest";
import { blendMs, foldReading, readCheck, SLOW_MS } from "../convex/lib/health";
import { bySpeed, speedLabel, speedMs } from "../src/lib/models";

describe("readCheck", () => {
  it("reads a quick answer as normal and a slow one as degraded", () => {
    expect(readCheck({ ok: true, firstMs: 900 })).toEqual({ status: "normal", latencyMs: 900 });
    expect(readCheck({ ok: true, firstMs: SLOW_MS + 2000 }).status).toBe("degraded");
  });

  it("reads silence, refused keys and missing models as down", () => {
    expect(readCheck({ ok: false, timedOut: true }).status).toBe("down");
    expect(readCheck({ ok: false, kind: "auth", status: 401, body: "" })).toMatchObject({
      status: "down",
      detail: "Key rejected (401)",
    });
    expect(readCheck({ ok: false, kind: "not_found", status: 404, body: "" }).status).toBe("down");
    const relay = JSON.stringify({
      error: { message: "当前分组 default 下对于模型 gpt-x 无可用渠道" },
    });
    expect(readCheck({ ok: false, kind: "server", status: 503, body: relay })).toMatchObject({
      status: "down",
      detail: "Not served by this provider",
    });
  });

  it("reads rate limits and overload as degraded", () => {
    expect(readCheck({ ok: false, kind: "rate_limit", status: 429, body: "" }).status).toBe(
      "degraded"
    );
    expect(
      readCheck({ ok: false, kind: "server", status: 529, body: '{"type":"overloaded_error"}' })
        .status
    ).toBe("degraded");
  });

  it("counts a refused request parameter as the model answering", () => {
    const body = '{"error":{"message":"Unsupported parameter: max_tokens"}}';
    expect(readCheck({ ok: false, kind: "bad_param", status: 400, body }).status).toBe("normal");
    const gone = '{"error":{"message":"The model gpt-9 does not exist"}}';
    expect(readCheck({ ok: false, kind: "bad_param", status: 400, body: gone }).status).toBe(
      "down"
    );
  });
});

describe("foldReading", () => {
  const blip = { status: "down" as const, detail: "Provider error (502)", transient: true };

  it("makes one passing failure of a working model degraded, a second one down", () => {
    const first = foldReading({ status: "normal", fails: 0, latencyMs: 800 }, blip, false);
    expect(first).toMatchObject({ status: "degraded", fails: 1, latencyMs: undefined });
    expect(foldReading(first, blip, false)).toMatchObject({ status: "down", fails: 2 });
  });

  it("trusts a check, which already retried", () => {
    expect(foldReading({ status: "normal", fails: 0 }, blip, true).status).toBe("down");
  });

  it("clears failures on success and keeps the last speed", () => {
    expect(
      foldReading({ status: "down", fails: 3, latencyMs: 700 }, { status: "normal" }, false)
    ).toEqual({ status: "normal", detail: undefined, latencyMs: 700, fails: 0 });
  });

  it("leans a new timing on the one before it", () => {
    expect(blendMs(undefined, 900)).toBe(900);
    expect(blendMs(1000, undefined)).toBe(1000);
    expect(blendMs(1000, 2000)).toBe(1600);
    const next = foldReading(
      { status: "normal", fails: 0, latencyMs: 1000 },
      readCheck({ ok: true, firstMs: 500, textMs: 800 }),
      true
    );
    expect(next).toMatchObject({ status: "normal", latencyMs: 700, textMs: 800 });
  });
});

describe("speed", () => {
  const model = (
    name: string,
    health?: { status: "normal" | "down"; latencyMs?: number; textMs?: number }
  ) => ({
    name,
    health: health ? { ...health, checkedAt: 1 } : undefined,
  });

  it("goes by the first words when timed, else the first event, and never for a model that is down", () => {
    expect(speedMs(model("a", { status: "normal", latencyMs: 300, textMs: 900 }))).toBe(900);
    expect(speedMs(model("b", { status: "normal", latencyMs: 300 }))).toBe(300);
    expect(speedMs(model("c", { status: "down", latencyMs: 300 }))).toBeUndefined();
    expect(speedLabel(640)).toBe("0.6s");
    expect(speedLabel(12_400)).toBe("12s");
  });

  it("sorts the quickest first and leaves untimed models last, in their order", () => {
    const list = [
      model("untimed"),
      model("slow", { status: "normal", textMs: 4000 }),
      model("down", { status: "down" }),
      model("quick", { status: "normal", latencyMs: 400 }),
    ];
    expect(bySpeed(list).map((m) => m.name)).toEqual(["quick", "slow", "untimed", "down"]);
  });
});
