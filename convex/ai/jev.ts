/**
 * Jev (TypeSafe System One) through OpenRouter's Decisions API: typed answers with probabilities,
 * ~0.2–0.3 s per request. JEV_API_KEY is an OpenRouter key reserved for Jev — it is never used for
 * chat models (those come from the user's own providers).
 * https://openrouter.ai/docs/guides/community/jev
 */

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export type JevResult = { answers: Record<string, JevAnswer>; costUsd: number; ms: number };

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

export function jevEnabled(): boolean {
  return Boolean(process.env.JEV_API_KEY) && process.env.JEV_DISABLED !== "1";
}

export function jevModel(): string {
  return process.env.JEV_MODEL || "typesafe/jev-1.13";
}

/** One request, many questions about the same state. Returns null on any failure so callers fall back. */
export async function jevDecide(
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
  timeoutMs = 2500
): Promise<JevResult | null> {
  const key = process.env.JEV_API_KEY;
  if (!key || process.env.JEV_DISABLED === "1" || !Object.keys(questions).length) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: jevModel(), state, questions }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn("jev", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json: any = await res.json();
    if (!json?.answers || typeof json.answers !== "object") return null;
    return {
      answers: json.answers,
      costUsd: Number(json.usage?.cost ?? 0),
      ms: Date.now() - started,
    };
  } catch (e) {
    console.warn("jev failed", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function choiceOf(
  a: JevAnswer | undefined
): { choice: string; confidence: number; probabilities: Record<string, number> } | null {
  return a?.type === "choice" && typeof a.choice === "string" ? a : null;
}

export function noulOf(a: JevAnswer | undefined): number | null {
  return a?.type === "noul" && Number.isFinite(a.noul) ? a.noul : null;
}

export function scoreOf(a: JevAnswer | undefined): { score: number; confidence: number } | null {
  return a?.type === "score" && Number.isFinite(a.score) ? a : null;
}

/** Confidence of a yes/no answer: distance from a coin flip, rescaled to 0.5–1. */
export function noulConfidence(p: number): number {
  return 0.5 + Math.abs(p - 0.5);
}
