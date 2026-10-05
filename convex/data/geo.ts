import type { GeoLocation } from "../lib/validators";
import type { WebCache } from "../web/cache";
import { HOUR } from "../web/cache";

/** Free geodata: Open-Meteo geocoding (no key), Nominatim (light use, UA required), Overpass. */

const UA = `AtlasAssistant/1.0 (${process.env.APP_CONTACT ?? "personal use"})`;

async function json(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal?.addEventListener("abort", () => controller.abort());
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

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const OVERPASS_STAGGER_MS = 4000;

/**
 * Overpass instances are often overloaded (406 without an Accept header, 429, 504, or a 200 whose
 * remark says the query timed out). Ask the main instance first and bring in a mirror every few
 * seconds, or at once when one fails; the first good answer wins.
 */
function overpass(query: string, signal?: AbortSignal): Promise<any> {
  const init: RequestInit = {
    signal,
    method: "POST",
    body: new URLSearchParams({ data: query }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
  };
  return new Promise((resolve, reject) => {
    let next = 0;
    let failed = 0;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const settle = () => {
      settled = true;
      timers.forEach(clearTimeout);
    };
    const launch = () => {
      if (settled || next >= OVERPASS.length) return;
      const url = OVERPASS[next++];
      json(url, init, 20_000)
        .then((res) => {
          const remark = typeof res?.remark === "string" ? res.remark : "";
          if (
            !Array.isArray(res?.elements) ||
            (/error|timed out/i.test(remark) && !res.elements.length)
          )
            throw new Error(`${new URL(url).hostname}: ${remark || "no elements"}`);
          return res;
        })
        .then(
          (res) => {
            if (settled) return;
            settle();
            resolve(res);
          },
          (err) => {
            failed++;
            if (settled) return;
            if (failed >= OVERPASS.length) {
              settle();
              reject(err);
            } else launch();
          }
        );
      if (next < OVERPASS.length) timers.push(setTimeout(launch, OVERPASS_STAGGER_MS));
    };
    launch();
  });
}

/** Search words per kind for Photon, which needs a query alongside its tag filter. */
const POI_PHRASES: Record<string, string> = {
  cinema: "cinema",
  restaurant: "restaurant",
  cafe: "cafe",
  bar: "bar",
  pharmacy: "pharmacy",
  hospital: "hospital",
  park: "park",
  gym: "gym",
  supermarket: "supermarket",
  library: "library",
  museum: "museum",
  hotel: "hotel",
  fuel: "fuel",
  ev_charging: "charging station",
  atm: "atm",
  bakery: "bakery",
};

/** Places of one kind inside the search box, shaped like Overpass elements. Null when Nominatim can't answer. */
function boxAround(center: { lat: number; lng: number }, radiusM: number) {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  return {
    s: center.lat - dLat,
    w: center.lng - dLng,
    n: center.lat + dLat,
    e: center.lng + dLng,
  };
}

const OSM_TYPES: Record<string, string> = { N: "node", W: "way", R: "relation" };

/**
 * Photon (komoot's OpenStreetMap search) answers in a second or two from shared cloud IPs, where
 * Nominatim rate-limits and Overpass often times out. It leaves out tags like website, so the
 * nearest results get theirs from the OSM API. Shaped like Overpass elements.
 */
async function photonPlaces(
  center: { lat: number; lng: number },
  radiusM: number,
  kind: string,
  name?: string,
  signal?: AbortSignal
): Promise<any[]> {
  const tag = POI_TAGS[kind]?.match(/\["(\w+)"(=|~)"([^"]+)"\]/);
  if (!tag) throw new Error(`No Photon mapping for ${kind}`);
  const [, key, op, value] = tag;
  const values = op === "=" ? [value] : value.replace(/^\^\(|\)\$$/g, "").split("|");
  const box = boxAround(center, radiusM);
  const params = new URLSearchParams({
    q: name || POI_PHRASES[kind] || values[0],
    lat: String(center.lat),
    lon: String(center.lng),
    limit: "40",
    bbox: `${box.w},${box.s},${box.e},${box.n}`,
  });
  for (const v of values) params.append("osm_tag", `${key}:${v}`);
  const res = await json(`https://photon.komoot.io/api/?${params}`, { signal }, 8000);
  const nearest = ((res?.features ?? []) as any[])
    .map((f) => ({
      type: OSM_TYPES[f.properties?.osm_type] ?? "node",
      id: f.properties?.osm_id,
      lat: f.geometry?.coordinates?.[1],
      lon: f.geometry?.coordinates?.[0],
      tags: {
        name: f.properties?.name,
        "addr:housenumber": f.properties?.housenumber,
        "addr:street": f.properties?.street,
      } as Record<string, string | undefined>,
    }))
    .filter((el) => el.id && typeof el.lat === "number" && el.tags.name)
    .sort(
      (a, b) =>
        haversineKm(center, { lat: a.lat, lng: a.lon }) -
        haversineKm(center, { lat: b.lat, lng: b.lon })
    )
    .slice(0, 12);
  await Promise.all(
    nearest.map(async (el) => {
      try {
        const full = await json(
          `https://api.openstreetmap.org/api/0.6/${el.type}/${el.id}.json`,
          { headers: { Accept: "application/json" }, signal },
          5000
        );
        el.tags = { ...el.tags, ...(full?.elements?.[0]?.tags ?? {}) };
      } catch {
        /* keep what Photon had */
      }
    })
  );
  return nearest;
}

/** The first answer wins: the primary source, then the fallback once the primary is slow or fails. */
function firstAnswer<T>(
  primary: Promise<T>,
  fallback: () => Promise<T>,
  afterMs: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = 1;
    let fellBack = false;
    const ok = (v: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const fail = (err: unknown) => {
      pending--;
      if (settled) return;
      if (!fellBack) startFallback();
      else if (pending === 0) {
        settled = true;
        reject(err);
      }
    };
    const startFallback = () => {
      if (fellBack || settled) return;
      fellBack = true;
      pending++;
      fallback().then(ok, fail);
    };
    const timer = setTimeout(startFallback, afterMs);
    primary.then(ok, fail);
  });
}

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
    // A bounding box is far cheaper for Overpass than "around"; results are trimmed to the radius below.
    const box = boxAround(center, radius);
    const q = `[out:json][timeout:15];nwr${filter}${nameFilter}(${box.s},${box.w},${box.n},${box.e});out center tags 60;`;
    // The slower source is cancelled once one answers, so nothing runs past the action.
    const stop = new AbortController();
    elements = await firstAnswer(
      overpass(q, stop.signal).then((res) => res?.elements ?? []),
      () => photonPlaces(center, radius, kind, opts.name, stop.signal),
      3000
    ).finally(() => stop.abort());
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
      .filter((p): p is NonNullable<typeof p> => p !== null && p.distanceKm <= radius / 1000)
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
