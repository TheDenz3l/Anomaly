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

export function planRows(blocks: Block[]): RowPlan | { index: number; error: string } {
  const inputs = new Map<string, string>();
  for (const b of blocks) if (b.type === "input") inputs.set(b.id.toLowerCase(), b.id);

  const rows: { key: string; index: number; label: string; src: string }[] = [];
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
      rows.push({ key, index, label: r.label, src: r.formula });
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
      return { index: r.index, error: `formula for "${r.label}": ${(e as Error).message}` };
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
      if (dep) return { index: r.index, error: `formula for "${r.label}" depends on itself` };
      return {
        index: r.index,
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
      return { index: r.index, error: `formula for "${r.label}" depends on itself` };
  }
  return { inputs, order };
}

/** Each row's value for the current inputs, keyed "blockIndex:rowIndex"; NaN where it can't compute. */
export function runPlan(plan: RowPlan, values: Record<string, number>): Map<string, number> {
  const scope: Record<string, number> = {};
  for (const [name, id] of plan.inputs) scope[name] = values[id];
  const out = new Map<string, number>();
  for (const row of plan.order) {
    const v = row.formula.run(scope);
    const value = Number.isFinite(v) ? v : NaN;
    out.set(row.key, value);
    for (const n of row.owns) scope[n] = value;
  }
  return out;
}
