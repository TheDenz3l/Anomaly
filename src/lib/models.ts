import type { CapabilityProfile, Model } from "@/lib/types";

export function modelRef(model: Pick<Model, "providerId" | "id">): string {
  return `${model.providerId}/${model.id}`;
}

/**
 * How long a model takes to start answering, in milliseconds: to its first words when that was
 * timed, else to its first streamed event. Nothing for a model that is down or was never timed.
 */
export function speedMs(model: Pick<Model, "health">): number | undefined {
  const h = model.health;
  if (!h || h.status === "down") return undefined;
  return h.textMs ?? h.latencyMs;
}

export function speedLabel(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 9950 ? 1 : 0)}s`;
}

/** Quickest to answer first; models never timed, or down, go last in their given order. */
export function bySpeed<T extends Pick<Model, "health">>(models: T[]): T[] {
  return models
    .map((m, i) => ({ m, i, ms: speedMs(m) ?? Infinity }))
    .sort((a, b) => a.ms - b.ms || a.i - b.i)
    .map((x) => x.m);
}

const EMPTY_PROFILE: CapabilityProfile = {
  reasoning: { style: "none", levels: [], defaultLevel: "off" },
  features: {
    vision: false,
    tools: true,
    streaming: true,
    reasoningText: false,
    audio: false,
    webSearch: false,
  },
  confidence: 0,
  source: "registry",
  lastVerified: 0,
  version: 0,
};

/** Stand-in while models load, or when a thread points at a model that's no longer listed. */
export function placeholderModel(ref: string): Model {
  const i = ref.indexOf("/");
  const id = i > 0 ? ref.slice(i + 1) : ref;
  return {
    id,
    name: id ? (id.split("/").pop() ?? id) : "Add a model",
    providerId: i > 0 ? ref.slice(0, i) : "",
    contextWindow: 0,
    profile: EMPTY_PROFILE,
  };
}
