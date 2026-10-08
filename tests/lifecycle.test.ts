// @vitest-environment edge-runtime
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { signedIn } from "./convex";

type T = Awaited<ReturnType<typeof signedIn>>["t"];

const meta = { modelRef: "p/m", levelRequested: "auto", levelSent: "", reasoningTokens: 0 };

async function thread(t: T, userId: Id<"users">, mode: "chat" | "research" = "chat") {
  return await t.run((ctx) =>
    ctx.db.insert("threads", {
      userId,
      title: "Test",
      modelRef: "p/m",
      mode,
      reasoningLevel: "auto",
      incognito: false,
      updatedAt: Date.now(),
    })
  );
}

async function message(
  t: T,
  userId: Id<"users">,
  threadId: Id<"threads">,
  extra: Record<string, unknown> = {}
) {
  return await t.run((ctx) =>
    ctx.db.insert("messages", {
      threadId,
      userId,
      role: "assistant",
      parts: [],
      status: "streaming",
      meta,
      ...extra,
    })
  );
}

async function researchRun(
  t: T,
  userId: Id<"users">,
  threadId: Id<"threads">,
  status: "running" | "synthesizing",
  progressMessageId?: Id<"messages">
) {
  return await t.run((ctx) =>
    ctx.db.insert("researchRuns", {
      userId,
      threadId,
      status,
      question: "Q",
      clarifications: [],
      depth: 1,
      budget: { maxUsd: 1, maxSources: 10, maxSearches: 5 },
      spentUsd: 0,
      notes: [],
      sources: [],
      progressMessageId,
    })
  );
}

const text = (s: string) => [{ id: "t1", type: "text" as const, text: s }];

beforeEach(() => {
  // Keeps scheduled replies (which would call a model) from running.
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("stale writes", () => {
  it("refuses a write from another run and accepts the current one", async () => {
    const { t, userId } = await signedIn();
    const threadId = await thread(t, userId);
    const id = await message(t, userId, threadId, { runId: "run_new" });
    const stale = await t.mutation(internal.engine.data.writeParts, {
      messageId: id,
      runId: "run_old",
      parts: text("old"),
      status: "done",
    });
    expect(stale.stopped).toBe(true);
    let m = await t.run((ctx) => ctx.db.get(id));
    expect(m?.parts).toEqual([]);
    expect(m?.status).toBe("streaming");

    const ok = await t.mutation(internal.engine.data.writeParts, {
      messageId: id,
      runId: "run_new",
      parts: text("new"),
      status: "done",
    });
    expect(ok.stopped).toBe(false);
    m = await t.run((ctx) => ctx.db.get(id));
    expect(m?.parts).toEqual(text("new"));
    expect(m?.status).toBe("done");
  });

  it("keeps old messages without a runId writable", async () => {
    const { t, userId } = await signedIn();
    const threadId = await thread(t, userId);
    const id = await message(t, userId, threadId);
    const r = await t.mutation(internal.engine.data.writeParts, {
      messageId: id,
      runId: "anything",
      parts: text("hi"),
    });
    expect(r.stopped).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(id)))?.parts).toEqual(text("hi"));
  });

  it("a regenerate locks out the run that was stopped", async () => {
    const { t, userId, as } = await signedIn();
    const threadId = await thread(t, userId);
    const id = await message(t, userId, threadId, {
      status: "stopped",
      runId: "run_first",
      parts: text("first"),
    });
    await as.mutation(api.messages.regenerate, { messageId: id });
    const m = await t.run((ctx) => ctx.db.get(id));
    expect(m?.status).toBe("streaming");
    expect(m?.runId).toBeTruthy();
    expect(m?.runId).not.toBe("run_first");
    expect(m?.streamStartedAt).toBeTypeOf("number");

    const late = await t.mutation(internal.engine.data.writeParts, {
      messageId: id,
      runId: "run_first",
      parts: text("late"),
      status: "stopped",
    });
    expect(late.stopped).toBe(true);
    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after?.parts).toEqual([]);
    expect(after?.status).toBe("streaming");
  });

  it("a write cannot undo Stop", async () => {
    const { t, userId, as } = await signedIn();
    const threadId = await thread(t, userId);
    const id = await message(t, userId, threadId, { runId: "run_a" });
    await as.mutation(api.messages.stop, { threadId });
    const r = await t.mutation(internal.engine.data.writeParts, {
      messageId: id,
      runId: "run_a",
      parts: text("x"),
      status: "done",
    });
    expect(r.stopped).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("stopped");
  });

  it("send gives the new reply a runId and start time", async () => {
    const { t, userId, as } = await signedIn();
    const threadId = await thread(t, userId);
    const { messageId } = await as.mutation(api.messages.send, { threadId, text: "Hello" });
    const m = await t.run((ctx) => ctx.db.get(messageId));
    expect(m?.runId).toMatch(/^run/);
    expect(m?.streamStartedAt).toBeTypeOf("number");
  });
});

describe("reapStale", () => {
  it("judges age by streamStartedAt, else creation time", async () => {
    const { t, userId } = await signedIn();
    const threadId = await thread(t, userId);
    const old = await message(t, userId, threadId);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    // Created as long ago as `old`, but regenerated just now.
    const restarted = await message(t, userId, threadId, { streamStartedAt: Date.now() });
    const startedLongAgo = await message(t, userId, threadId, {
      streamStartedAt: Date.now() - 25 * 60_000,
    });
    const run = await researchRun(t, userId, threadId, "synthesizing", old);

    const n = await t.mutation(internal.engine.data.reapStale, {});
    expect(n).toBe(2);
    const get = (id: Id<"messages">) => t.run((ctx) => ctx.db.get(id));
    expect((await get(old))?.status).toBe("error");
    expect((await get(startedLongAgo))?.status).toBe("error");
    expect((await get(restarted))?.status).toBe("streaming");
    expect((await t.run((ctx) => ctx.db.get(run)))?.status).toBe("failed");
  });
});

describe("Deep Research keeps running", () => {
  it("a new message leaves the progress reply alone; Stop ends it", async () => {
    const { t, userId, as } = await signedIn();
    const threadId = await thread(t, userId, "research");
    const progress = await message(t, userId, threadId, { runId: "run_r" });
    const other = await message(t, userId, threadId, { runId: "run_o" });
    const run = await researchRun(t, userId, threadId, "running", progress);

    await as.mutation(api.messages.send, { threadId, text: "Still going?" });
    const get = (id: Id<"messages">) => t.run((ctx) => ctx.db.get(id));
    expect((await get(progress))?.status).toBe("streaming");
    expect((await get(other))?.status).toBe("stopped");
    expect((await t.run((ctx) => ctx.db.get(run)))?.status).toBe("running");
    expect((await t.run((ctx) => ctx.db.get(threadId)))?.mode).toBe("research");

    await as.mutation(api.messages.stop, { threadId });
    expect((await get(progress))?.status).toBe("stopped");
    expect((await t.run((ctx) => ctx.db.get(run)))?.status).toBe("cancelled");
  });

  it("a card event leaves the progress reply alone", async () => {
    const { t, userId, as } = await signedIn();
    const threadId = await thread(t, userId, "research");
    await message(t, userId, threadId, {
      status: "done",
      parts: [
        {
          id: "cmp_x",
          type: "component",
          name: "ChoiceChips",
          props: {},
          status: "ready",
          fallbackText: "x",
        },
      ],
    });
    const progress = await message(t, userId, threadId, { runId: "run_r" });
    await researchRun(t, userId, threadId, "synthesizing", progress);
    await as.mutation(api.messages.emitUiEvent, {
      threadId,
      componentId: "cmp_x",
      component: "ChoiceChips",
      action: "choose",
      label: "Option",
    });
    expect((await t.run((ctx) => ctx.db.get(progress)))?.status).toBe("streaming");
  });
});

describe("regenerate", () => {
  it.each([
    ["report", /Research reports can't be regenerated/],
    ["subagents", /Sub-agent results can't be regenerated/],
  ] as const)("refuses %s replies and keeps them", async (kind, error) => {
    const { t, userId, as } = await signedIn();
    const threadId = await thread(t, userId);
    const id = await message(t, userId, threadId, {
      status: "done",
      parts: text("The report"),
      meta: { ...meta, kind },
    });
    await expect(as.mutation(api.messages.regenerate, { messageId: id })).rejects.toThrow(error);
    const m = await t.run((ctx) => ctx.db.get(id));
    expect(m?.parts).toEqual(text("The report"));
    expect(m?.status).toBe("done");
  });
});

describe("research runs end", () => {
  it("synthesize fails the run when its reply is gone", async () => {
    const { t, userId } = await signedIn();
    const threadId = await thread(t, userId, "research");
    const progress = await message(t, userId, threadId);
    const run = await researchRun(t, userId, threadId, "synthesizing", progress);
    await t.run((ctx) => ctx.db.delete(progress));
    await t.action(internal.research.synthesize, { runId: run, messageId: progress });
    const r = await t.run((ctx) => ctx.db.get(run));
    expect(r?.status).toBe("failed");
    expect(r?.finishedAt).toBeTypeOf("number");
  });

  it("synthesize cancels when the reply was stopped or taken over by another run", async () => {
    const { t, userId } = await signedIn();
    const threadId = await thread(t, userId, "research");
    const stopped = await message(t, userId, threadId, { status: "stopped" });
    const run1 = await researchRun(t, userId, threadId, "synthesizing", stopped);
    await t.action(internal.research.synthesize, { runId: run1, messageId: stopped });
    expect((await t.run((ctx) => ctx.db.get(run1)))?.status).toBe("cancelled");

    const taken = await message(t, userId, threadId, { runId: "run_new" });
    const run2 = await researchRun(t, userId, threadId, "synthesizing", taken);
    await t.action(internal.research.synthesize, {
      runId: run2,
      messageId: taken,
      writerRunId: "run_old",
    });
    expect((await t.run((ctx) => ctx.db.get(run2)))?.status).toBe("cancelled");
    expect((await t.run((ctx) => ctx.db.get(taken)))?.status).toBe("streaming");
  });
});
