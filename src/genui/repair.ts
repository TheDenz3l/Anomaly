import type { z } from "zod";

/**
 * Forgiving validation for model-written card props, the way a compiler drops one bad property
 * instead of rejecting the program. When props don't fit, the smallest piece that breaks them is
 * fixed or removed and they're checked again: a list or string over its limit is cut to size, a
 * number out of range is clamped, a wrong field is left out, and a list item that can't be fixed
 * goes. It fails only when something the card can't do without is wrong, such as a required
 * top-level field. Every change is reported, so the model (and evals) can see what was dropped.
 */

export type Salvaged<T> = { ok: true; data: T; dropped: string[] } | { ok: false; error: string };

type Issue = z.core.$ZodIssue;
type Key = PropertyKey;

/** Upper bound on fixes per call; each one removes or shrinks something, so this is only a guard. */
const MAX_FIXES = 40;

const isObject = (v: unknown): v is Record<Key, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function at(root: unknown, path: readonly Key[]): unknown {
  let node = root;
  for (const k of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<Key, unknown>)[k];
  }
  return node;
}

export const issuePath = (path: readonly Key[]) => path.map(String).join(".") || "props";

export function describeIssue(issue: Issue | undefined): string {
  return `${issuePath(issue?.path ?? [])}: ${issue?.message ?? "invalid"}`;
}

/** Applies one fix for this issue in place. Returns a note on what changed, or null if nothing can. */
function fix(root: unknown, issue: Issue): string | null {
  const path = issue.path;
  const last = path[path.length - 1];
  const parent = at(root, path.slice(0, -1));
  const value = at(root, path);
  const where = issuePath(path);

  if (last !== undefined && parent !== null && typeof parent === "object") {
    const slot = parent as Record<Key, unknown>;
    if (issue.code === "too_big" && issue.inclusive !== false) {
      const max = Number(issue.maximum);
      if (Array.isArray(value) && value.length > max) {
        value.length = max;
        return `${where}: kept the first ${max}`;
      }
      if (typeof value === "string" && value.length > max) {
        slot[last] = value.slice(0, max);
        return `${where}: cut to ${max} characters`;
      }
      if (typeof value === "number" && Number.isFinite(max)) {
        slot[last] = max;
        return `${where}: clamped to ${max}`;
      }
    }
    if (
      issue.code === "too_small" &&
      issue.inclusive !== false &&
      typeof value === "number" &&
      issue.origin === "number"
    ) {
      slot[last] = Number(issue.minimum);
      return `${where}: clamped to ${Number(issue.minimum)}`;
    }
    // A field that's present but wrong: leave it out. If the card needs it, the next pass reports it
    // missing and the item holding it goes instead.
    if (
      typeof last !== "number" &&
      isObject(parent) &&
      Object.prototype.hasOwnProperty.call(parent, last)
    ) {
      delete parent[last];
      return `${where} left out (${issue.message})`;
    }
  }

  // Nothing smaller to fix: remove the innermost list item the problem sits in.
  for (let i = path.length - 1; i >= 0; i--) {
    const index = path[i];
    if (typeof index !== "number") continue;
    const list = at(root, path.slice(0, i));
    if (Array.isArray(list) && index < list.length) {
      list.splice(index, 1);
      return `${issuePath(path.slice(0, i + 1))} removed (${describeIssue(issue)})`;
    }
  }
  return null;
}

export function salvage<T>(schema: z.ZodType<T>, input: unknown): Salvaged<T> {
  const first = schema.safeParse(input);
  if (first.success) return { ok: true, data: first.data, dropped: [] };
  if (input === null || typeof input !== "object")
    return { ok: false, error: describeIssue(first.error.issues[0]) };
  const value: unknown = JSON.parse(JSON.stringify(input));
  const dropped: string[] = [];
  let issue = first.error.issues[0];
  for (let n = 0; n < MAX_FIXES; n++) {
    const note = fix(value, issue);
    if (!note) break;
    dropped.push(note);
    const next = schema.safeParse(value);
    if (next.success) return { ok: true, data: next.data, dropped };
    issue = next.error.issues[0];
  }
  return { ok: false, error: describeIssue(issue) };
}
