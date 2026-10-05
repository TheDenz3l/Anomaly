import type { CapabilityProfile, Model } from "@/lib/types";

export function modelRef(model: Pick<Model, "providerId" | "id">): string {
  return `${model.providerId}/${model.id}`;
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
