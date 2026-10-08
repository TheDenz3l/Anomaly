/**
 * Arithmetic for computed values in generated UI. Formulas are parsed into a small tree and
 * evaluated against the current inputs, never run as code. Supported: numbers, names (input ids
 * and row ids, case-insensitive, an optional leading $), + - * / % ^, comparisons (1 when true, 0
 * when false; a lone = compares), && || ! and/or/not, a ? b : c, parentheses, and min max round
 * floor ceil abs sqrt pow clamp if.
 */

type Scope = Record<string, number>;
type Fn = (scope: Scope) => number;

const FUNCS: Record<string, { arity: [number, number]; run: (...a: number[]) => number }> = {
  min: { arity: [1, 12], run: (...a) => Math.min(...a) },
  max: { arity: [1, 12], run: (...a) => Math.max(...a) },
  round: {
    arity: [1, 2],
    run: (x, d = 0) => {
      const f = 10 ** Math.max(0, Math.min(6, Math.trunc(d)));
      return Math.round(x * f) / f;
    },
  },
  floor: { arity: [1, 1], run: Math.floor },
  ceil: { arity: [1, 1], run: Math.ceil },
  abs: { arity: [1, 1], run: Math.abs },
  sqrt: { arity: [1, 1], run: Math.sqrt },
  pow: { arity: [2, 2], run: Math.pow },
  clamp: { arity: [3, 3], run: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
  if: { arity: [3, 3], run: (c, a, b) => (c ? a : b) },
};

type Token = { kind: "num" | "name" | "op"; text: string; value?: number };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const re =
    /\s*(?:(\d+(?:\.\d+)?|\.\d+)|\$?([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|==|!=|&&|\|\||[-+*/%^(),<>=?:!]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`can't read "${src.slice(i).trim().slice(0, 12)}"`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ kind: "num", text: m[1], value: Number(m[1]) });
    else if (m[2] !== undefined) {
      // Words for logic read as their operators; a lone = is a comparison, as people write it.
      const word = m[2].toLowerCase();
      if (word === "and") out.push({ kind: "op", text: "&&" });
      else if (word === "or") out.push({ kind: "op", text: "||" });
      else if (word === "not") out.push({ kind: "op", text: "!" });
      else out.push({ kind: "name", text: m[2] });
    } else out.push({ kind: "op", text: m[3] === "=" ? "==" : m[3] });
  }
  return out;
}

export type Formula = { run: Fn; names: string[] };

/** Parses a formula; throws with a short reason when it isn't valid. */
/**
 * Models miscount parentheses now and then. A closing one with nothing to close is dropped and any
 * left open are closed at the end, so a slip reads as the formula meant instead of failing it.
 */
function balance(src: string): string {
  let depth = 0;
  let out = "";
  for (const c of src) {
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) continue;
      depth--;
    }
    out += c;
  }
  return out + ")".repeat(depth);
}

export function compileFormula(src: string): Formula {
  const tokens = tokenize(balance(src));
  const names = new Set<string>();
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (text?: string) => {
    const t = tokens[pos];
    if (!t || (text !== undefined && t.text !== text))
      throw new Error(text ? `expected "${text}"` : "formula ends too soon");
    pos++;
    return t;
  };

  const atom = (): Fn => {
    const t = take();
    if (t.kind === "num") {
      const v = t.value!;
      return () => v;
    }
    if (t.kind === "name") {
      if (peek()?.text === "(") {
        const fn = FUNCS[t.text.toLowerCase()];
        if (!fn) throw new Error(`unknown function ${t.text}`);
        take("(");
        const args: Fn[] = [];
        if (peek()?.text !== ")") {
          args.push(ternary());
          while (peek()?.text === ",") {
            take(",");
            args.push(ternary());
          }
        }
        take(")");
        if (args.length < fn.arity[0] || args.length > fn.arity[1])
          throw new Error(`${t.text} takes ${fn.arity.join("-")} values`);
        return (s) => fn.run(...args.map((a) => a(s)));
      }
      const name = t.text.toLowerCase();
      names.add(name);
      return (s) => (name in s ? s[name] : NaN);
    }
    if (t.text === "(") {
      const inner = ternary();
      take(")");
      return inner;
    }
    throw new Error(`unexpected "${t.text}"`);
  };

  const power = (): Fn => {
    const base = atom();
    if (peek()?.text !== "^") return base;
    take("^");
    const exp = unary();
    return (s) => base(s) ** exp(s);
  };

  const unary = (): Fn => {
    const t = peek();
    if (t?.text === "-" || t?.text === "+" || t?.text === "!") {
      take();
      const inner = unary();
      if (t.text === "!") return (s) => (inner(s) ? 0 : 1);
      return t.text === "-" ? (s) => -inner(s) : inner;
    }
    return power();
  };

  const product = (): Fn => {
    let left = unary();
    while (["*", "/", "%"].includes(peek()?.text ?? "")) {
      const op = take().text;
      const l = left;
      const r = unary();
      left = op === "*" ? (s) => l(s) * r(s) : op === "/" ? (s) => l(s) / r(s) : (s) => l(s) % r(s);
    }
    return left;
  };

  const sum = (): Fn => {
    let left = product();
    while (peek()?.text === "+" || peek()?.text === "-") {
      const op = take().text;
      const l = left;
      const r = product();
      left = op === "+" ? (s) => l(s) + r(s) : (s) => l(s) - r(s);
    }
    return left;
  };

  const compare = (): Fn => {
    const left = sum();
    const op = peek()?.text;
    if (!op || !["<", "<=", ">", ">=", "==", "!="].includes(op)) return left;
    take();
    const right = sum();
    const test: Record<string, (a: number, b: number) => boolean> = {
      "<": (a, b) => a < b,
      "<=": (a, b) => a <= b,
      ">": (a, b) => a > b,
      ">=": (a, b) => a >= b,
      "==": (a, b) => a === b,
      "!=": (a, b) => a !== b,
    };
    return (s) => (test[op](left(s), right(s)) ? 1 : 0);
  };

  const both = (): Fn => {
    let left = compare();
    while (peek()?.text === "&&") {
      take();
      const l = left;
      const r = compare();
      left = (s) => (l(s) && r(s) ? 1 : 0);
    }
    return left;
  };

  const either = (): Fn => {
    let left = both();
    while (peek()?.text === "||") {
      take();
      const l = left;
      const r = both();
      left = (s) => (l(s) || r(s) ? 1 : 0);
    }
    return left;
  };

  const ternary = (): Fn => {
    const test = either();
    if (peek()?.text !== "?") return test;
    take("?");
    const yes = ternary();
    take(":");
    const no = ternary();
    return (s) => (test(s) ? yes(s) : no(s));
  };

  if (!tokens.length) throw new Error("formula is empty");
  const run = ternary();
  if (pos < tokens.length) throw new Error(`unexpected "${tokens[pos].text}"`);
  return { run, names: [...names] };
}
