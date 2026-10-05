import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export type SettingsFields = Omit<Doc<"settings">, "_id" | "_creationTime" | "userId">;

export const DEFAULT_SETTINGS: SettingsFields = {
  customInstructions: "",
  memoryEnabled: true,
  subagentMode: "auto",
  webMode: "auto",
  searchProvider: "searxng",
  searchKeyHint: "",
  voiceInput: "device",
  voiceOutput: "device",
  readRepliesAloud: false,
  probeSpendCapUsd: 0.05,
  probeSpentUsd: 0,
  defaultModelRef: "",
  researchModelRef: null,
  embeddingModelRef: null,
  transcriptionModelRef: null,
  speechModelRef: null,
  roleModels: { planner: null, worker: null, verifier: null, synthesizer: null },
  researchCostCapUsd: 0.5,
};

export async function loadSettings(
  ctx: QueryCtx,
  userId: Id<"users">
): Promise<SettingsFields & { _id?: Id<"settings"> }> {
  const doc = await ctx.db
    .query("settings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (!doc) return { ...DEFAULT_SETTINGS };
  const { _creationTime, userId: _u, ...rest } = doc;
  return { ...DEFAULT_SETTINGS, ...rest };
}

export async function ensureSettings(
  ctx: MutationCtx,
  userId: Id<"users">
): Promise<Doc<"settings">> {
  const doc = await ctx.db
    .query("settings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (doc) return doc;
  const id = await ctx.db.insert("settings", { userId, ...DEFAULT_SETTINGS });
  return (await ctx.db.get(id))!;
}

/** What the client may see: no ciphertexts, no push token. */
export function publicSettings(s: SettingsFields) {
  const { searchKeyCipher, pushToken, ...rest } = s as SettingsFields & { _id?: unknown };
  delete (rest as { _id?: unknown })._id;
  return { ...rest, hasSearchKey: Boolean(searchKeyCipher), pushEnabled: Boolean(pushToken) };
}
