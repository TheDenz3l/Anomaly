import { ConvexError } from "convex/values";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { findPlaces, geocode, POI_KINDS } from "../data/geo";
import { forecast } from "../data/weather";
import { decryptSecret } from "../lib/crypto";
import { webCache } from "../web/cache";
import { searchWeb, type SearchConfig } from "../web/providers";

/**
 * Live data an OpenUI card fetches on the phone with Query(…), again whenever a $variable in its
 * arguments changes, without asking the model (convex/cardTools.ts serves them). Read-only, and
 * scoped to the signed-in user's own settings. `doc` is what the model is told each one returns.
 */

type Tool<A extends z.ZodType> = {
  args: A;
  doc: string;
  run: (ctx: ActionCtx, userId: Id<"users">, args: z.infer<A>) => Promise<unknown>;
};
const tool = <A extends z.ZodType>(t: Tool<A>) => t;

async function place(ctx: ActionCtx, query: string) {
  const p = await geocode(webCache(ctx), query.trim());
  if (!p || p.lat === undefined || p.lng === undefined)
    throw new ConvexError(`Couldn't find "${query}" on the map.`);
  return { label: p.label, lat: p.lat, lng: p.lng };
}

/** The user's web search setup, as their replies use it. */
export async function userSearch(ctx: ActionCtx, userId: Id<"users">): Promise<SearchConfig> {
  const s = await ctx.runQuery(internal.settings.forUser, { userId });
  return {
    provider: s.searchProvider,
    key: s.searchKeyCipher ? await decryptSecret(s.searchKeyCipher) : undefined,
    url: s.searchUrl,
  };
}

export const OPENUI_TOOLS = {
  weather: tool({
    args: z.object({ location: z.string().min(1).max(120) }),
    doc: "weather({location: string}) → {location, updated, now: {tempC, feelsLikeC, condition, summary, highC, lowC, windKmh, humidity, precipChance}, hourly: [{time, tempC, condition, precipChance}], daily: [{day, highC, lowC, condition}]}. Show it with Weather(w).",
    run: async (ctx, _userId, a) => forecast(webCache(ctx), await place(ctx, a.location)),
  }),
  places: tool({
    args: z.object({
      kind: z.enum(POI_KINDS as [string, ...string[]]),
      near: z.string().min(1).max(120),
      name: z.string().max(60).optional(),
      limit: z.number().int().min(1).max(15).optional(),
    }),
    doc: `places({kind, near: string, name?: string, limit?: number}) → {center: {label, lat, lng}, places: [{name, lat, lng, distanceKm, address, website, hours}]}, nearest first, from OpenStreetMap. kind is one of: ${POI_KINDS.join(", ")}. Show them with Map(p.places, title, p.center).`,
    run: async (ctx, _userId, a) => {
      const center = await place(ctx, a.near);
      const found = await findPlaces(webCache(ctx), center, a.kind, {
        limit: a.limit ?? 8,
        name: a.name,
      });
      return {
        center,
        places: found.map((p) => ({
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          distanceKm: p.distanceKm,
          address: p.address ?? "",
          website: p.website ?? "",
          hours: p.openingHours ?? "",
        })),
      };
    },
  }),
  search: tool({
    args: z.object({
      query: z.string().min(2).max(200),
      limit: z.number().int().min(1).max(8).optional(),
    }),
    doc: 'search({query: string, limit?: number}) → {results: [{title, url, snippet}]}, live web results. Show them with @Each(s.results, "r", Card(r.title, r.snippet, null, null, Action([@OpenUrl(r.url)]))).',
    run: async (ctx, userId, a) => {
      const found = await searchWeb(ctx, await userSearch(ctx, userId), a.query, {
        limit: a.limit ?? 5,
        live: true,
      });
      return {
        results: found.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      };
    },
  }),
};

export type OpenUIToolName = keyof typeof OPENUI_TOOLS;

export const isOpenUITool = (name: string): name is OpenUIToolName =>
  Object.prototype.hasOwnProperty.call(OPENUI_TOOLS, name);
