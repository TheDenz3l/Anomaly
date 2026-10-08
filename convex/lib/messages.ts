import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Part } from "./validators";

export function textOf(parts: Part[]): string {
  return parts
    .map((p) =>
      p.type === "text"
        ? p.text
        : p.type === "ui_event"
          ? p.label
          : p.type === "component"
            ? p.fallbackText
            : p.type === "file"
              ? p.name
              : ""
    )
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

/** Client shape (src/lib/types.ts Message): ids as strings, image storage resolved to URLs. */
export async function clientMessage(ctx: QueryCtx, m: Doc<"messages">) {
  const parts = await Promise.all(
    m.parts.map(async (p) => {
      if ((p.type === "image" || p.type === "file") && p.storageId && !p.uri) {
        return { ...p, uri: (await ctx.storage.getUrl(p.storageId)) ?? undefined };
      }
      return p;
    })
  );
  return {
    id: m._id,
    threadId: m.threadId,
    role: m.role,
    parts,
    createdAt: m._creationTime,
    status: m.status,
    meta: m.meta,
    error: m.error,
  };
}

export async function threadMessages(ctx: QueryCtx, threadId: Id<"threads">, limit?: number) {
  const q = ctx.db.query("messages").withIndex("by_thread", (x) => x.eq("threadId", threadId));
  if (!limit) return await q.collect();
  return (await q.order("desc").take(limit)).reverse();
}

/** The progress reply of a Deep Research run still gathering or writing in this thread. */
export async function activeResearchMessage(
  ctx: QueryCtx,
  threadId: Id<"threads">
): Promise<Id<"messages"> | null> {
  const runs = await ctx.db
    .query("researchRuns")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(5);
  const run = runs.find((r) => r.status === "running" || r.status === "synthesizing");
  return run?.progressMessageId ?? null;
}

/**
 * Marks any in-flight reply in the thread as stopped; the running action notices on its next flush.
 * `keepResearch`: a new message leaves a running Deep Research alone; only an explicit Stop ends it.
 */
export async function stopStreaming(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  opts: { keepResearch?: boolean } = {}
): Promise<number> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(20);
  const keep = opts.keepResearch ? await activeResearchMessage(ctx, threadId) : null;
  let n = 0;
  for (const m of recent) {
    if (m.status === "streaming" && m._id !== keep) {
      await ctx.db.patch(m._id, { status: "stopped" });
      n++;
    }
  }
  return n;
}

export async function findComponent(
  ctx: QueryCtx,
  threadId: Id<"threads">,
  componentId: string
): Promise<{ message: Doc<"messages">; part: Extract<Part, { type: "component" }> } | null> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(200);
  for (const m of recent) {
    for (const p of m.parts)
      if (p.type === "component" && p.id === componentId) return { message: m, part: p };
  }
  return null;
}
