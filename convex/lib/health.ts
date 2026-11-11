import type { ErrorKind } from "../ai/openai";

/**
 * Model status, the way a status page puts it: normal, degraded or down. Read from a tiny check
 * request (health.ts) and from real replies (engine/finish.ts), whichever came last.
 */

export type HealthStatus = "normal" | "degraded" | "down";

export type HealthReading = {
  status: HealthStatus;
  detail?: string;
  /** Milliseconds to the first streamed event, from a check or a real reply. */
  latencyMs?: number;
  /** Milliseconds to the first answer text, when the model got that far. */
  textMs?: number;
  /** A failure that may clear on its own (server error, network, timeout), not a refused key. */
  transient?: boolean;
};

export type CheckOutcome =
  | { ok: true; firstMs: number; textMs?: number }
  | { ok: false; timedOut: true }
  | { ok: false; timedOut?: false; kind: ErrorKind; status: number; body: string };

/** Slower than this to start replying counts as degraded. */
export const SLOW_MS = 10_000;
/** A check with nothing streamed back by now counts as down. */
export const CHECK_TIMEOUT_MS = 20_000;

const OVERLOADED = /overload|capacity|busy|temporarily unavailable|try again later/i;
const OUT_OF_CREDIT =
  /insufficient_quota|exceeded your current quota|billing|insufficient (?:balance|credits?|funds)|credit balance|payment required/i;
/** Relays (one-api, new-api) and gateways phrase "this model isn't served here" many ways. */
const MODEL_GONE =
  /model[^.]{0,80}(?:not (?:found|exist|support|available)|does ?n[o']t exist|unavailable|deprecated|decommissioned)|(?:invalid|unknown|unsupported) model|no available channel|无可用渠道/i;

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

export function readCheck(o: CheckOutcome): HealthReading {
  if (o.ok) {
    const speed = { latencyMs: o.firstMs, ...(o.textMs === undefined ? {} : { textMs: o.textMs }) };
    return o.firstMs > SLOW_MS
      ? { status: "degraded", detail: `Slow, ${seconds(o.firstMs)} to start`, ...speed }
      : { status: "normal", ...speed };
  }
  if (o.timedOut) {
    return {
      status: "down",
      detail: `No response in ${seconds(CHECK_TIMEOUT_MS)}`,
      transient: true,
    };
  }
  switch (o.kind) {
    case "auth":
      return o.status === 402 || OUT_OF_CREDIT.test(o.body)
        ? { status: "down", detail: "Out of credit" }
        : { status: "down", detail: `Key rejected (${o.status})` };
    case "not_found":
      return { status: "down", detail: "Not served by this provider" };
    case "rate_limit":
      return { status: "degraded", detail: "Rate-limited", transient: true };
    case "server":
      if (MODEL_GONE.test(o.body)) return { status: "down", detail: "Not served by this provider" };
      return OVERLOADED.test(o.body)
        ? { status: "degraded", detail: "Overloaded", transient: true }
        : { status: "down", detail: `Provider error (${o.status})`, transient: true };
    case "network":
      return { status: "down", detail: "Unreachable", transient: true };
    case "bad_param":
    case "context_overflow":
      // The model answered; it only disliked the check's request.
      return MODEL_GONE.test(o.body)
        ? { status: "down", detail: "Not served by this provider" }
        : { status: "normal" };
    default:
      return {
        status: "degraded",
        detail: o.status ? `Unexpected reply (${o.status})` : "Unexpected reply",
        transient: true,
      };
  }
}

/**
 * The status to store after a new reading. One passing failure from a real reply only makes a
 * working model degraded; a second in a row (or a check, which already retried) makes it down.
 */
/**
 * A new timing leans on the one before it, so one slow or lucky request doesn't reorder the
 * "fastest" list by itself.
 */
export function blendMs(prev: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return prev;
  return prev === undefined ? next : Math.round(prev * 0.4 + next * 0.6);
}

export function foldReading(
  prev: { status: HealthStatus; fails: number; latencyMs?: number; textMs?: number } | null,
  next: HealthReading,
  confirmed: boolean
): { status: HealthStatus; detail?: string; latencyMs?: number; textMs?: number; fails: number } {
  const failed = next.status !== "normal";
  const fails = failed ? (prev?.fails ?? 0) + 1 : 0;
  const status =
    next.status === "down" && next.transient && !confirmed && fails < 2 ? "degraded" : next.status;
  return {
    status,
    detail: next.detail,
    latencyMs: failed ? undefined : blendMs(prev?.latencyMs, next.latencyMs),
    textMs: failed ? undefined : blendMs(prev?.textMs, next.textMs),
    fails,
  };
}
