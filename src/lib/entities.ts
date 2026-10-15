/**
 * Names marked in reply text: [[Isaiah Rashad|person|American rapper from Chattanooga]]. The model
 * marks the people, places, works and things a reply is about (convex/engine/prompt.ts); they read
 * as the name with a dotted underline, and a tap opens a profile sheet about it.
 */

export type EntityKind =
  "person" | "place" | "organization" | "work" | "product" | "event" | "thing";
export type EntityRef = { name: string; kind: EntityKind; hint: string };

const KINDS: EntityKind[] = ["person", "place", "organization", "work", "product", "event"];

/** A whole mark: the name, then up to two `|` fields (kind and what it is). */
export const ENTITY = String.raw`\[\[[^\[\]|\n]{1,80}(?:\|[^\[\]|\n]{0,120}){0,2}\]\]`;
const ONLY = new RegExp(`^${ENTITY}$`);
const ALL = new RegExp(ENTITY, "g");

export function isEntity(seg: string): boolean {
  return ONLY.test(seg);
}

export function parseEntity(seg: string): EntityRef | null {
  if (!ONLY.test(seg)) return null;
  const [name, kind = "", hint = ""] = seg.slice(2, -2).split("|").map((s) => s.trim());
  if (!name) return null;
  const k = kind.toLowerCase() as EntityKind;
  return { name, kind: KINDS.includes(k) ? k : "thing", hint };
}

/** Text with each mark reduced to its name, for previews, copy, share and speech. */
export function stripEntities(text: string): string {
  return text.replace(ALL, (m) => m.slice(2, -2).split("|")[0].trim());
}

/**
 * A mark still arriving shows as the name typed so far, with its fields held back:
 * "[[Isaiah Ra" and "[[Isaiah Rashad|person|Ameri" both read as plain text until "]]".
 */
export function settleEntity(text: string): string {
  return text.replace(/\[\[([^\[\]|\n]*)(?:\|[^\[\]\n]*)?\]?$/, "$1");
}

/** How a kind reads under the name when nothing better is known. */
export const KIND_LABEL: Record<EntityKind, string> = {
  person: "Person",
  place: "Place",
  organization: "Organization",
  work: "Work",
  product: "Product",
  event: "Event",
  thing: "Topic",
};
