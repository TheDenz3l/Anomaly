import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { prefersMessages, routeToMessages } from "../ai/anthropic";
import { complete } from "../ai/openai";
import { buildRequest } from "../ai/reasoning";
import type { Part } from "../lib/validators";
import { rankVisionModels } from "../lib/vision";
import { estimateCost, modelEngine, type Engine } from "./context";
import { imageUrl } from "./history";

/** User turns whose photos get described: the same window replies send images for. */
const IMAGE_TURNS = 2;
/** Stand-ins tried before giving up on the photos. */
const MAX_TRIES = 3;
const DESCRIBE_TIMEOUT_MS = 60_000;

const SYSTEM = `You describe photos for an AI assistant that can't see images. It answers the user from your description alone, so be complete and literal.
- Transcribe the meaningful text verbatim, keeping its structure (lines, lists, tables, who wrote what in a post or chat). Skip phone and app chrome: status bar, battery, signal, navigation and action icons.
- Describe what's shown in a few sentences: people (appearance, expression, any visible names or captions, without guessing who they are), objects, setting, charts with their values.
- Give the most detail to whatever the user's message asks about. Be brief everywhere else.
- Don't answer the user's question and don't add opinions. Plain text, no preamble.
- If no image reached you, reply with exactly NO_IMAGE.`;

/** A reply saying the photo never arrived: some gateways drop images on one API and keep them on another. */
const BLIND =
  /^\W*no[_ ]image\b|^(there(?:'s| is) )?no (image|photo|picture)s?\b|^i (?:can(?:'|no)t|don'?t|do not) see (?:an?|any|the) (?:image|photo|picture)/i;

type ImagePart = Extract<Part, { type: "image" }>;
type Job = { m: Doc<"messages">; p: ImagePart };

/**
 * For a model that can't take images: the fastest, cheapest vision model the user has (on the
 * provider they picked first) describes the recent photos, and each description is cached on its
 * photo. A stand-in whose gateway drops the images is retried over the Messages API, then the next
 * one takes over. Returns the ref of the model that read the latest message's photos, or null.
 */
export async function describeImages(
  engine: Engine,
  history: Doc<"messages">[],
  question: string,
  signal?: AbortSignal
): Promise<string | null> {
  const users = history.filter((m) => m.role === "user").slice(-IMAGE_TURNS);
  const latest = users[users.length - 1];
  const readBy = () =>
    latest?.parts.find((p): p is ImagePart => p.type === "image" && Boolean(p.describedBy))
      ?.describedBy ?? null;
  let todo: Job[] = users.flatMap((m) =>
    m.parts
      .filter(
        (p): p is ImagePart => p.type === "image" && (!p.description || BLIND.test(p.description))
      )
      .map((p) => ({ m, p }))
  );
  if (!todo.length) return readBy();
  // A cached "no image" from a gateway that dropped the photo is no description at all.
  for (const { p } of todo) {
    delete p.description;
    delete p.describedBy;
  }

  const candidates = await engine.ctx.runQuery(internal.engine.data.visionCandidates, {
    userId: engine.userId,
  });
  const ranked = rankVisionModels(candidates, {
    providerId: engine.providerId,
    id: engine.modelId,
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DESCRIBE_TIMEOUT_MS);
  const onStop = () => abort.abort();
  signal?.addEventListener("abort", onStop);
  const urls = new Map<string, Promise<string | null>>();
  const urlOf = (p: ImagePart) => {
    if (!urls.has(p.id))
      urls.set(
        p.id,
        imageUrl(engine.ctx, p).catch(() => null)
      );
    return urls.get(p.id)!;
  };
  const ask = question.trim()
    ? `The user's message: "${question.trim().slice(0, 2000)}"`
    : "The user sent this photo without a message.";
  const saved = new Map<Id<"messages">, { partId: string; description: string; by: string }[]>();
  const usage: Promise<unknown>[] = [];

  try {
    for (const pick of ranked.slice(0, MAX_TRIES)) {
      if (!todo.length || abort.signal.aborted) break;
      const ref = `${pick.providerId}/${pick.id}`;
      let seer: Engine;
      try {
        seer = await modelEngine(engine.ctx, engine, ref);
      } catch {
        continue;
      }
      const spent = { prompt: 0, completion: 0, cost: 0, priced: true };
      // Claude only thinks when asked, and even its lowest level spends a thinking budget.
      const profile = /claude/i.test(seer.modelId)
        ? { ...seer.profile, reasoning: { ...seer.profile.reasoning, style: "none" as const } }
        : seer.profile;

      const read = async ({ p }: Job): Promise<string | null> => {
        const url = await urlOf(p);
        if (!url) return null;
        const built = buildRequest({
          model: seer.modelId,
          profile,
          // As little reasoning as the model allows: this is a look, not a think.
          level: "off",
          difficulty: "easy",
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: [
                { type: "text", text: ask },
                { type: "image_url", image_url: { url } },
              ],
            },
          ],
          maxTokens: 1000,
        });
        try {
          const t0 = Date.now();
          const res = await complete(seer.endpoint, built.body, abort.signal);
          console.log(
            `[vision] ${ref} ${prefersMessages(seer.endpoint.baseUrl, seer.modelId) ? "messages" : "chat"} ${Date.now() - t0}ms in=${res.usage?.promptTokens ?? "?"} out=${res.usage?.completionTokens ?? "?"} chars=${res.text.length}`
          );
          const pt = res.usage?.promptTokens ?? 0;
          const ct = res.usage?.completionTokens ?? 0;
          const cost = res.usage?.costUsd ?? estimateCost(seer, pt, ct);
          spent.prompt += pt;
          spent.completion += ct;
          if (cost === undefined) spent.priced = false;
          else spent.cost += cost;
          const text = res.text.trim();
          return text && !BLIND.test(text) ? text : null;
        } catch (e) {
          console.warn(`[vision] ${ref} couldn't read a photo:`, (e as Error).message);
          return null;
        }
      };

      let results = await Promise.all(todo.map(read));
      // Nothing came back (the gateway dropped the images): Claude-style gateways often keep them
      // on the Messages API, so the same model gets one more try there.
      if (
        results.every((r) => r === null) &&
        !abort.signal.aborted &&
        !prefersMessages(seer.endpoint.baseUrl, seer.modelId) &&
        routeToMessages(seer.endpoint.baseUrl, seer.modelId)
      ) {
        results = await Promise.all(todo.map(read));
      }
      if (spent.prompt || spent.completion) {
        usage.push(
          engine.ctx.runMutation(internal.providers.recordUsage, {
            userId: engine.userId,
            providerId: seer.providerId,
            promptTokens: spent.prompt,
            completionTokens: spent.completion,
            costUsd: spent.priced ? spent.cost : undefined,
          })
        );
      }
      const left: Job[] = [];
      todo.forEach((job, i) => {
        const text = results[i];
        if (!text) return void left.push(job);
        // The history this turn already loaded sees the description too.
        job.p.description = text;
        job.p.describedBy = ref;
        const list = saved.get(job.m._id) ?? [];
        list.push({ partId: job.p.id, description: text, by: ref });
        saved.set(job.m._id, list);
      });
      if (left.length === todo.length) console.warn(`[vision] ${ref} saw none of the photos`);
      todo = left;
    }
    await Promise.allSettled([
      ...[...saved].map(([messageId, items]) =>
        engine.ctx.runMutation(internal.engine.data.setImageDescriptions, { messageId, items })
      ),
      ...usage,
    ]);
    return readBy();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onStop);
  }
}
