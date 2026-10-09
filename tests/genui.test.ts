import { describe, expect, it } from "vitest";
import { evaluate, fillLive, isShown, planBlocks, type BlockPlan } from "../src/genui/compute";
import type { Block } from "../src/genui/schemas";

describe("blocks that react on the phone", () => {
  const blocks = [
    {
      type: "input",
      id: "plan",
      label: "Plan",
      kind: "choice",
      value: 1,
      options: [
        { label: "Basic", value: 1 },
        { label: "Pro", value: 2 },
      ],
    },
    { type: "input", id: "seats", label: "Seats", kind: "slider", value: 8, min: 1, max: 50 },
    {
      type: "computed",
      rows: [{ id: "price", label: "Monthly", formula: "seats * (plan == 2 ? 29 : 12)" }],
    },
    { type: "heading", text: "${price}/mo for {seats} seats on {plan}" },
    { type: "callout", tone: "tip", text: "Pro adds SSO.", show: "plan == 2" },
    { type: "text", text: "Sets like {a, b} and {unknown} stay as written." },
  ] as Block[];
  const plan = planBlocks(blocks) as BlockPlan;
  const run = (values: Record<string, number>) => evaluate(plan, values).scope;
  const show = (_: string, v: number) => String(v);

  it("plans without errors", () => {
    expect("error" in plan).toBe(false);
  });

  it("shows a block only while its condition holds", () => {
    expect(isShown(plan, 4, run({ plan: 1, seats: 8 }))).toBe(false);
    expect(isShown(plan, 4, run({ plan: 2, seats: 8 }))).toBe(true);
    expect(isShown(plan, 3, run({ plan: 1, seats: 8 }))).toBe(true);
  });

  it("fills live values as inputs change", () => {
    const text = (blocks[3] as Extract<Block, { type: "heading" }>).text;
    expect(fillLive(text, plan, run({ plan: 1, seats: 8 }), show)).toBe("$96/mo for 8 seats on 1");
    expect(fillLive(text, plan, run({ plan: 2, seats: 10 }), show)).toBe(
      "$290/mo for 10 seats on 2"
    );
  });

  it("leaves braces that aren't live values alone", () => {
    const text = (blocks[5] as Extract<Block, { type: "text" }>).text;
    expect(fillLive(text, plan, run({ plan: 1, seats: 8 }), show)).toBe(text);
  });

  it("holds back a brace still being written", () => {
    expect(fillLive("Total {pri", plan, run({ plan: 1, seats: 8 }), show, true)).toBe("Total ");
  });
});
