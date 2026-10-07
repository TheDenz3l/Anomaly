import { z } from "zod";

/**
 * Component catalog (PRD §3.3). The model never emits code — it calls typed tools whose
 * arguments must parse against these schemas before the client renders anything.
 */

const id = z.string().min(1);

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
  steps: z.array(z.object({ title: z.string(), detail: z.string() })).min(2),
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
} as const;

export type CatalogName = keyof typeof catalogSchemas;
export type CatalogProps<N extends CatalogName> = z.infer<(typeof catalogSchemas)[N]>;

export function validateComponent(
  name: string,
  props: unknown
): { ok: true; props: unknown } | { ok: false; error: string } {
  const schema = (catalogSchemas as Record<string, z.ZodType>)[name];
  if (!schema) return { ok: false, error: `Unknown component "${name}"` };
  const result = schema.safeParse(props);
  if (result.success) return { ok: true, props: result.data };
  const first = result.error.issues[0];
  return {
    ok: false,
    error: `${first?.path.join(".") || "props"}: ${first?.message ?? "invalid"}`,
  };
}
