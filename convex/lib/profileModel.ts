import { NOT_CHAT, PREMIUM } from "./vision";

/**
 * Which model writes a profile sheet (engine/profile.ts). The user is waiting on its first words,
 * and how soon a model starts depends on its provider's queues more than on its name (on one relay
 * a "flash" model thought for 18 s while a full-size one answered in 1), so models are timed by the
 * speed probe (engine/speed.ts) rather than guessed. The chat's own model writes the profile
 * when it starts quickly enough; otherwise the first quick one of its family or a known family on
 * the same provider does. Pure, for tests.
 */

export type SpeedReading = { firstTextMs: number; at: number };
export type ProfileCandidate = { ref: string; speed?: SpeedReading };

/** Readings older than this are probed again the next time a profile opens. */
export const SPEED_REFRESH_MS = 24 * 60 * 60_000;
/** Readings older than this no longer count. */
export const SPEED_KEEP_MS = 3 * 24 * 60 * 60_000;
/** A model that starts writing a profile within this long is quick enough to keep it. */
export const QUICK_MS = 3000;
/** When none is that quick, models this close to the quickest count as quick. */
export const SLACK_MS = 1000;
/** A probe that got no words this soon (slow, down or refused) counts as this slow. */
export const PROBE_TIMEOUT_MS = 20_000;
const MAX_PROBED = 6;

/** Variants that aren't the plain model: cut down, tuned for something else, or limited. */
const VARIANT =
  /abliterated|uncensored|nano|vision|-vl\b|search|codex|review|preview|-exp\b|:free|:batch/i;
/** Families that write the app's cards and marks well, tried when the chat's own family is slow. */
const KNOWN = ["gpt", "claude", "gemini"];

/** "openai/gpt-6.1-sol" → "gpt". */
export const familyOf = (id: string) =>
  id
    .slice(id.lastIndexOf("/") + 1)
    .replace(/^~/, "")
    .toLowerCase()
    .split(/[-_.\d]/)[0];

/**
 * The models worth timing for a chat's profiles, in the order a profile prefers them when they're
 * quick: the chat's own model, its family on the same provider (newest first, the way providers
 * list them), then known families there. Flagship tiers are left out: a profile doesn't need one,
 * and they're slow and costly.
 */
export function speedCandidates(
  chatRef: string,
  models: { id: string; kind: string; tools: boolean }[]
): string[] {
  const slash = chatRef.indexOf("/");
  const providerId = chatRef.slice(0, slash);
  const chatId = chatRef.slice(slash + 1);
  const family = familyOf(chatId);
  const usable = models.filter(
    (m) =>
      m.id !== chatId &&
      m.kind === "chat" &&
      // Questions asked in the sheet can search.
      m.tools &&
      !NOT_CHAT.test(m.id) &&
      !VARIANT.test(m.id) &&
      !PREMIUM.test(m.id)
  );
  const own = usable.filter((m) => familyOf(m.id) === family).slice(0, 3);
  // With siblings of its own, one model of each known family is fallback enough.
  const perFamily = own.length ? 1 : 3;
  const known = KNOWN.filter((f) => f !== family).flatMap((f) =>
    usable.filter((m) => familyOf(m.id) === f).slice(0, perFamily)
  );
  return [chatRef, ...[...own, ...known].map((m) => `${providerId}/${m.id}`)].slice(0, MAX_PROBED);
}

/**
 * The first quick candidate, so the chat's own model keeps the profile whenever it's quick. Without
 * a current reading for the chat's model there's nothing to compare, and it keeps the profile
 * while the probe runs.
 */
export function pickProfileModel(candidates: ProfileCandidate[], now: number): string {
  const timed = candidates.filter((c) => c.speed && now - c.speed.at < SPEED_KEEP_MS);
  const chat = candidates[0];
  if (!chat || timed[0] !== chat) return chat?.ref ?? "";
  const quickest = Math.min(...timed.map((c) => c.speed!.firstTextMs));
  if (quickest >= PROBE_TIMEOUT_MS) return chat.ref;
  const bar = Math.max(QUICK_MS, quickest + SLACK_MS);
  return timed.find((c) => c.speed!.firstTextMs <= bar)!.ref;
}

/** True when some candidate has no reading, or one due for another probe. */
export function speedsDue(candidates: ProfileCandidate[], now: number): boolean {
  return candidates.some((c) => !c.speed || now - c.speed.at >= SPEED_REFRESH_MS);
}

/** A new probe reading folded into the last one, so one unlucky request doesn't swing it. */
export function blendSpeed(last: SpeedReading | undefined, ms: number, now: number): number {
  return last && now - last.at < SPEED_KEEP_MS ? Math.round((last.firstTextMs + ms) / 2) : ms;
}
