import { compileFormula, type Formula } from "./formula";
import type { Block } from "./schemas";

/**
 * How a Blocks card's computed rows resolve. Formulas name inputs by id and other rows by id or by
 * label (snake_case, case-insensitive), in any order: rows run in dependency order, so a row may
 * use one written below it. The server checks the plan before a card is shown; the phone reruns it
 * whenever an input changes.
 */

type PlannedRow = { key: string; formula: Formula; owns: string[] };

export type RowPlan = {
  /** Lower-cased name → the input id it reads. */
  inputs: Map<string, string>;
  /** Rows in an order where every row comes after the rows it uses. */
  order: PlannedRow[];
};

/** What's wrong with a card's blocks: the block, the part of it at fault when known, and why. */
export type BlockIssue = { index: number; path?: (string | number)[]; error: string };

/**
 * Everything a Blocks card recomputes on the phone: its rows, plus each block's show condition
 * and every live value written in braces in its text, all bound to the card's inputs and rows.
 */
export type BlockPlan = RowPlan & {
  /** Block index → the condition that has to hold for it to show. */
  shows: Map<number, Formula>;
  /** Text inside braces → its formula, for the ones that read inputs or rows. */
  lives: Map<string, Formula>;
};

const NAME = /^[a-z_][a-z0-9_]*$/;

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Names a row answers to besides its id: its label, with and without a trailing "(x)", and x. */
function labelNames(label: string): string[] {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(label);
  const out = [slug(label)];
  if (m) out.push(slug(m[1]), m[2].trim().toLowerCase());
  return out.filter((n) => NAME.test(n));
}

export function planRows(blocks: Block[]): RowPlan | BlockIssue {
  const inputs = new Map<string, string>();
  for (const b of blocks) if (b.type === "input") inputs.set(b.id.toLowerCase(), b.id);

  const rows: { key: string; index: number; row: number; label: string; src: string }[] = [];
  const owner = new Map<string, string>();
  const owns = new Map<string, string[]>();
  const claim = (name: string, key: string) => {
    owner.set(name, key);
    owns.set(key, [...(owns.get(key) ?? []), name]);
  };
  for (const [index, b] of blocks.entries()) {
    if (b.type !== "computed") continue;
    for (const [ri, r] of b.rows.entries()) {
      const key = `${index}:${ri}`;
      rows.push({ key, index, row: ri, label: r.label, src: r.formula });
      // A repeated id stays with the input or the first row that took it.
      const id = r.id?.toLowerCase();
      if (id && !inputs.has(id) && !owner.has(id)) claim(id, key);
    }
  }
  // Label-derived names never clash: inputs and explicit ids win, then the first row to claim one.
  for (const r of rows)
    for (const n of labelNames(r.label)) if (!inputs.has(n) && !owner.has(n)) claim(n, r.key);

  const loose = new Map([...inputs].map(([n, id]) => [n.replace(/_/g, ""), id]));
  const compiled = new Map<string, { formula: Formula; deps: string[] }>();
  for (const r of rows) {
    let formula: Formula;
    try {
      formula = compileFormula(r.src);
    } catch (e) {
      return {
        index: r.index,
        path: ["rows", r.row],
        error: `formula for "${r.label}": ${(e as Error).message}`,
      };
    }
    const deps: string[] = [];
    for (const n of formula.names) {
      if (inputs.has(n)) continue;
      const dep = owner.get(n);
      // A row whose label matches the name it uses means the input of that name (people_count for an
      // input peopleCount), not itself; so does any name that only differs from an input by "_".
      if (dep && dep !== r.key) {
        deps.push(dep);
        continue;
      }
      const input = loose.get(n.replace(/_/g, ""));
      if (input) {
        inputs.set(n, input);
        continue;
      }
      if (dep)
        return {
          index: r.index,
          path: ["rows", r.row],
          error: `formula for "${r.label}" depends on itself`,
        };
      return {
        index: r.index,
        path: ["rows", r.row],
        error: `formula for "${r.label}" uses ${n}, which is neither an input id nor a row's id`,
      };
    }
    compiled.set(r.key, { formula, deps });
  }

  const order: PlannedRow[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): string | null => {
    const s = state.get(key);
    if (s === "done") return null;
    if (s === "visiting") return key;
    state.set(key, "visiting");
    for (const d of compiled.get(key)!.deps) {
      const loop = visit(d);
      if (loop) return loop;
    }
    state.set(key, "done");
    order.push({ key, formula: compiled.get(key)!.formula, owns: owns.get(key) ?? [] });
    return null;
  };
  for (const r of rows) {
    if (visit(r.key))
      return {
        index: r.index,
        path: ["rows", r.row],
        error: `formula for "${r.label}" depends on itself`,
      };
  }
  return { inputs, order };
}

/** Each row's value for the current inputs, keyed "blockIndex:rowIndex"; NaN where it can't compute. */
export function runPlan(plan: RowPlan, values: Record<string, number>): Map<string, number> {
  return evaluate(plan, values).rows;
}

/**
 * Row values plus the scope conditions and live values read: every input under each name it
 * answers to, and every row under its id and label names.
 */
export function evaluate(
  plan: RowPlan,
  values: Record<string, number>
): { rows: Map<string, number>; scope: Record<string, number> } {
  const scope: Record<string, number> = {};
  for (const [name, id] of plan.inputs) scope[name] = values[id];
  const rows = new Map<string, number>();
  for (const row of plan.order) {
    const v = row.formula.run(scope);
    const value = Number.isFinite(v) ? v : NaN;
    rows.set(row.key, value);
    for (const n of row.owns) scope[n] = value;
  }
  return { rows, scope };
}

/** `{guests * 2}` in a block's text: replaced by its value while the inputs change. */
const LIVE = /\{([^{}\n]{1,120})\}/g;

/** Fields that hold formulas, ids or links rather than text the user reads. */
const NOT_TEXT = new Set(["type", "show", "formula", "id", "url", "image", "images", "kind"]);

function textsOf(v: unknown, out: string[]): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) textsOf(x, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) if (!NOT_TEXT.has(k)) textsOf(x, out);
  return out;
}

/** The expressions written in braces in a piece of text. */
export function liveExpressions(text: string): string[] {
  return [...text.matchAll(LIVE)].map((m) => m[1].trim());
}

/**
 * Plans a Blocks card: its rows (planRows), each block's show condition, and its live values.
 * A condition that doesn't parse or names nothing on the card is an issue at that block's `show`;
 * braces that don't bind to the card's inputs or rows are left as written, since they may be prose.
 */
export function planBlocks(blocks: Block[]): BlockPlan | BlockIssue {
  const rows = planRows(blocks);
  if ("error" in rows) return rows;
  const owned = new Set(rows.order.flatMap((r) => r.owns));
  const loose = new Map([...rows.inputs].map(([n, id]) => [n.replace(/_/g, ""), id]));
  const bind = (src: string): Formula => {
    const f = compileFormula(src);
    for (const n of f.names) {
      if (rows.inputs.has(n) || owned.has(n)) continue;
      const id = loose.get(n.replace(/_/g, ""));
      if (!id) throw new Error(`uses ${n}, which is neither an input id nor a row's id`);
      rows.inputs.set(n, id);
    }
    return f;
  };
  const shows = new Map<number, Formula>();
  for (const [index, b] of blocks.entries()) {
    if (!b.show) continue;
    try {
      shows.set(index, bind(b.show));
    } catch (e) {
      return { index, path: ["show"], error: `show: ${(e as Error).message}` };
    }
  }
  const lives = new Map<string, Formula>();
  if (rows.inputs.size || owned.size)
    for (const b of blocks)
      for (const text of textsOf(b, []))
        for (const expr of liveExpressions(text)) {
          if (lives.has(expr)) continue;
          try {
            const f = bind(expr);
            // Braces around a bare number or arithmetic on constants are prose, not a live value.
            if (f.names.length) lives.set(expr, f);
          } catch {
            // Not a live value: shown as written.
          }
        }
  return { ...rows, shows, lives };
}

/** Whether a block shows for the current values: no condition, or one that holds. */
export function isShown(plan: BlockPlan, index: number, scope: Record<string, number>): boolean {
  const cond = plan.shows.get(index);
  if (!cond) return true;
  const v = cond.run(scope);
  return Number.isFinite(v) && v !== 0;
}

/**
 * Text with its live values filled in. `show` formats a value for the expression it came from (a
 * row keeps its own format). While a block is still being written, a brace left open at the end
 * is held back rather than flashed as raw text.
 */
export function fillLive(
  text: string,
  plan: BlockPlan,
  scope: Record<string, number>,
  show: (expr: string, value: number) => string,
  writing = false
): string {
  const src = writing ? text.replace(/\{[^{}\n]*$/, "") : text;
  if (!plan.lives.size || !src.includes("{")) return src;
  return src.replace(LIVE, (whole, inner: string) => {
    const expr = inner.trim();
    const f = plan.lives.get(expr);
    return f ? show(expr, f.run(scope)) : whole;
  });
}
