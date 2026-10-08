import { BlockSchema, type Block } from "../../src/genui/schemas";
import { z } from "zod";

/**
 * Lenient reading of a Blocks call. Models stray from the schema in predictable ways: "paragraph"
 * for text, one image as a bare url, a list of strings, numbers where labels are strings, currency
 * set on a row. Those are mapped onto the catalog's blocks. A block that still doesn't fit is
 * dropped rather than failing the whole answer, which would cost a full retry while the user waits.
 */

type Raw = Record<string, unknown>;

const TYPES: Record<string, Block["type"]> = {
  title: "heading",
  header: "heading",
  h1: "heading",
  h2: "heading",
  section: "heading",
  paragraph: "text",
  markdown: "text",
  body: "text",
  prose: "text",
  list: "text",
  bullets: "text",
  image: "images",
  gallery: "images",
  photos: "images",
  stat: "stats",
  metrics: "stats",
  kpis: "stats",
  details: "facts",
  keyvalue: "facts",
  key_value: "facts",
  info: "facts",
  cards: "items",
  products: "items",
  places: "items",
  timeline: "steps",
  checklist: "steps",
  instructions: "steps",
  note: "callout",
  tip: "callout",
  warning: "callout",
  alert: "callout",
  separator: "divider",
  hr: "divider",
  slider: "input",
  stepper: "input",
  toggle: "input",
  number: "input",
  choice: "input",
  calculation: "computed",
  calculator: "computed",
  result: "computed",
  results: "computed",
  output: "computed",
};

const KINDS: Record<string, string> = {
  range: "slider",
  counter: "stepper",
  switch: "toggle",
  boolean: "toggle",
  checkbox: "toggle",
  select: "choice",
  radio: "choice",
  segmented: "choice",
  text: "number",
};

const FORMATS: Record<string, string> = {
  money: "currency",
  usd: "currency",
  dollars: "currency",
  "%": "percent",
  int: "integer",
  decimal: "number",
};

const obj = (v: unknown): Raw =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {};
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
const num = (v: unknown): unknown => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return v;
};
const pick = (o: Raw, ...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined);
const list = (o: Raw, ...keys: string[]) => {
  const v = pick(o, ...keys);
  return Array.isArray(v) ? v : undefined;
};

function normalizeBlock(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const b: Raw = { ...(input as Raw) };
  const given = String(b.type ?? "")
    .toLowerCase()
    .trim();
  const type = TYPES[given] ?? given;
  b.type = type;
  switch (type) {
    case "heading":
      b.text ??= str(pick(b, "title", "content", "label"));
      break;
    case "text": {
      if (typeof b.text === "string") break;
      const items = list(b, "items", "bullets");
      b.text = items
        ? items.map((i) => `- ${str(i) ?? str(obj(i).text) ?? str(obj(i).title) ?? ""}`).join("\n")
        : str(pick(b, "content", "markdown", "body", "value"));
      break;
    }
    case "images": {
      const items = list(b, "images", "items", "photos") ?? (b.url ? [b] : undefined);
      b.images = items?.map((i) =>
        typeof i === "string"
          ? { url: i, alt: "" }
          : { url: pick(obj(i), "url", "src"), alt: str(pick(obj(i), "alt", "caption")) ?? "" }
      );
      break;
    }
    case "stats":
    case "facts":
      b.items = list(b, "items", "stats", "facts", "rows")?.map((i) => {
        const o = { ...obj(i) };
        o.label = str(pick(o, "label", "key", "name", "title")) ?? o.label;
        o.value = str(o.value) ?? o.value;
        if (o.note !== undefined) o.note = str(o.note);
        return o;
      });
      break;
    case "items":
      b.items = list(b, "items", "cards", "products", "places")?.map((i) => {
        if (typeof i === "string") return { title: i };
        const o = { ...obj(i) };
        o.title = str(pick(o, "title", "name", "label")) ?? o.title;
        o.detail ??= str(pick(o, "description", "subtitle", "text"));
        if (o.meta !== undefined) o.meta = str(o.meta);
        return o;
      });
      break;
    case "steps":
      if (given === "checklist") b.checkable ??= true;
      b.steps = list(b, "steps", "items", "events")?.map((s) => {
        if (typeof s === "string") return { title: s };
        const o = { ...obj(s) };
        o.title = str(pick(o, "title", "label", "text", "name")) ?? o.title;
        o.detail ??= str(pick(o, "description", "body"));
        o.when ??= str(pick(o, "time", "date"));
        return o;
      });
      break;
    case "callout":
      if (!["tip", "note", "warning"].includes(String(b.tone)))
        b.tone =
          given === "warning" || given === "alert" ? "warning" : given === "tip" ? "tip" : "note";
      b.text ??= str(pick(b, "content", "body", "message"));
      break;
    case "input": {
      const kind = String(b.kind ?? (given !== "input" ? given : "")).toLowerCase();
      b.kind = KINDS[kind] ?? kind;
      b.id ??= b.name;
      b.value = num(
        pick(b, "value", "default", "initial") ?? (b.kind === "toggle" ? 0 : (b.min ?? 0))
      );
      for (const k of ["min", "max", "step"]) if (b[k] !== undefined) b[k] = num(b[k]);
      b.options = list(b, "options", "choices")?.map((o) =>
        typeof o === "object" && o
          ? { label: str(pick(obj(o), "label", "name")), value: num(obj(o).value) }
          : { label: String(o), value: num(o) }
      );
      break;
    }
    case "computed":
      b.rows = list(b, "rows", "items", "results", "outputs")?.map((r) => {
        const o = { ...obj(r) };
        o.label = str(pick(o, "label", "name", "title")) ?? o.label;
        o.formula = str(pick(o, "formula", "expression", "expr", "value")) ?? o.formula;
        if (typeof o.currency === "string") {
          b.currency ??= o.currency;
          o.format ??= "currency";
          delete o.currency;
        }
        if (o.format !== undefined) {
          const f = String(o.format).toLowerCase();
          o.format = FORMATS[f] ?? f;
          if (!["number", "integer", "currency", "percent"].includes(o.format as string))
            delete o.format;
        }
        if (o.decimals !== undefined) o.decimals = num(o.decimals);
        return o;
      });
      break;
  }
  return b;
}

/** The blocks that fit the catalog, in order, and why the first one that didn't was dropped. */
const CANONICAL = new Set<string>(BlockSchema.options.map((o) => o.shape.type.value));
const FIELD: Partial<Record<Block["type"], string>> = {
  images: "images",
  stats: "items",
  facts: "items",
  items: "items",
  steps: "steps",
  computed: "rows",
};

/**
 * Some models key a block by its type instead of setting `type`: {"heading": "Plan"},
 * {"input": {...}}, or several at once, {"title": "...", "input": [...], "computed": {...}}.
 * Each such key becomes its own block, in the order written.
 */
function expandBlock(raw: unknown): unknown[] {
  const o = obj(raw);
  if (o.type !== undefined || !Object.keys(o).length) return [raw];
  const out: unknown[] = [];
  for (const [key, value] of Object.entries(o)) {
    const type = TYPES[key.toLowerCase()] ?? key.toLowerCase();
    if (!CANONICAL.has(type)) continue;
    const t = type as Block["type"];
    if (typeof value === "string") out.push({ type: key, text: value });
    else if (Array.isArray(value)) {
      const field = FIELD[t];
      if (field) out.push({ type: key, [field]: value });
      else
        for (const v of value)
          out.push(typeof v === "string" ? { type: key, text: v } : { type: key, ...obj(v) });
    } else out.push({ type: key, ...obj(value) });
  }
  return out.length ? out : [raw];
}

export function readBlocks(raw: unknown): { blocks: Block[]; firstError?: string } {
  if (!Array.isArray(raw)) return { blocks: [], firstError: "blocks: expected an array" };
  const blocks: Block[] = [];
  let firstError: string | undefined;
  raw.flatMap(expandBlock).forEach((x, i) => {
    const r = BlockSchema.safeParse(normalizeBlock(x));
    if (r.success) blocks.push(r.data);
    else {
      const issue = r.error.issues[0];
      firstError ??= `blocks.${[i, ...(issue?.path ?? [])].join(".")}: ${issue?.message ?? "invalid"}`;
    }
  });
  return { blocks, firstError };
}
const url = z.string().url();

/**
 * What models see for ui_Blocks: one flat block shape whose `type` says which fields apply. The
 * catalog's union of eleven shapes is exact, but some endpoints drop anyOf from tool schemas and
 * the model then invents its own; flat fields survive everywhere. readBlocks maps the result onto
 * the catalog.
 */
export const ModelBlocksSchema = z.object({
  blocks: z
    .array(
      z.object({
        type: z
          .enum([
            "heading",
            "text",
            "images",
            "stats",
            "facts",
            "items",
            "steps",
            "callout",
            "input",
            "computed",
            "divider",
          ])
          .describe(
            "Fields per type. heading: text, subtitle. text: text. images: images. stats: items {value, label, note}, up to 4. facts: title, items {label, value}. items: title, items {title, detail, meta, image, url}. steps: title, steps, checkable. callout: tone, text. input: id, label, kind, value, min, max, step, prefix, unit, options. computed: title, rows, currency, note. divider: none."
          ),
        text: z
          .string()
          .optional()
          .describe(
            "heading: under 40 characters. text and callout: Markdown, with [title](url) links and [n] citations."
          ),
        subtitle: z.string().optional(),
        title: z.string().optional(),
        images: z
          .array(z.object({ url, alt: z.string() }))
          .optional()
          .describe("Image URLs from tool results or the user only."),
        items: z
          .array(
            z.object({
              label: z.string().optional(),
              value: z.string().optional().describe("As shown: '44%', '$1.2B', '3 h'."),
              note: z.string().optional(),
              title: z.string().optional(),
              detail: z.string().optional(),
              meta: z.string().optional().describe("A short tag: price, time, rating, distance."),
              image: url.optional(),
              url: url.optional(),
            })
          )
          .optional(),
        steps: z
          .array(
            z.object({
              title: z.string(),
              detail: z.string().optional(),
              when: z.string().optional().describe("Shown beside the step: '1:30 PM', 'Day 2'."),
            })
          )
          .optional(),
        checkable: z.boolean().optional().describe("steps the user ticks off as they go."),
        tone: z.enum(["tip", "note", "warning"]).optional(),
        id: z.string().optional().describe("input: the name formulas use, letters, digits and _."),
        label: z.string().optional(),
        kind: z
          .enum(["stepper", "slider", "number", "choice", "toggle"])
          .optional()
          .describe("toggle is 1 when on, 0 when off; choice takes the picked option's value."),
        value: z.number().optional().describe("input: starting value."),
        min: z.number().optional(),
        max: z.number().optional(),
        step: z.number().optional(),
        prefix: z.string().optional().describe("Shown before the value, like '$'."),
        unit: z.string().optional().describe("Shown after the value, like 'people' or '%'."),
        options: z.array(z.object({ label: z.string(), value: z.number() })).optional(),
        rows: z
          .array(
            z.object({
              id: z.string().optional().describe("Lets other formulas use this row's value."),
              label: z.string(),
              formula: z
                .string()
                .describe(
                  "Arithmetic over input ids and row ids: + - * / % ^ ( ), comparisons, and/or, a ? b : c, min max round(x,digits) floor ceil abs sqrt pow clamp(x,lo,hi) if(cond,a,b)."
                ),
              format: z
                .enum(["number", "integer", "currency", "percent"])
                .optional()
                .describe("percent adds a % sign to the value as is: 15 shows as 15%."),
              decimals: z.number().int().optional(),
              unit: z.string().optional(),
              total: z.boolean().optional().describe("Shown large, as the result."),
            })
          )
          .optional(),
        currency: z.string().optional().describe("ISO code for currency rows; USD when omitted."),
        note: z.string().optional(),
      })
    )
    .min(1)
    .max(40),
});
