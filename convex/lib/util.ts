/** Small helpers shared by queries, mutations and actions. */

export function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const VALID_KEY = /^[\x20-\x7E]+$/;

/**
 * Makes model-produced JSON storable in Convex: drops undefined, replaces keys Convex rejects
 * (empty, leading "$", non-ASCII), and caps depth.
 */
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 24) return null;
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      let key = k;
      if (!key || key.startsWith("$") || key.startsWith("_") || !VALID_KEY.test(key)) {
        key = `k_${Array.from(k)
          .map((c) => (VALID_KEY.test(c) && c !== "$" ? c : "_"))
          .join("")}`;
      }
      out[key] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return null;
}

/** "openrouter/anthropic/claude-sonnet-4.5" → { providerId: "openrouter", modelId: "anthropic/claude-sonnet-4.5" } */
export function parseModelRef(ref: string): { providerId: string; modelId: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { providerId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

export function modelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** Parses JSON that may be wrapped in a code fence or cut off mid-object. */
export function parseLooseJson(raw: string): unknown {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    if (start < 0) throw new Error("No JSON object found");
    return JSON.parse(closeJson(text.slice(start)));
  }
}

/** Closes unterminated strings/brackets so a truncated JSON prefix parses. */
export function closeJson(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = text;
  if (inString) out += '"';
  out = out.replace(/[,:]\s*$/, "");
  return out + stack.reverse().join("");
}
