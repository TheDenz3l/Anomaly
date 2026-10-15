/**
 * Picks the model that reads photos for one that can't see them. Pure, so the composer shows the
 * same stand-in the server will use.
 */

export type VisionCandidate = {
  providerId: string;
  id: string;
  name: string;
  kind?: string;
  profile: {
    features: { vision: boolean };
    source: string;
    reasoning?: { style: string; levels: string[] };
  };
  /** USD per token, when the provider publishes it. */
  pricing?: { prompt: number; completion: number };
};

/** Ids that take images but don't chat about them (generators, speech, embeddings). */
export const NOT_CHAT =
  /embed|tts|whisper|transcri|speech|audio|realtime|moderation|dall-e|imagen|[-_/]image([-_.\d]|$)|rerank|guard/i;
/** Fast, cheap tiers. */
const QUICK =
  /(^|[-_/.:\s])(flash|flashx|mini|haiku|lite|nano|small|fast|air|turbo|luna|instant)($|[-_/.:\s\d])/i;
/** Flagship tiers: slow and costly for a job a fast model does as well. */
export const PREMIUM =
  /(^|[-_/.:\s])(opus|fable|ultra|max|astra|pro|prime|heavy|large|sonnet)($|[-_/.:\s\d])/i;
/** Families known to read screenshots and small text well. */
const KNOWN = /gemini|gpt-?\d|claude|grok|qwen[\w.-]*vl|pixtral|llama-4/i;
/** Tiers built for quick image and text work. */
const SNAPPY = /haiku|flash/i;

/** A model that always reasons first spends seconds on what should be a quick look. */
function alwaysReasons(m: VisionCandidate): boolean {
  const r = m.profile.reasoning;
  return Boolean(r && r.style !== "none" && r.levels.length && !r.levels.includes("off"));
}

/**
 * Vision models the user can reach, best stand-in first: the provider they picked, then the fastest
 * and cheapest tier (a description doesn't need a flagship, and the user is waiting on it).
 */
export function rankVisionModels<T extends VisionCandidate>(
  models: T[],
  current: { providerId: string; id: string },
  opts: { usable?: (providerId: string) => boolean } = {}
): T[] {
  const scored: { m: T; score: number }[] = [];
  models.forEach((m, i) => {
    if (!m.profile.features.vision) return;
    if (m.providerId === current.providerId && m.id === current.id) return;
    if ((m.kind && m.kind !== "chat") || NOT_CHAT.test(m.id)) return;
    if (opts.usable && !opts.usable(m.providerId)) return;
    const perMillion = m.pricing ? m.pricing.prompt * 1e6 : undefined;
    const score =
      (m.providerId === current.providerId ? 1000 : 0) +
      (QUICK.test(m.id) ? 60 : 0) +
      (SNAPPY.test(m.id) ? 10 : 0) -
      (PREMIUM.test(m.id) ? 60 : 0) -
      (alwaysReasons(m) ? 25 : 0) -
      // Published prices settle it among models of one tier: cheaper first.
      (perMillion !== undefined ? 10 * Math.log10(perMillion + 0.01) : 0) +
      (KNOWN.test(m.id) ? 20 : 0) +
      // Vision confirmed by a probe, real use or the user, not just guessed from the name.
      (m.profile.source !== "registry" ? 8 : 0) -
      (/:free$|preview|-exp\b/.test(m.id) ? 5 : 0) -
      i * 0.001;
    scored.push({ m, score });
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.m);
}

export function pickVisionModel<T extends VisionCandidate>(
  models: T[],
  current: { providerId: string; id: string },
  opts: { usable?: (providerId: string) => boolean } = {}
): T | null {
  return rankVisionModels(models, current, opts)[0] ?? null;
}
