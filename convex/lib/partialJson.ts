/**
 * Reads the JSON a model has streamed so far, so a card can render before its arguments finish.
 *
 * Only finished values come back. An unfinished number, literal or key is left out, and so is an
 * unfinished string, unless `prose` says its key holds running text worth watching being written.
 * Objects and arrays that are still open keep the members already finished. An array element that
 * is itself still open is dropped unless `keepOpen` allows it for that array's key, so a list
 * grows one complete item at a time instead of flashing half-built ones.
 */
export type PartialJsonOptions = {
  prose?: (key: string) => boolean;
  keepOpen?: (key: string) => boolean;
};

type Read = { v: unknown; done: boolean; open?: boolean } | null;

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS: [string, unknown][] = [
  ["true", true],
  ["false", false],
  ["null", null],
];

export function parsePartialJson(src: string, opts: PartialJsonOptions = {}): unknown {
  const n = src.length;
  let i = 0;

  const ws = () => {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c !== 32 && c !== 10 && c !== 13 && c !== 9) break;
      i++;
    }
  };

  const str = (): { v: string; done: boolean } => {
    i++;
    let out = "";
    let from = i;
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 34) {
        out += src.slice(from, i);
        i++;
        return { v: out, done: true };
      }
      if (c === 92) {
        out += src.slice(from, i);
        const e = src[i + 1];
        if (e === undefined) {
          i = n;
          return { v: out, done: false };
        }
        if (e === "u") {
          const hex = src.slice(i + 2, i + 6);
          if (hex.length < 4) {
            i = n;
            return { v: out, done: false };
          }
          out += String.fromCharCode(parseInt(hex, 16) || 0);
          i += 6;
        } else {
          out += ESCAPES[e] ?? e;
          i += 2;
        }
        from = i;
        continue;
      }
      i++;
    }
    return { v: out + src.slice(from, n), done: false };
  };

  const scalar = (): Read => {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(src);
    if (m) {
      i += m[0].length;
      // A number touching the end may still be growing ("12" → "125").
      return i >= n ? null : { v: Number(m[0]), done: true };
    }
    for (const [word, value] of LITERALS) {
      if (src.startsWith(word, i)) {
        i += word.length;
        return { v: value, done: true };
      }
      if (word.startsWith(src.slice(i, i + word.length)) && i + word.length > n) {
        i = n;
        return null;
      }
    }
    i = n;
    return null;
  };

  const value = (key: string): Read => {
    ws();
    if (i >= n) return null;
    const c = src[i];
    if (c === "{") return object();
    if (c === "[") return array(key);
    if (c === '"') return str();
    return scalar();
  };

  const object = (): Read => {
    i++;
    const o: Record<string, unknown> = {};
    const open = { v: o, done: false, open: true };
    while (true) {
      ws();
      if (i >= n) return open;
      const c = src[i];
      if (c === "}") {
        i++;
        return { v: o, done: true };
      }
      if (c === ",") {
        i++;
        continue;
      }
      if (c !== '"') {
        i = n;
        return open;
      }
      const k = str();
      if (!k.done) return open;
      ws();
      if (src[i] !== ":") {
        i = n;
        return open;
      }
      i++;
      const r = value(k.v);
      if (!r) return open;
      if (r.done || r.open || (typeof r.v === "string" && opts.prose?.(k.v))) o[k.v] = r.v;
      if (!r.done) return open;
    }
  };

  const array = (key: string): Read => {
    i++;
    const a: unknown[] = [];
    const open = { v: a, done: false, open: true };
    while (true) {
      ws();
      if (i >= n) return open;
      const c = src[i];
      if (c === "]") {
        i++;
        return { v: a, done: true };
      }
      if (c === ",") {
        i++;
        continue;
      }
      const r = value(key);
      if (!r) return open;
      if (r.done) {
        a.push(r.v);
        continue;
      }
      const keep = r.open ? opts.keepOpen?.(key) : typeof r.v === "string" && opts.prose?.(key);
      if (keep) a.push(r.v);
      return open;
    }
  };

  const start = src.search(/[[{]/);
  if (start < 0) return undefined;
  i = start;
  return value("")?.v;
}
