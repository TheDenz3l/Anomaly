import type { CatalogProps } from "../../src/genui/schemas";
import type { WebCache } from "../web/cache";
import { HOUR } from "../web/cache";

/** Open-Meteo (free, keyless) → Weather component props. */

type Condition = CatalogProps<"Weather">["now"]["condition"];

function condition(code: number, isDay = true): Condition {
  if (!isDay && code <= 1) return "night";
  if (code === 0 || code === 1) return "clear";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  return "cloudy";
}

const SUMMARY: Record<Condition, string> = {
  clear: "Clear skies",
  partly: "Partly cloudy",
  cloudy: "Overcast",
  rain: "Rain",
  storm: "Thunderstorms",
  snow: "Snow",
  fog: "Fog",
  night: "Clear night",
};

function hourLabel(iso: string): string {
  const h = Number(iso.slice(11, 13));
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function dayLabel(iso: string, i: number): string {
  if (i === 0) return "Today";
  const d = new Date(`${iso}T12:00:00Z`);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
}

export async function forecast(
  cache: WebCache,
  place: { lat: number; lng: number; label: string }
): Promise<CatalogProps<"Weather">> {
  const key = `wx:${place.lat.toFixed(2)},${place.lng.toFixed(2)}`;
  const hit = await cache.get(key);
  let j: any;
  if (hit) j = JSON.parse(hit.content);
  else {
    const params = new URLSearchParams({
      latitude: String(place.lat),
      longitude: String(place.lng),
      current:
        "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
      hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: "auto",
      forecast_days: "7",
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
    j = await res.json();
    await cache.put(key, JSON.stringify(j), "application/json", HOUR / 2);
  }
  const c = j.current;
  const nowIso: string = c.time;
  const start = Math.max(
    0,
    (j.hourly.time as string[]).findIndex((t) => t >= nowIso.slice(0, 13))
  );
  const hourly = (j.hourly.time as string[]).slice(start, start + 12).map((t, k) => {
    const i = start + k;
    return {
      time: k === 0 ? "Now" : hourLabel(t),
      tempC: Math.round(j.hourly.temperature_2m[i]),
      condition: condition(j.hourly.weather_code[i], j.hourly.is_day[i] === 1),
      precipChance: Math.round(j.hourly.precipitation_probability[i] ?? 0),
    };
  });
  const daily = (j.daily.time as string[]).map((t, i) => ({
    day: dayLabel(t, i),
    highC: Math.round(j.daily.temperature_2m_max[i]),
    lowC: Math.round(j.daily.temperature_2m_min[i]),
    condition: condition(j.daily.weather_code[i]),
  }));
  const cond = condition(c.weather_code, c.is_day === 1);
  return {
    location: place.label,
    updated: `Updated ${hourLabel(nowIso)}, Open-Meteo`,
    now: {
      tempC: Math.round(c.temperature_2m),
      feelsLikeC: Math.round(c.apparent_temperature),
      condition: cond,
      summary: SUMMARY[cond],
      highC: daily[0]?.highC ?? Math.round(c.temperature_2m),
      lowC: daily[0]?.lowC ?? Math.round(c.temperature_2m),
      windKmh: Math.round(c.wind_speed_10m),
      humidity: Math.round(c.relative_humidity_2m),
      precipChance: Math.round(j.daily.precipitation_probability_max?.[0] ?? 0),
    },
    hourly,
    daily,
  };
}

export function weatherFallback(w: CatalogProps<"Weather">): string {
  return `${w.location}: ${w.now.tempC}°C and ${w.now.summary.toLowerCase()}, high ${w.now.highC}° low ${w.now.lowC}°, ${w.now.precipChance}% chance of precipitation.`;
}
