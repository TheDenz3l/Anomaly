import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { embed } from "../ai/openai";
import { fitVector } from "../lib/vectors";
import { parseModelRef } from "../lib/util";
import { EMBEDDING_DIMENSIONS } from "../schema";
import { forkEngine, note, type Engine } from "./context";

/** Retrieval (PRD §3.9): vector search when an embedding model is set, keyword fallback otherwise, then a relevance gate. */

export type Recalled = { id: Id<"memories">; text: string; category: string };

const MAX_INJECT = 5;

export async function recallMemories(
  engine: Engine,
  query: string,
  threadId: Id<"threads">
): Promise<Recalled[]> {
  const { ctx, settings, userId } = engine;
  const inScope = (m: { scope: string; threadId?: Id<"threads"> }) =>
    m.scope === "global" || m.threadId === threadId;
  let candidates: {
    _id: Id<"memories">;
    text: string;
    category: string;
    scope: string;
    threadId?: Id<"threads">;
    vec?: number;
  }[] = [];

  const ref = settings.embeddingModelRef;
  const parsed = ref ? parseModelRef(ref) : null;
  if (ref && parsed && query.trim()) {
    try {
      const ep =
        parsed.providerId === engine.providerId
          ? engine.endpoint
          : (await forkEngine(engine, ref)).endpoint;
      const [vec] = await embed(ep, parsed.modelId, [query.slice(0, 2000)], EMBEDDING_DIMENSIONS);
      if (vec?.length) {
        const hits = await ctx.vectorSearch("memories", "by_embedding", {
          vector: fitVector(vec),
          limit: 16,
          filter: (q) => q.eq("embeddingKey", `${userId}|${ref}`),
        });
        const docs = await ctx.runQuery(internal.memories.byIds, { ids: hits.map((h) => h._id) });
        const score = new Map(hits.map((h) => [h._id, h._score]));
        candidates = docs.map((d) => ({ ...d, vec: score.get(d._id) }));
      }
    } catch (e) {
      console.warn("vector recall failed, using keywords", (e as Error).message);
    }
  }
  if (!candidates.length) {
    candidates = await ctx.runQuery(internal.memories.forUser, { userId, limit: 300 });
  }
  candidates = candidates.filter(inScope);
  if (!candidates.length) return [];

  const rel = await engine.dp.memoryRelevance(
    query,
    candidates.map((c) => c.text)
  );
  const scores = candidates.map((c, i) => {
    const lexical = rel.choice[i] ?? 0;
    return c.vec !== undefined ? 0.75 * c.vec + 0.25 * lexical : lexical;
  });
  note(engine, "memory_retrieval", query, {
    ...rel,
    choice: scores.map((s) => Math.round(s * 100) / 100),
  });
  const threshold = candidates.some((c) => c.vec !== undefined) ? 0.3 : 0.2;
  const ranked = candidates
    .map((c, i) => ({ c, s: scores[i] }))
    .filter((x) => x.s >= threshold)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_INJECT)
    .map((x) => x.c);

  // Without vectors, keep a couple of standing preferences so short prompts still get personal context.
  if (ranked.length < 3) {
    for (const c of candidates) {
      if (ranked.length >= 3) break;
      if (!ranked.includes(c) && ["preference", "person", "place"].includes(c.category))
        ranked.push(c);
    }
  }
  return ranked.map((c) => ({ id: c._id, text: c.text, category: c.category }));
}
