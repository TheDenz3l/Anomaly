import { z } from "zod";
import { ACCENTS, catalogSchemas, checkBlocks, validateComponent } from "../../src/genui/schemas";
import { parsePartialJson, type PartialJsonOptions } from "../lib/partialJson";
import { ModelBlocksSchema, readBlocks } from "./blocks";
import type { ToolDef } from "./openai";

/**
 * Generative-UI catalog as model tools (PRD §3.3). Schemas are shared with the client
 * (src/genui/schemas.ts), so the server validates exactly what the renderer will accept.
 */

export const MODEL_COMPONENTS = [
  "MovieShowtimes",
  "MapCard",
  "Chart",
  "Table",
  "Compare",
  "Timeline",
  "Form",
  "Stepper",
  "Checklist",
  "ChoiceChips",
  "Weather",
  "ProductGrid",
  "Blocks",
] as const;

export type ModelComponent = (typeof MODEL_COMPONENTS)[number];

const PREFIX = "ui_";

const descriptions: Record<ModelComponent, string> = {
  MovieShowtimes:
    "Movies playing nearby with showtimes per theatre. Prefer find_showtimes, which builds this for you.",
  MapCard: "A map with pinned places and a synced list. Use for 'near me' answers with 2+ places.",
  Chart:
    "A line chart. For savings/compound growth use model {type:'compound'} so the user can drag the contribution; otherwise give series points.",
  Table: "Tabular data with typed columns. Use for 4+ rows of structured values.",
  Compare:
    "Side-by-side comparison of 2-3 items with per-row winners and a verdict, and a photo per item when you have one.",
  Timeline: "Dated events in order (history, schedules, roadmaps); events can carry a photo.",
  Form: "Collect structured input from the user (booking details, preferences). Nothing is sent anywhere until they submit.",
  Stepper:
    "Step-by-step instructions the user follows in order (setup guides, recipes), with a photo for a step when it shows what to do.",
  Checklist: "Grouped checkable items (packing lists, to-dos).",
  ChoiceChips:
    "Tappable options for the user's next reply: clarifying questions or follow-up suggestions. Set multi for multi-select.",
  Weather:
    "Current conditions plus hourly and daily forecast. Prefer get_weather, which builds this for you.",
  Blocks:
    "A visual answer composed from blocks in reading order: plans, guides, breakdowns, explainers, and small tools the user asks for (scalers, splitters, calculators) where input blocks drive computed rows live on the phone. Headings, facts, items and steps can carry photos, and an images block shows a gallery. Bars draw magnitudes to scale, a quiz lets the user test themselves, cards turn over to reveal an answer, and a quote sets off a voice. Set accent to a colour that suits the subject. Blocks appear to the user as you write them, so put the most important one first. This card is the answer: at most one short sentence of text before it, none after.",
  ProductGrid:
    "Products the user can buy: real prices you found, each product's page url, and a photo url when you have one. Not for articles, sources or links.",
};

/** Props only the engine sets (live state of a card it's still filling); models never see or send them. */
const ENGINE_ONLY: Partial<Record<ModelComponent, string[]>> = {
  MovieShowtimes: ["timesLoading"],
};

/** Shapes shown to models in place of the catalog schema; what they send is mapped back on validation. */
const MODEL_SCHEMAS: Partial<Record<ModelComponent, z.ZodType>> = { Blocks: ModelBlocksSchema };

const FALLBACK_HINT =
  "One or two plain sentences conveying the same information, used for voice and text-only clients.";

function cleanSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$schema" || k === "propertyNames" || k === "$id") continue;
    // Some endpoints reject oneOf and const in tool schemas; anyOf and enum mean the same here.
    if (k === "const") out.enum = [v];
    else out[k === "oneOf" ? "anyOf" : k] = cleanSchema(v);
  }
  return out;
}

export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return cleanSchema(
    z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" })
  ) as Record<string, unknown>;
}

let cache: Map<ModelComponent, ToolDef> | null = null;

function allTools(): Map<ModelComponent, ToolDef> {
  if (cache) return cache;
  cache = new Map();
  for (const name of MODEL_COMPONENTS) {
    const base = (MODEL_SCHEMAS[name] ?? catalogSchemas[name]) as unknown as z.ZodObject;
    const hidden = Object.fromEntries(
      (ENGINE_ONLY[name] ?? []).map((k) => [k, true] as const)
    ) as Record<string, true>;
    const schema = base.omit(hidden as never).extend({
      fallbackText: z.string().describe(FALLBACK_HINT),
    });
    cache.set(name, {
      type: "function",
      function: {
        name: `${PREFIX}${name}`,
        description: `Render the ${name} component inline. ${descriptions[name]}`,
        parameters: jsonSchemaFor(schema),
      },
    });
  }
  return cache;
}

export function componentTools(names: readonly ModelComponent[] = MODEL_COMPONENTS): ToolDef[] {
  const tools = allTools();
  return names.map((n) => tools.get(n)!).filter(Boolean);
}

export function componentFromTool(toolName: string): ModelComponent | null {
  if (!toolName.startsWith(PREFIX)) return null;
  const name = toolName.slice(PREFIX.length);
  return (MODEL_COMPONENTS as readonly string[]).includes(name) ? (name as ModelComponent) : null;
}

/** One line per card for routers choosing between them (Jev's card question). */
export function cardSummary(name: string): string {
  const d = descriptions[name as ModelComponent];
  return d ? `${name}: ${d.split(/(?<=\.)\s/)[0]}` : `The ${name} card.`;
}

export function isCatalogName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(catalogSchemas, name);
}

const IMAGE_KEYS = new Set(["image", "poster"]);
const WEB_URL = /^https?:\/\/\S+$/i;

/**
 * Drops image fields that aren't web URLs (or unwraps {url}), so a malformed photo costs the card
 * its picture rather than failing the whole card and a retry.
 */
function dropBadImages(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(dropBadImages);
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (!IMAGE_KEYS.has(k)) {
      dropBadImages(v);
      continue;
    }
    const raw = typeof v === "string" ? v : (v as { url?: unknown } | null)?.url;
    const url = typeof raw === "string" ? raw.trim() : "";
    if (WEB_URL.test(url)) o[k] = url;
    else delete o[k];
  }
}

/** Splits fallbackText off the tool args and validates the rest against the catalog schema. */
export function validateToolArgs(
  name: string,
  args: unknown
):
  | { ok: true; props: unknown; fallbackText: string }
  | { ok: false; error: string; fallbackText: string } {
  const obj = args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {};
  const fallbackText = typeof obj.fallbackText === "string" ? obj.fallbackText : "";
  delete obj.fallbackText;
  // Only the model's cards: system cards (MemoryConfirm, LocationRequest) come from the engine alone.
  if (!(MODEL_COMPONENTS as readonly string[]).includes(name))
    return { ok: false, error: `Unknown component "${name}"`, fallbackText };
  for (const k of ENGINE_ONLY[name as ModelComponent] ?? []) delete obj[k];
  dropBadImages(obj);
  if (name === "Blocks") {
    // An accent outside the palette costs the card its colour, not the whole card.
    if (!(ACCENTS as readonly unknown[]).includes(obj.accent)) delete obj.accent;
    const { blocks, firstError } = readBlocks(obj.blocks);
    if (!blocks.length) return { ok: false, error: firstError ?? "blocks: none", fallbackText };
    obj.blocks = blocks;
  }
  const res = validateComponent(name, obj);
  if (res.ok) return { ok: true, props: res.props, fallbackText: fallbackText || `${name} shown.` };
  return { ok: false, error: res.error, fallbackText };
}

export { validateComponent };

/** Catalog description for models without tool calling (prompted-JSON fallback). */
export function promptedCatalog(names: readonly ModelComponent[] = MODEL_COMPONENTS): string {
  const lines = names.map((n) => {
    const schema = jsonSchemaFor((MODEL_SCHEMAS[n] ?? catalogSchemas[n]) as unknown as z.ZodType);
    return `- ${n}: ${descriptions[n]}\n  props schema: ${JSON.stringify(schema)}`;
  });
  return [
    "You can show interactive components. To show one, write a fenced block exactly like:",
    "```component",
    '{"name": "Checklist", "props": { ... }, "fallbackText": "one-sentence summary"}',
    "```",
    "Props must match the schema. Never write HTML or code for UI. Available components:",
    ...lines,
  ].join("\n");
}
const BLOCK_STREAM: PartialJsonOptions = {
  prose: (key) => key === "text" || key === "content" || key === "body",
  keepOpen: (key) => key === "blocks",
};

/**
 * Props to show while a card's arguments are still streaming: what has been written so far that
 * already passes the schema, so the card renders before the call ends. Blocks grows block by block
 * with its text written live; other cards appear once their required fields are in, then grow an
 * item at a time. `within` reads the props from a field of the JSON (the prompted fence shape).
 * Null while nothing renders yet.
 */
export function partialProps(
  name: string,
  raw: string,
  within?: string
): Record<string, unknown> | null {
  const blocks = name === "Blocks";
  let value = parsePartialJson(raw, blocks ? BLOCK_STREAM : {});
  if (within) value = (value as Record<string, unknown> | undefined)?.[within];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = { ...(value as Record<string, unknown>) };
  if (blocks) {
    // The last block may still be open and not fit yet; it shows once it does.
    const ok = readBlocks(obj.blocks).blocks;
    const bad = checkBlocks(ok);
    const shown = bad ? ok.slice(0, bad.index) : ok;
    return shown.length ? { blocks: shown } : null;
  }
  delete obj.fallbackText;
  for (const k of ENGINE_ONLY[name as ModelComponent] ?? []) delete obj[k];
  const res = validateComponent(name, obj);
  return res.ok ? (res.props as Record<string, unknown>) : null;
}
