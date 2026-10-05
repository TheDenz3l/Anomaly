import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vAgentRole,
  vFeatures,
  vHeader,
  vLocation,
  vMemoryCategory,
  vMemoryScope,
  vMessageStatus,
  vParams,
  vPart,
  vProfileSource,
  vReasoning,
  vReplyMeta,
  vRole,
  vRoleModels,
  vSearchProvider,
  vSource,
  vSourceOrigin,
  vSubagentMode,
  vThreadMode,
  vVoiceMode,
  vWebMode,
} from "./lib/validators";

/** Embedding width of the memory vector index. Smaller vectors are zero-padded (cosine-preserving). */
export const EMBEDDING_DIMENSIONS = 1536;

export default defineSchema({
  ...authTables,

  settings: defineTable({
    userId: v.id("users"),
    customInstructions: v.string(),
    memoryEnabled: v.boolean(),
    subagentMode: vSubagentMode,
    webMode: vWebMode,
    searchProvider: vSearchProvider,
    searchUrl: v.optional(v.string()),
    searchKeyCipher: v.optional(v.string()),
    searchKeyHint: v.string(),
    voiceInput: vVoiceMode,
    voiceOutput: vVoiceMode,
    voiceId: v.optional(v.string()),
    readRepliesAloud: v.boolean(),
    probeSpendCapUsd: v.number(),
    probeSpentUsd: v.number(),
    defaultModelRef: v.string(),
    researchModelRef: v.union(v.string(), v.null()),
    embeddingModelRef: v.union(v.string(), v.null()),
    transcriptionModelRef: v.union(v.string(), v.null()),
    speechModelRef: v.union(v.string(), v.null()),
    roleModels: vRoleModels,
    researchCostCapUsd: v.number(),
    pushToken: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  providers: defineTable({
    userId: v.id("users"),
    providerId: v.string(),
    label: v.string(),
    baseUrl: v.string(),
    keyCipher: v.optional(v.string()),
    keyHint: v.string(),
    /** Display copy of headers; values of sensitive headers are masked. */
    headerHints: v.array(vHeader),
    /** All header values, encrypted as one JSON blob. */
    headersCipher: v.optional(v.string()),
    status: v.union(v.literal("connected"), v.literal("error"), v.literal("checking")),
    lastError: v.optional(v.string()),
    models: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        contextWindow: v.number(),
        kind: v.union(
          v.literal("chat"),
          v.literal("embedding"),
          v.literal("audio"),
          v.literal("image"),
          v.literal("other")
        ),
        /** USD per token, when the endpoint publishes it (OpenRouter does). */
        pricing: v.optional(v.object({ prompt: v.number(), completion: v.number() })),
      })
    ),
    modelsFetchedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_provider", ["userId", "providerId"]),

  capabilityProfiles: defineTable({
    userId: v.id("users"),
    providerId: v.string(),
    modelId: v.string(),
    reasoning: vReasoning,
    features: vFeatures,
    params: v.optional(vParams),
    confidence: v.number(),
    source: vProfileSource,
    lastVerified: v.number(),
    version: v.number(),
    successStreak: v.number(),
    noopStrikes: v.number(),
  })
    .index("by_user_model", ["userId", "providerId", "modelId"])
    .index("by_user_provider", ["userId", "providerId"]),

  probeLogs: defineTable({
    userId: v.id("users"),
    providerId: v.string(),
    modelId: v.string(),
    probe: v.string(),
    request: v.any(),
    status: v.number(),
    result: v.string(),
    costUsd: v.number(),
    ts: v.number(),
  }).index("by_user_model", ["userId", "providerId", "modelId"]),

  threads: defineTable({
    userId: v.id("users"),
    title: v.string(),
    modelRef: v.string(),
    mode: vThreadMode,
    reasoningLevel: v.string(),
    incognito: v.boolean(),
    location: v.optional(vLocation),
    updatedAt: v.number(),
    /** Latest user prompt, for History rows without loading messages. */
    preview: v.optional(v.string()),
    /** When the user pinned the chat to the top of Recents. */
    pinnedAt: v.optional(v.number()),
  })
    .index("by_user_updated", ["userId", "updatedAt"])
    .searchIndex("search_title", { searchField: "title", filterFields: ["userId"] }),

  messages: defineTable({
    threadId: v.id("threads"),
    userId: v.id("users"),
    role: vRole,
    parts: v.array(vPart),
    status: vMessageStatus,
    meta: v.optional(vReplyMeta),
    error: v.optional(v.string()),
    /** Plain text of the message, kept for History search. */
    searchText: v.optional(v.string()),
  })
    .index("by_thread", ["threadId"])
    .index("by_user", ["userId"])
    .index("by_status", ["status"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["userId"] }),

  attachments: defineTable({
    userId: v.id("users"),
    messageId: v.optional(v.id("messages")),
    storageId: v.id("_storage"),
    mime: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  })
    .index("by_storage", ["storageId"])
    .index("by_message", ["messageId"]),

  memories: defineTable({
    userId: v.id("users"),
    threadId: v.optional(v.id("threads")),
    scope: vMemoryScope,
    text: v.string(),
    category: vMemoryCategory,
    confidence: v.number(),
    source: v.union(v.literal("auto"), v.literal("confirmed"), v.literal("manual")),
    /** The MemoryConfirm component that proposed it, so undo can find it. */
    componentId: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
    /** userId|modelRef — vectors from different models are never compared. */
    embeddingKey: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_component", ["componentId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: EMBEDDING_DIMENSIONS,
      filterFields: ["embeddingKey"],
    }),

  decisions: defineTable({
    userId: v.optional(v.id("users")),
    kind: v.string(),
    input: v.any(),
    output: v.any(),
    confidence: v.number(),
    provider: v.string(),
    overridden: v.boolean(),
    refId: v.optional(v.string()),
    ts: v.number(),
  })
    .index("by_user_kind", ["userId", "kind"])
    .index("by_ref", ["refId"]),

  reasoningEvents: defineTable({
    userId: v.id("users"),
    threadId: v.id("threads"),
    messageId: v.id("messages"),
    modelRef: v.string(),
    levelRequested: v.string(),
    levelSent: v.string(),
    reasoningTokens: v.number(),
    outcome: v.string(),
    ts: v.number(),
  }).index("by_thread", ["threadId"]),

  agentRuns: defineTable({
    userId: v.id("users"),
    threadId: v.id("threads"),
    messageId: v.optional(v.id("messages")),
    componentId: v.optional(v.string()),
    parentRunId: v.optional(v.id("agentRuns")),
    kind: v.union(v.literal("plan"), v.literal("worker")),
    role: v.union(vAgentRole, v.literal("orchestrator")),
    brief: v.string(),
    model: v.string(),
    status: v.union(
      v.literal("proposed"),
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    budget: v.object({ maxTokens: v.number(), maxSearches: v.number(), maxMinutes: v.number() }),
    plan: v.optional(v.any()),
    result: v.optional(v.string()),
    sources: v.optional(v.array(vSource)),
    tokens: v.number(),
    searches: v.number(),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_parent", ["parentRunId"])
    .index("by_component", ["componentId"]),

  agentSteps: defineTable({
    runId: v.id("agentRuns"),
    kind: v.string(),
    input: v.any(),
    output: v.any(),
    tokens: v.number(),
    ts: v.number(),
  }).index("by_run", ["runId"]),

  researchRuns: defineTable({
    userId: v.id("users"),
    threadId: v.id("threads"),
    status: v.union(
      v.literal("clarifying"),
      v.literal("awaiting_approval"),
      v.literal("running"),
      v.literal("synthesizing"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    question: v.string(),
    clarifications: v.array(v.string()),
    plan: v.optional(
      v.object({
        steps: v.array(
          v.object({ id: v.string(), title: v.string(), queries: v.array(v.string()) })
        ),
        depth: v.number(),
      })
    ),
    depth: v.number(),
    budget: v.object({ maxUsd: v.number(), maxSources: v.number(), maxSearches: v.number() }),
    spentUsd: v.number(),
    notes: v.array(
      v.object({
        stepId: v.string(),
        title: v.string(),
        text: v.string(),
        sourceIds: v.array(v.string()),
      })
    ),
    sources: v.array(vSource),
    clarifyComponentId: v.optional(v.string()),
    planComponentId: v.optional(v.string()),
    progressMessageId: v.optional(v.id("messages")),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("by_thread", ["threadId"]),

  sources: defineTable({
    userId: v.id("users"),
    messageId: v.id("messages"),
    runId: v.optional(v.id("agentRuns")),
    url: v.string(),
    title: v.string(),
    favicon: v.optional(v.string()),
    snippet: v.string(),
    origin: vSourceOrigin,
  }).index("by_message", ["messageId"]),

  webCache: defineTable({
    key: v.string(),
    content: v.string(),
    contentType: v.string(),
    fetchedAt: v.number(),
    ttl: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_fetched", ["fetchedAt"]),

  saved: defineTable({
    userId: v.id("users"),
    kind: v.union(v.literal("message"), v.literal("artifact")),
    refId: v.string(),
    ts: v.number(),
  })
    .index("by_user_kind", ["userId", "kind"])
    .index("by_user_ref", ["userId", "refId"]),
});
