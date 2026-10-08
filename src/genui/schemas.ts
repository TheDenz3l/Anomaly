import { z } from "zod";
import { planRows } from "./compute";

/**
 * Component catalog (PRD §3.3). The model never emits code — it calls typed tools whose
 * arguments must parse against these schemas before the client renders anything.
 */

const id = z.string().min(1);
/** A photo for one thing on a card. Models only have real image URLs from tool results or the user. */
const photo = z
  .string()
  .url()
  .optional()
  .describe("Photo URL from tool results or the user, when a picture helps. Never invent one.");

export const MovieShowtimesSchema = z.object({
  title: z.string().optional(),
  location: z.string(),
  date: z.string(),
  movies: z
    .array(
      z.object({
        id,
        title: z.string(),
        poster: z.string().url().optional(),
        year: z.number().int(),
        rating: z.string(),
        runtime: z.number().int().positive(),
        genres: z.array(z.string()),
        score: z.number().min(0).max(10),
        showtimes: z.array(
          z.object({
            theatreId: id,
            theatre: z.string(),
            distanceKm: z.number(),
            format: z.enum(["Standard", "IMAX", "Dolby", "3D"]),
            times: z.array(z.string()).min(1),
          })
        ),
      })
    )
    .min(1),
  /** Times are still being read from theatre websites. */
  timesLoading: z.boolean().optional(),
  attribution: z.string(),
});

export const MapCardSchema = z.object({
  title: z.string().optional(),
  center: z.object({ lat: z.number(), lng: z.number(), label: z.string() }),
  places: z
    .array(
      z.object({
        id,
        name: z.string(),
        subtitle: z.string().optional(),
        lat: z.number(),
        lng: z.number(),
        distanceKm: z.number().optional(),
      })
    )
    .min(1),
});

const point = z.object({ x: z.number(), y: z.number() });

export const ChartSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  unit: z.enum(["currency", "number", "percent"]),
  xLabel: z.string(),
  series: z.array(z.object({ name: z.string(), points: z.array(point).min(2) })).optional(),
  model: z
    .object({
      type: z.literal("compound"),
      principal: z.number().nonnegative(),
      annualRate: z.number(),
      years: z.number().int().min(1).max(60),
      contribution: z.object({
        label: z.string(),
        min: z.number(),
        max: z.number(),
        step: z.number().positive(),
        value: z.number(),
      }),
    })
    .optional(),
});

export const TableSchema = z.object({
  title: z.string().optional(),
  columns: z
    .array(z.object({ key: z.string(), label: z.string(), numeric: z.boolean().optional() }))
    .min(1),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
  caption: z.string().optional(),
});

export const CompareSchema = z.object({
  title: z.string().optional(),
  items: z
    .array(
      z.object({
        id,
        name: z.string().describe("A few words: it heads a narrow phone column."),
        subtitle: z.string().optional(),
        image: photo,
      })
    )
    .min(2)
    .max(3),
  rows: z.array(
    z.object({
      label: z.string(),
      values: z.array(z.string()).describe("One per item, in order; a short phrase each."),
      winner: z.number().int().optional(),
    })
  ),
  verdict: z.string().optional(),
});

export const TimelineSchema = z.object({
  title: z.string().optional(),
  events: z
    .array(
      z.object({
        date: z.string().describe("ISO date (2026-09-29), month (2026-09) or year."),
        title: z.string(),
        detail: z.string().optional(),
        image: photo,
      })
    )
    .min(1),
});

export const FormSchema = z.object({
  title: z.string(),
  submitLabel: z.string(),
  fields: z
    .array(
      z.object({
        id,
        label: z.string(),
        kind: z.enum(["text", "number", "select", "toggle"]),
        placeholder: z.string().optional(),
        options: z.array(z.string()).optional(),
        required: z.boolean().optional(),
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      })
    )
    .min(1),
});

export const StepperSchema = z.object({
  title: z.string(),
  steps: z.array(z.object({ title: z.string(), detail: z.string(), image: photo })).min(2),
});

export const ChecklistSchema = z.object({
  title: z.string(),
  groups: z
    .array(
      z.object({
        label: z.string(),
        items: z.array(z.object({ id, label: z.string(), checked: z.boolean().optional() })),
      })
    )
    .min(1),
});

export const ChoiceChipsSchema = z.object({
  prompt: z.string().optional(),
  multi: z.boolean().optional(),
  submitLabel: z.string().optional(),
  choices: z.array(z.object({ id, label: z.string() })).min(1),
});

const condition = z.enum(["clear", "partly", "cloudy", "rain", "storm", "snow", "fog", "night"]);

export const WeatherSchema = z.object({
  location: z.string(),
  updated: z.string(),
  now: z.object({
    tempC: z.number(),
    feelsLikeC: z.number(),
    condition,
    summary: z.string(),
    highC: z.number(),
    lowC: z.number(),
    windKmh: z.number(),
    humidity: z.number(),
    precipChance: z.number(),
  }),
  hourly: z.array(
    z.object({ time: z.string(), tempC: z.number(), condition, precipChance: z.number() })
  ),
  daily: z.array(z.object({ day: z.string(), highC: z.number(), lowC: z.number(), condition })),
});

export const ProductGridSchema = z.object({
  title: z.string().optional(),
  products: z
    .array(
      z.object({
        id,
        name: z.string(),
        brand: z.string(),
        price: z.number().positive(),
        currency: z.string(),
        rating: z.number().min(0).max(5).optional(),
        reviews: z.number().int().optional(),
        store: z.string(),
        badge: z.string().optional(),
        url: z.string().url().optional().describe("The product's page; tapping the card opens it."),
        image: z.string().url().optional().describe("A product photo URL from the page."),
      })
    )
    .min(1),
});

export const agentRole = z.enum([
  "search",
  "reader",
  "maps",
  "code",
  "vision",
  "memory-read",
  "verifier",
]);

export const SubagentPlanSchema = z.object({
  goal: z.string(),
  tasks: z
    .array(
      z.object({
        id,
        role: agentRole,
        brief: z.string(),
        model: z.string(),
        estTokens: z.number().int(),
      })
    )
    .min(1)
    .max(5),
  costEstimateUsd: z.number(),
  budget: z.object({
    maxTokens: z.number().int(),
    maxSearches: z.number().int(),
    maxMinutes: z.number(),
  }),
});

export const SubagentTimelineSchema = z.object({
  live: z.boolean(),
  runs: z
    .array(
      z.object({
        id,
        role: agentRole,
        brief: z.string(),
        model: z.string(),
        durationMs: z.number().int(),
        sourcesRead: z.number().int(),
        tokens: z.number().int(),
        outcome: z.enum(["done", "failed"]),
        result: z.string(),
      })
    )
    .min(1)
    .max(5),
});

export const ResearchPlanSchema = z.object({
  question: z.string(),
  steps: z.array(z.object({ id, title: z.string(), queries: z.array(z.string()) })).min(1),
  depth: z.number().int().min(1).max(3),
  budgetUsd: z.number(),
});

export const ResearchProgressSchema = z.object({
  live: z.boolean(),
  durationMs: z.number().int(),
  workers: z.array(z.object({ id, label: z.string(), sources: z.number().int() })).min(1),
  sourcesFound: z.number().int(),
  sourcesKept: z.number().int(),
});

/* System components — rendered by the app, not offered to the model as tools. */

export const LocationRequestSchema = z.object({ reason: z.string(), fallbackCity: z.string() });

export const MemoryConfirmSchema = z.object({
  text: z.string(),
  category: z.enum(["preference", "fact", "person", "place", "work"]),
  scope: z.enum(["global", "thread"]),
  confidence: z.number().min(0).max(1),
});

/*
 * Blocks: an answer composed from small native pieces, in the order the model writes them, so it
 * can render block by block while the call streams. Inputs and computed rows make small tools
 * (scalers, splitters, calculators) that recalculate on the phone without another model call.
 */

const ident = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "letters, digits and _ only, starting with a letter");
const webUrl = z.string().url();

export const HeadingBlock = z.object({
  type: z.literal("heading"),
  text: z.string().describe("Under 40 characters."),
  subtitle: z.string().optional(),
  image: webUrl.optional().describe("A cover photo shown above the heading."),
});

export const TextBlock = z.object({
  type: z.literal("text"),
  text: z
    .string()
    .describe(
      "Markdown: short paragraphs, **bold**, lists, tables, [title](url) links, [n] citations."
    ),
});

export const ImagesBlock = z.object({
  type: z.literal("images"),
  images: z
    .array(z.object({ url: webUrl, alt: z.string() }))
    .min(1)
    .max(8)
    .describe("Image URLs from tool results or the user only."),
});

export const StatsBlock = z.object({
  type: z.literal("stats"),
  items: z
    .array(
      z.object({
        value: z.string().describe("The figure as shown: '44%', '$1.2B', '3 h'."),
        label: z.string(),
        note: z.string().optional(),
      })
    )
    .min(1)
    .max(4),
});

export const FactsBlock = z.object({
  type: z.literal("facts"),
  title: z.string().optional(),
  image: webUrl.optional().describe("A photo of what the facts describe, shown at the top."),
  items: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .min(1)
    .max(12),
});

export const ItemsBlock = z.object({
  type: z.literal("items"),
  title: z.string().optional(),
  items: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string().optional(),
        meta: z.string().optional().describe("A short tag: price, time, rating, distance."),
        image: webUrl.optional(),
        url: webUrl.optional(),
      })
    )
    .min(1)
    .max(12),
});

export const StepsBlock = z.object({
  type: z.literal("steps"),
  title: z.string().optional(),
  checkable: z.boolean().optional().describe("True for things the user ticks off as they go."),
  steps: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string().optional(),
        when: z.string().optional().describe("Shown beside the step: '1:30 PM', 'Day 2'."),
        image: webUrl.optional(),
      })
    )
    .min(1)
    .max(16),
});

export const CalloutBlock = z.object({
  type: z.literal("callout"),
  tone: z.enum(["tip", "note", "warning"]),
  text: z.string(),
});

export const InputBlock = z.object({
  type: z.literal("input"),
  id: ident.describe("Name formulas use for this value."),
  label: z.string(),
  kind: z
    .enum(["stepper", "slider", "number", "choice", "toggle"])
    .describe("toggle is 1 when on, 0 when off; choice takes the picked option's value."),
  value: z.number(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  prefix: z.string().optional().describe("Shown before the value, like '$'."),
  unit: z.string().optional().describe("Shown after the value, like 'people' or '%'."),
  options: z
    .array(z.object({ label: z.string(), value: z.number() }))
    .optional()
    .describe("Required for choice."),
});

export const ComputedBlock = z.object({
  type: z.literal("computed"),
  title: z.string().optional(),
  rows: z
    .array(
      z.object({
        id: ident.optional().describe("Lets other formulas use this row's value."),
        label: z.string(),
        formula: z
          .string()
          .describe(
            "Arithmetic over input ids and other rows' ids: + - * / % ^ ( ), comparisons, min max round(x,digits) floor ceil abs sqrt pow clamp(x,lo,hi) if(cond,a,b)."
          ),
        format: z
          .enum(["number", "integer", "currency", "percent"])
          .optional()
          .describe("percent adds a % sign to the value as is: 15 shows as 15%."),
        decimals: z.number().int().min(0).max(4).optional(),
        unit: z.string().optional(),
        total: z.boolean().optional().describe("Shown large, as the result."),
      })
    )
    .min(1)
    .max(12),
  currency: z.string().optional().describe("ISO code for currency rows; USD when omitted."),
  note: z.string().optional(),
});

export const DividerBlock = z.object({ type: z.literal("divider") });

export const BarsBlock = z.object({
  type: z.literal("bars"),
  title: z.string().optional(),
  unit: z.string().optional().describe("Shown after each value, like 'm' or 'M copies'."),
  items: z
    .array(
      z.object({
        label: z.string(),
        value: z.number(),
        display: z
          .string()
          .optional()
          .describe("The value as shown when the bare number isn't right: '~2.3M', '146 m'."),
        note: z.string().optional().describe("Shown when the bar is tapped."),
      })
    )
    .min(2)
    .max(10),
});

export const QuizBlock = z.object({
  type: z.literal("quiz"),
  question: z.string(),
  choices: z.array(z.string()).min(2).max(5),
  answer: z.number().int().min(0).describe("Index of the right choice."),
  explanation: z.string().optional().describe("Shown once the user picks."),
});

export const CardsBlock = z.object({
  type: z.literal("cards"),
  title: z.string().optional(),
  cards: z
    .array(z.object({ front: z.string(), back: z.string() }))
    .min(1)
    .max(10)
    .describe("Tap to turn over: term and meaning, myth and fact, question and answer."),
});

export const QuoteBlock = z.object({
  type: z.literal("quote"),
  text: z.string(),
  cite: z.string().optional().describe("Who said or wrote it."),
});

/** Colour themes for a Blocks answer, named for the subjects they suit. */
export const ACCENTS = ["sand", "ocean", "forest", "citrus", "violet", "rose", "steel"] as const;
export type Accent = (typeof ACCENTS)[number];

export const BlockSchema = z.discriminatedUnion("type", [
  HeadingBlock,
  TextBlock,
  ImagesBlock,
  StatsBlock,
  FactsBlock,
  ItemsBlock,
  StepsBlock,
  CalloutBlock,
  InputBlock,
  ComputedBlock,
  DividerBlock,
  BarsBlock,
  QuizBlock,
  CardsBlock,
  QuoteBlock,
]);

export type Block = z.infer<typeof BlockSchema>;

/**
 * Checks what one block can't check alone: choice inputs have options, ids are unique, and every
 * formula parses and names only inputs and other rows, without loops (./compute.ts). Returns the
 * index of the first block that fails with the reason, or null when all pass.
 */
export function checkBlocks(blocks: Block[]): { index: number; error: string } | null {
  for (const [index, b] of blocks.entries()) {
    if (b.type === "quiz" && b.answer >= b.choices.length)
      return {
        index,
        error: `quiz: answer ${b.answer} is not one of the ${b.choices.length} choices`,
      };
  }
  const ids = new Set<string>();
  for (const [index, b] of blocks.entries()) {
    if (b.type !== "input") continue;
    if (b.kind === "choice" && !b.options?.length)
      return { index, error: `input ${b.id}: choice needs options` };
    if (ids.has(b.id.toLowerCase())) return { index, error: `id ${b.id} is used twice` };
    ids.add(b.id.toLowerCase());
  }
  const plan = planRows(blocks);
  return "error" in plan ? plan : null;
}

export const BlocksSchema = z.object({
  accent: z.enum(ACCENTS).optional(),
  blocks: z
    .array(BlockSchema)
    .min(1)
    .max(40)
    .superRefine((blocks, ctx) => {
      const bad = checkBlocks(blocks);
      if (bad) ctx.addIssue({ code: "custom", path: [bad.index], message: bad.error });
    }),
});

export const catalogSchemas = {
  MovieShowtimes: MovieShowtimesSchema,
  MapCard: MapCardSchema,
  Chart: ChartSchema,
  Table: TableSchema,
  Compare: CompareSchema,
  Timeline: TimelineSchema,
  Form: FormSchema,
  Stepper: StepperSchema,
  Checklist: ChecklistSchema,
  ChoiceChips: ChoiceChipsSchema,
  Weather: WeatherSchema,
  ProductGrid: ProductGridSchema,
  SubagentPlan: SubagentPlanSchema,
  SubagentTimeline: SubagentTimelineSchema,
  ResearchPlan: ResearchPlanSchema,
  ResearchProgress: ResearchProgressSchema,
  LocationRequest: LocationRequestSchema,
  MemoryConfirm: MemoryConfirmSchema,
  Blocks: BlocksSchema,
} as const;

export type CatalogName = keyof typeof catalogSchemas;
export type CatalogProps<N extends CatalogName> = z.infer<(typeof catalogSchemas)[N]>;

/** Rules a schema can't carry: the model's tool schemas are generated from these schemas, so they stay plain objects. */
const extraChecks: { [N in CatalogName]?: (props: CatalogProps<N>) => string | null } = {
  Chart: (p) =>
    p.model || p.series?.length ? null : "series: give a model or at least one series",
};

export function validateComponent(
  name: string,
  props: unknown
): { ok: true; props: unknown } | { ok: false; error: string } {
  if (!Object.prototype.hasOwnProperty.call(catalogSchemas, name))
    return { ok: false, error: `Unknown component "${name}"` };
  const schema = (catalogSchemas as Record<string, z.ZodType>)[name];
  const result = schema.safeParse(props);
  if (result.success) {
    const problem = extraChecks[name as CatalogName]?.(result.data as never);
    return problem ? { ok: false, error: problem } : { ok: true, props: result.data };
  }
  const first = result.error.issues[0];
  return {
    ok: false,
    error: `${first?.path.join(".") || "props"}: ${first?.message ?? "invalid"}`,
  };
}
