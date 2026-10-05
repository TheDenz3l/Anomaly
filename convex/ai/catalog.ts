import { z } from "zod";
import { catalogSchemas, validateComponent } from "../../src/genui/schemas";
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
  Compare: "Side-by-side comparison of 2-3 items with per-row winners and a verdict.",
  Timeline: "Dated events in order (history, schedules, roadmaps).",
  Form: "Collect structured input from the user (booking details, preferences). Nothing is sent anywhere until they submit.",
  Stepper: "Step-by-step instructions the user follows in order (setup guides, recipes).",
  Checklist: "Grouped checkable items (packing lists, to-dos).",
  ChoiceChips:
    "Tappable options for the user's next reply: clarifying questions or follow-up suggestions. Set multi for multi-select.",
  Weather:
    "Current conditions plus hourly and daily forecast. Prefer get_weather, which builds this for you.",
  ProductGrid:
    "Product picks with price, rating, store. Only use real products with prices you found.",
};

const FALLBACK_HINT =
  "One or two plain sentences conveying the same information, used for voice and text-only clients.";

function cleanSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$schema" || k === "propertyNames" || k === "$id") continue;
    out[k] = cleanSchema(v);
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
    const schema = (catalogSchemas[name] as unknown as z.ZodObject).extend({
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

export function isCatalogName(name: string): boolean {
  return name in catalogSchemas;
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
  const res = validateComponent(name, obj);
  if (res.ok) return { ok: true, props: res.props, fallbackText: fallbackText || `${name} shown.` };
  return { ok: false, error: res.error, fallbackText };
}

export { validateComponent };

/** Catalog description for models without tool calling (prompted-JSON fallback). */
export function promptedCatalog(names: readonly ModelComponent[] = MODEL_COMPONENTS): string {
  const lines = names.map((n) => {
    const schema = jsonSchemaFor(catalogSchemas[n] as unknown as z.ZodType);
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
