import type { WebCache } from "../web/cache";
import { HOUR } from "../web/cache";

/**
 * TMDB now-playing (free, non-commercial, attribution required; cache ≤ 6 months per terms).
 * TMDB_API_KEY accepts either a v3 key or a v4 read-access token.
 */

export const TMDB_ATTRIBUTION =
  "Movie data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.";

export type NowPlaying = {
  id: string;
  title: string;
  year: number;
  rating: string;
  runtime: number;
  genres: string[];
  score: number;
  overview: string;
  poster?: string;
};

function tmdbFetch(path: string, params: Record<string, string> = {}): Promise<any> {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB is not configured (set TMDB_API_KEY on the Convex deployment).");
  const bearer = key.length > 40;
  const qs = new URLSearchParams({
    language: "en-US",
    ...params,
    ...(bearer ? {} : { api_key: key }),
  });
  return fetch(`https://api.themoviedb.org/3${path}?${qs}`, {
    headers: bearer
      ? { Authorization: `Bearer ${key}`, Accept: "application/json" }
      : { Accept: "application/json" },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`TMDB returned ${r.status}`);
    return r.json();
  });
}

export function tmdbConfigured(): boolean {
  return Boolean(process.env.TMDB_API_KEY);
}

function toMovie(m: any, d: any, region: string): NowPlaying {
  const releases: any[] = d?.release_dates?.results ?? [];
  const cert =
    releases.find((r) => r.iso_3166_1 === region)?.release_dates?.find((x: any) => x.certification)
      ?.certification ??
    releases.find((r) => r.iso_3166_1 === "US")?.release_dates?.find((x: any) => x.certification)
      ?.certification ??
    "NR";
  return {
    id: `tmdb_${m.id}`,
    title: String(m.title),
    year: Number(String(m.release_date ?? "").slice(0, 4)) || new Date().getFullYear(),
    rating: cert,
    runtime: Math.max(1, Number(d?.runtime) || 100),
    genres: (d?.genres ?? []).map((g: any) => String(g.name)).slice(0, 3),
    score: Math.round((Number(m.vote_average) || 0) * 10) / 10,
    overview: String(m.overview ?? ""),
    poster: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : undefined,
  };
}

export async function nowPlaying(
  cache: WebCache,
  region: string,
  limit = 6
): Promise<NowPlaying[]> {
  const key = `tmdb:now:${region}:${limit}`;
  const hit = await cache.get(key);
  if (hit) return JSON.parse(hit.content);
  const list = await tmdbFetch("/movie/now_playing", { region, page: "1" });
  const top: any[] = (list?.results ?? [])
    .sort((a: any, b: any) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, limit);
  const details = await Promise.all(
    top.map((m) =>
      tmdbFetch(`/movie/${m.id}`, { append_to_response: "release_dates" }).catch(() => null)
    )
  );
  const out = top.map((m, i) => toMovie(m, details[i], region));
  await cache.put(key, JSON.stringify(out), "application/json", 12 * HOUR);
  return out;
}

export const normTitle = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Same film: equal titles, or one is the other plus a suffix ("Digger (IMAX)"), but never "Runner" vs "Blade Runner". */
export function sameTitle(a: string, b: string): boolean {
  const x = normTitle(a);
  const y = normTitle(b);
  return Boolean(x && y) && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
}

/** TMDB's entry for a film a cinema lists (poster, rating, runtime). Null when TMDB has no clear match. Cached a week. */
export async function findMovie(
  cache: WebCache,
  title: string,
  region: string
): Promise<NowPlaying | null> {
  const key = `tmdb:find:${region}:${normTitle(title)}`;
  const hit = await cache.get(key);
  if (hit) return hit.content ? (JSON.parse(hit.content) as NowPlaying) : null;
  const res = await tmdbFetch("/search/movie", { query: title, region, include_adult: "false" });
  const results: any[] = res?.results ?? [];
  // Several films can share a title ("Tony"): cinemas mostly show new releases, so a recent exact
  // match wins, then the best-known exact match, then a looser title match.
  const thisYear = new Date().getFullYear();
  const byFame = (a: any, b: any) => (b.popularity ?? 0) - (a.popularity ?? 0);
  const exact = results.filter((x) => normTitle(String(x.title)) === normTitle(title));
  const m =
    exact
      .filter((x) => Number(String(x.release_date ?? "").slice(0, 4)) >= thisYear - 1)
      .sort(byFame)[0] ??
    exact.sort(byFame)[0] ??
    results.find((x) => sameTitle(String(x.title), title));
  const d = m
    ? await tmdbFetch(`/movie/${m.id}`, { append_to_response: "release_dates" }).catch(() => null)
    : null;
  const out = m ? toMovie(m, d, region) : null;
  await cache.put(key, out ? JSON.stringify(out) : "", "application/json", 7 * 24 * HOUR);
  return out;
}
