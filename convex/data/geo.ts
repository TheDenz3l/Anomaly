import type { GeoLocation } from "../lib/validators";
import type { WebCache } from "../web/cache";
import { HOUR } from "../web/cache";

/** Free geodata: Open-Meteo geocoding (no key), Nominatim (light use, UA required), Overpass. */

const UA = `AtlasAssistant/1.0 (${process.env.APP_CONTACT ?? "personal use"})`;

async function json(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "User-Agent": UA, ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10;
}

export type Place = GeoLocation & { countryCode?: string; timezone?: string };

export async function geocode(cache: WebCache, query: string): Promise<Place | null> {
  const key = `geo:${query.toLowerCase().trim()}`;
  const hit = await cache.get(key);
  if (hit) return JSON.parse(hit.content);
  let place: Place | null = null;
  try {
    const om = await json(
      `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: query.split(",")[0].trim(), count: "5", language: "en", format: "json" })}`
    );
    const parts = query
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .slice(1);
    const rows: any[] = om?.results ?? [];
    const r =
      rows.find((x) =>
        parts.every((p) =>
          [x.admin1, x.country, x.country_code].some((f) =>
            String(f ?? "")
              .toLowerCase()
              .startsWith(p)
          )
        )
      ) ?? rows[0];
    if (r) {
      place = {
        lat: r.latitude,
        lng: r.longitude,
        label: [r.name, r.admin1, r.country_code].filter(Boolean).join(", "),
        countryCode: r.country_code,
        timezone: r.timezone,
      };
    }
  } catch {
    /* fall through to Nominatim */
  }
  if (!place) {
    const rows = await json(
      `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: query, format: "jsonv2", limit: "1", addressdetails: "1" })}`
    );
    const r = rows?.[0];
    if (r) {
      place = {
        lat: Number(r.lat),
        lng: Number(r.lon),
        label: String(r.display_name).split(",").slice(0, 3).join(",").trim(),
        countryCode: r.address?.country_code?.toUpperCase(),
      };
    }
  }
  if (place) await cache.put(key, JSON.stringify(place), "application/json", 30 * 24 * HOUR);
  return place;
}

export async function reverseGeocode(
  cache: WebCache,
  lat: number,
  lng: number
): Promise<{ label: string; countryCode?: string }> {
  const key = `rgeo:${lat.toFixed(3)},${lng.toFixed(3)}`;
  const hit = await cache.get(key);
  if (hit) return JSON.parse(hit.content);
  try {
    const r = await json(
      `https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({ lat: String(lat), lon: String(lng), format: "jsonv2", zoom: "12" })}`
    );
    const a = r?.address ?? {};
    const out = {
      label:
        [a.city ?? a.town ?? a.village ?? a.suburb ?? a.county, a.state]
          .filter(Boolean)
          .join(", ") || "Your location",
      countryCode: a.country_code?.toUpperCase(),
    };
    await cache.put(key, JSON.stringify(out), "application/json", 30 * 24 * HOUR);
    return out;
  } catch {
    return { label: "Your location" };
  }
}

export type PoiResult = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distanceKm: number;
  address?: string;
  website?: string;
  openingHours?: string;
  kind: string;
};

const POI_TAGS: Record<string, string> = {
  cinema: '["amenity"="cinema"]',
  restaurant: '["amenity"="restaurant"]',
  cafe: '["amenity"="cafe"]',
  bar: '["amenity"~"^(bar|pub)$"]',
  pharmacy: '["amenity"="pharmacy"]',
  hospital: '["amenity"="hospital"]',
  park: '["leisure"="park"]',
  gym: '["leisure"="fitness_centre"]',
  supermarket: '["shop"="supermarket"]',
  library: '["amenity"="library"]',
  museum: '["tourism"="museum"]',
  hotel: '["tourism"="hotel"]',
  fuel: '["amenity"="fuel"]',
  ev_charging: '["amenity"="charging_station"]',
  atm: '["amenity"="atm"]',
  bakery: '["shop"="bakery"]',
};

export const POI_KINDS = Object.keys(POI_TAGS);

export async function findPlaces(
  cache: WebCache,
  center: { lat: number; lng: number },
  kind: string,
  opts: { radiusKm?: number; limit?: number; name?: string } = {}
): Promise<PoiResult[]> {
  const radius = Math.min(Math.max(opts.radiusKm ?? 8, 0.5), 30) * 1000;
  const limit = Math.min(opts.limit ?? 8, 20);
  const filter = POI_TAGS[kind] ?? `["amenity"="${kind.replace(/[^a-z_]/gi, "")}"]`;
  const nameFilter = opts.name ? `["name"~"${opts.name.replace(/["\\]/g, "")}",i]` : "";
  const key = `poi:${kind}:${opts.name ?? ""}:${center.lat.toFixed(2)},${center.lng.toFixed(2)}:${radius}`;
  const hit = await cache.get(key);
  let elements: any[];
  if (hit) elements = JSON.parse(hit.content);
  else {
    const q = `[out:json][timeout:20];(node${filter}${nameFilter}(around:${radius},${center.lat},${center.lng});way${filter}${nameFilter}(around:${radius},${center.lat},${center.lng}););out center tags 60;`;
    const res = await json(
      "https://overpass-api.de/api/interpreter",
      {
        method: "POST",
        body: new URLSearchParams({ data: q }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      25_000
    );
    elements = res?.elements ?? [];
    await cache.put(key, JSON.stringify(elements), "application/json", 24 * HOUR);
  }
  return (
    elements
      .map((el) => {
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        const t = el.tags ?? {};
        if (typeof lat !== "number" || typeof lng !== "number" || !t.name) return null;
        const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
        return {
          id: `osm_${el.type}_${el.id}`,
          name: String(t.name),
          lat,
          lng,
          distanceKm: haversineKm(center, { lat, lng }),
          address: street || undefined,
          website: t.website ?? t["contact:website"] ?? undefined,
          openingHours: t.opening_hours ?? undefined,
          kind,
        } satisfies PoiResult;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      // OSM often maps one venue as both a node and a building outline.
      .filter(
        (p, i, all) =>
          !all
            .slice(0, i)
            .some((q) => q.name.toLowerCase() === p.name.toLowerCase() && haversineKm(q, p) < 0.5)
      )
      .slice(0, limit)
  );
}
