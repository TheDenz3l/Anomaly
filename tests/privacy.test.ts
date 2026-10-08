import { describe, expect, it, vi } from "vitest";
import { askedToRemember, heuristicDecisions, isSensitiveMemory } from "../convex/ai/decisions";
import { flushRecords } from "../convex/engine/context";
import { proposeMemory, rememberTool } from "../convex/engine/tools";

describe("asking to remember", () => {
  it.each([
    "Remember that I'm vegetarian",
    "Please remember I'm allergic to nuts",
    "Can you remember that my wife is Anna?",
    "Thanks. Don't forget I work at Acme.",
    "I want you to remember that I live in Leeds",
  ])("counts %s", (text) => {
    expect(askedToRemember(text)).toBe(true);
  });

  it.each([
    "I cannot remember the latest iPhone price, what is it?",
    "Do you remember what I said?",
    "Remember when phones had keyboards?",
    "I can't remember my password",
  ])("ignores %s", (text) => {
    expect(askedToRemember(text)).toBe(false);
  });

  it("doesn't turn a question into a memory or switch off search", async () => {
    const q = "I cannot remember the latest iPhone price, what is it?";
    expect((await heuristicDecisions.memoryGate(q)).choice.remember).toBe(false);
    const intent = await heuristicDecisions.intent({
      text: q,
      hasImages: false,
      researchMode: false,
    });
    expect(intent.choice).not.toBe("memory");
  });

  it("saves the fact, not the request", async () => {
    const gate = await heuristicDecisions.memoryGate("Can you remember that I'm vegetarian?");
    expect(gate.choice.remember).toBe(true);
    expect(gate.choice.text).toBe("Vegetarian");
  });

  it("uses the number of agents asked for", async () => {
    const d = await heuristicDecisions.delegation("use 5 agents to compare phones", "auto");
    expect(d.choice.n).toBe(5);
  });
});

describe("sensitive memories", () => {
  it.each([
    "Their password is hunter2",
    "PIN is 4321",
    "Card 4111 1111 1111 1111",
    "API key sk-abcdefghijklmnop",
  ])("refuses %s", (text) => {
    expect(isSensitiveMemory(text)).toBe(true);
  });

  it.each(["Vegetarian", "Lives in Toronto", "Wife is Anna", "Prefers spinach"])(
    "keeps %s",
    (text) => {
      expect(isSensitiveMemory(text)).toBe(false);
    }
  );
});

function fakeEnv(requested: boolean, safety: string[] = []) {
  const runMutation = vi.fn(async (..._args: unknown[]) => "mem_1");
  const add = vi.fn((..._args: unknown[]) => undefined);
  const memoryGate = vi.fn(async () => ({
    choice: { remember: true, text: "", category: "place", scope: "global" },
    confidence: 0.97,
    provider: "jev",
  }));
  const env = {
    memory: { threadId: "t1", used: false, requested },
    sink: { add },
    engine: { userId: "u1", safety, decisions: [], ctx: { runMutation }, dp: { memoryGate } },
  };
  return { env: env as never, runMutation, add };
}

describe("memory writes", () => {
  it("never saves secrets, even when asked", async () => {
    const { env, runMutation, add } = fakeEnv(true);
    const outcome = await proposeMemory(
      env,
      { text: "Their password is hunter2", category: "fact", scope: "global" },
      0.97
    );
    expect(outcome).toBe("sensitive");
    expect(runMutation).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("saves nothing on a turn flagged for credentials", async () => {
    const { env, runMutation } = fakeEnv(true, ["credentials"]);
    expect(
      await proposeMemory(
        env,
        { text: "Lives in Toronto", category: "place", scope: "global" },
        0.97
      )
    ).toBe("sensitive");
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("asks first when only the model wants to save", async () => {
    const { env, runMutation, add } = fakeEnv(false);
    await rememberTool(env).run(
      { text: "Lives in Toronto", category: "place", scope: "global", explicit: true },
      {} as never
    );
    expect(runMutation).not.toHaveBeenCalled();
    const card = add.mock.calls[0][0] as { name: string; props: { confidence: number } };
    expect(card.name).toBe("MemoryConfirm");
    expect(card.props.confidence).toBeLessThan(0.85);
  });

  it("saves straight away when the user asked", async () => {
    const { env, runMutation } = fakeEnv(true);
    await rememberTool(env).run(
      { text: "Lives in Toronto", category: "place", scope: "global" },
      {} as never
    );
    expect(runMutation).toHaveBeenCalledTimes(1);
  });
});

describe("decision log", () => {
  const engine = (incognito: boolean, decisions: unknown[]) => {
    const runMutation = vi.fn(async (..._args: unknown[]) => null);
    return {
      engine: {
        ctx: { runMutation },
        userId: "u1",
        thread: { incognito },
        safety: [],
        learn: new Map(),
        decisions,
      } as never,
      runMutation,
    };
  };

  it("keeps nothing for incognito chats", async () => {
    const { engine: e, runMutation } = engine(true, [
      {
        kind: "intent",
        input: "my secret plans",
        output: "chat",
        confidence: 0.9,
        provider: "jev",
      },
    ]);
    await flushRecords(e, "m1");
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("masks what a decision put out, not just what went in", async () => {
    const { engine: e, runMutation } = engine(false, [
      {
        kind: "memory_gate",
        input: "email me at anna@example.com",
        output: { remember: true, text: "Email is anna@example.com" },
        confidence: 0.9,
        provider: "jev",
      },
    ]);
    await flushRecords(e, "m1");
    const args = runMutation.mock.calls[0][1] as { items: unknown[] };
    expect(JSON.stringify(args.items)).not.toContain("anna@example.com");
  });
});
