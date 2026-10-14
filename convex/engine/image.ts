import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { fetchBalance } from "../ai/balance";
import { listModels, LlmError, requestJson, type Endpoint } from "../ai/openai";
import { decryptSecret, fromBase64 } from "../lib/crypto";
import { errorMessage, truncate, uid } from "../lib/util";
import type { Part } from "../lib/validators";
import type { LoopTool, ToolOutcome } from "./loop";
import type { ToolEnv } from "./tools";

/**
 * Image generation through the user's own endpoint (Settings → Image generation). The user gives
 * an endpoint and a key; probing them finds the image models the key can use and how to call them:
 * an OpenAI-style images API, a chat model that answers with an image (OpenRouter), or Nano Banana
 * Expert's own API. The picture is stored with the chat and drawn by the ImageGeneration card,
 * which shows the model's running commentary while it renders.
 */

export type ImageFlavor = "openai" | "chat" | "nanobanana";
export type ImageModelOption = { id: string; name: string; note?: string };
/** What's left on the key: money, or a service's own credits (Nano Banana's bananas). */
export type ImageBalance = {
  remaining?: number;
  total?: number;
  used?: number;
  unit: string;
  money: boolean;
};
export type ImageProbe = {
  baseUrl: string;
  flavor: ImageFlavor;
  models: ImageModelOption[];
  balance?: ImageBalance;
};

/** Shapes, phone first: portrait unless the picture calls for another. */
export type Aspect = "portrait" | "square" | "landscape" | "tall" | "wide";
const ASPECTS: Aspect[] = ["portrait", "square", "landscape", "tall", "wide"];
const SHAPES: Record<Aspect, { label: string; w: number; h: number }> = {
  portrait: { label: "3:4", w: 3, h: 4 },
  square: { label: "1:1", w: 1, h: 1 },
  landscape: { label: "4:3", w: 4, h: 3 },
  tall: { label: "9:16", w: 9, h: 16 },
  wide: { label: "16:9", w: 16, h: 9 },
};

type ImageGenConfig = { baseUrl: string; model: string; keyCipher?: string; flavor?: ImageFlavor };
type Generated = { bytes: Uint8Array<ArrayBuffer>; mime: string };

/** Image models take 10–90 s; slow queues longer. */
const GENERATE_MS = 240_000;
const DOWNLOAD_MS = 60_000;
const PROBE_MS = 20_000;
const MAX_STEPS = 6;
const DEFAULT_STEPS = [
  "Reading the brief",
  "Blocking in the shapes",
  "Mixing the colours",
  "Sharpening the details",
  "Adding the last touches",
];

const NANO_BANANA_HOST = /(^|\.)nanobanana\.expert$/i;
const OPENROUTER_HOST = /(^|\.)openrouter\.ai$/i;

/** Nano Banana Expert lists no models over its API; these are its image models (nanobanana.expert/docs). */
const NANO_BANANA_MODELS: ImageModelOption[] = [
  { id: "nb2", name: "Nano Banana 2", note: "General purpose, the service's default" },
  { id: "gpt2", name: "GPT Image 2", note: "Best with text inside images" },
  { id: "gpt25_flare", name: "GPT Image 2.5 Flare", note: "Fast, GPT Image 2 quality" },
  { id: "gpt25_sunburst", name: "GPT Image 2.5 Sunburst", note: "Top quality and precise edits" },
  { id: "recraft_v41", name: "Recraft V4.1", note: "Design, banners and branding" },
  { id: "recraft_v41_utility", name: "Recraft V4.1 Utility", note: "Fast, lightweight Recraft" },
  { id: "recraft_v41_vector", name: "Recraft V4.1 Vector", note: "SVG logos and icons" },
];

/**
 * The API base for whatever the user pasted: a site, an API root or a full route. Known services
 * get their real base and calling style whichever part of it was given.
 */
export function normalizeEndpoint(raw: string): { baseUrl: string; flavor?: ImageFlavor } {
  const u = new URL(raw.trim());
  const path = u.pathname
    .replace(/\/+$/, "")
    .replace(/\/(images\/generations|chat\/completions|generate|models|balance)$/, "");
  if (NANO_BANANA_HOST.test(u.host)) return { baseUrl: `${u.origin}/api/v1`, flavor: "nanobanana" };
  if (OPENROUTER_HOST.test(u.host))
    return { baseUrl: `${u.origin}${path || "/api/v1"}`, flavor: "chat" };
  return { baseUrl: `${u.origin}${path}` };
}

const IMAGE_ID =
  /gpt-image|dall-e|imagen|image|flux|sdxl|stable-diffusion|sd3|recraft|ideogram|seedream|kandinsky|playground|banana|hidream|midjourney|aurora/i;

/** The image models in a /models answer: by their declared output where they say, by name otherwise. */
export function imageModelsFrom(list: unknown[]): ImageModelOption[] {
  const out: ImageModelOption[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const m = item as { id?: unknown; name?: unknown; type?: unknown; architecture?: any };
    const id = typeof item === "string" ? item : String(m?.id ?? "");
    if (!id || seen.has(id)) continue;
    const outputs = m?.architecture?.output_modalities;
    const image = Array.isArray(outputs)
      ? outputs.includes("image")
      : typeof m?.type === "string"
        ? m.type === "image"
        : IMAGE_ID.test(id);
    if (!image) continue;
    seen.add(id);
    out.push({ id, name: typeof m?.name === "string" && m.name ? m.name : id });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
}

/** Checks the key against the endpoint and lists the image models it can use. */
export async function probeImageEndpoint(
  raw: string,
  apiKey: string | undefined
): Promise<ImageProbe> {
  const { baseUrl, flavor } = normalizeEndpoint(raw);
  if (flavor === "nanobanana") {
    // Its balance route is the cheapest call that proves the key.
    const balance = await readImageBalance(baseUrl, apiKey, flavor);
    return { baseUrl, flavor, models: NANO_BANANA_MODELS, ...(balance ? { balance } : {}) };
  }
  const list = await listModels({ baseUrl, apiKey, headers: [] });
  const balance = await readImageBalance(baseUrl, apiKey, flavor ?? "openai").catch(() => null);
  return {
    baseUrl,
    flavor: flavor ?? "openai",
    models: imageModelsFrom(list),
    ...(balance ? { balance } : {}),
  };
}

const amount = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/**
 * What's left on the key, in whatever the service reports: Nano Banana's bananas, or money for
 * the providers convex/ai/balance.ts knows. Null when the service doesn't say.
 */
export async function readImageBalance(
  baseUrl: string,
  apiKey: string | undefined,
  flavor: ImageFlavor
): Promise<ImageBalance | null> {
  const ep: Endpoint = { baseUrl: normalizeEndpoint(baseUrl).baseUrl, apiKey, headers: [] };
  if (flavor === "nanobanana") {
    const res = await requestJson(ep, "/balance", { timeoutMs: PROBE_MS });
    const bananas = amount(res?.bananas);
    return bananas === undefined ? null : { remaining: bananas, unit: "bananas", money: false };
  }
  const b = await fetchBalance(ep);
  if (!b) return null;
  return {
    ...(b.remaining !== undefined ? { remaining: b.remaining } : {}),
    ...(b.total !== undefined ? { total: b.total } : {}),
    ...(b.used !== undefined ? { used: b.used } : {}),
    unit: b.currency,
    money: true,
  };
}

/** Whether a message asks for a picture to be made, so the step that calls the tool can be quick. */
export function wantsImage(text: string): boolean {
  return (
    /\b(generate|create|make|draw|paint|design|render|imagine|sketch|illustrate)\b[^.?!\n]{0,60}\b(image|picture|pic|illustration|drawing|painting|logo|icon|wallpaper|poster|artwork|art|portrait|render|sticker)s?\b/i.test(
      text
    ) || /^\s*(draw|paint|sketch|illustrate)\b/i.test(text)
  );
}

/** Why a probe failed, as a sentence for the settings sheet. */
export function probeFailure(e: unknown): string {
  if (e instanceof LlmError && (e.status === 404 || e.status === 405))
    return "There's no model list at this address. Check the endpoint, or type the model ID from its docs.";
  const reason = reasonOf(e, "");
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

function sizeFor(model: string, aspect: Aspect): string {
  const m = model.toLowerCase();
  const tall = aspect === "portrait" || aspect === "tall";
  const wide = aspect === "landscape" || aspect === "wide";
  if (m.includes("dall-e-2")) return "1024x1024";
  if (m.includes("dall-e-3")) return tall ? "1024x1792" : wide ? "1792x1024" : "1024x1024";
  return tall ? "1024x1536" : wide ? "1536x1024" : "1024x1024";
}

/** Width over height of the picture the endpoint will send back, so the card has its shape from the start. */
function ratioOf(flavor: ImageFlavor, model: string, aspect: Aspect): number {
  if (flavor === "openai") {
    const [w, h] = sizeFor(model, aspect).split("x").map(Number);
    return w / h;
  }
  return SHAPES[aspect].w / SHAPES[aspect].h;
}

function flavorOf(cfg: ImageGenConfig): ImageFlavor {
  const known = normalizeEndpoint(cfg.baseUrl).flavor;
  return known === "nanobanana" ? known : (cfg.flavor ?? known ?? "openai");
}

function sniff(b: Uint8Array): string | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (ascii(b, 0, 4) === "GIF8") return "image/gif";
  return undefined;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, to));
}

/** Width and height from a PNG, JPEG or WebP header, without decoding the image. */
export function dimensions(b: Uint8Array): { width: number; height: number } | null {
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const mime = sniff(b);
  if (mime === "image/png" && b.length > 24) return { width: u32(16), height: u32(20) };
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + len;
    }
    return null;
  }
  if (mime === "image/webp" && b.length > 30) {
    const kind = ascii(b, 12, 16);
    if (kind === "VP8X")
      return {
        width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      };
    if (kind === "VP8 ")
      return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === "VP8L") {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

const DATA_URL = /^data:([^;,]+)?(;base64)?,(.*)$/s;

async function download(url: string): Promise<Generated> {
  const data = DATA_URL.exec(url);
  if (data) {
    const bytes = data[2]
      ? fromBase64(data[3])
      : (new TextEncoder().encode(decodeURIComponent(data[3])) as Uint8Array<ArrayBuffer>);
    return { bytes, mime: data[1] || sniff(bytes) || "image/png" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`The image couldn't be downloaded (${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get("content-type")?.split(";")[0].trim();
    return { bytes, mime: sniff(bytes) ?? (type?.startsWith("image/") ? type : "image/png") };
  } finally {
    clearTimeout(timer);
  }
}

/** What the endpoint sent back: the picture itself, or a link to it (and what it cost, if it says). */
type Drawn = ({ bytes: Uint8Array<ArrayBuffer>; mime: string } | { link: string }) & {
  spent?: number;
};

/** A data URL is the picture itself; anything else is a link to fetch. */
const drawnFrom = (url: string): Promise<Drawn> | Drawn =>
  DATA_URL.test(url) ? download(url) : { link: url };

async function viaImages(
  ep: Endpoint,
  model: string,
  prompt: string,
  aspect: Aspect
): Promise<Drawn> {
  const body: Record<string, unknown> = { model, prompt, n: 1, size: sizeFor(model, aspect) };
  // DALL·E answers with a short-lived link unless asked; gpt-image models reject the field.
  if (/dall-e/i.test(model)) body.response_format = "b64_json";
  let res: any;
  try {
    res = await requestJson(ep, "/images/generations", { body, timeoutMs: GENERATE_MS });
  } catch (e) {
    // Sizes differ by model: one that turns ours down draws at its default instead.
    if (!(e instanceof LlmError) || e.status !== 400 || !/size|dimension|resolution/i.test(e.body))
      throw e;
    delete body.size;
    res = await requestJson(ep, "/images/generations", { body, timeoutMs: GENERATE_MS });
  }
  const item = res?.data?.[0];
  if (typeof item?.b64_json === "string") {
    const bytes = fromBase64(item.b64_json);
    const format = typeof res.output_format === "string" ? `image/${res.output_format}` : undefined;
    return { bytes, mime: sniff(bytes) ?? format ?? "image/png" };
  }
  if (typeof item?.url === "string") return drawnFrom(item.url);
  throw new Error("The endpoint answered without an image.");
}

async function viaChat(
  ep: Endpoint,
  model: string,
  prompt: string,
  aspect: Aspect
): Promise<Drawn> {
  const res = await requestJson(ep, "/chat/completions", {
    body: {
      model,
      messages: [{ role: "user", content: `${prompt}\n\nAspect ratio ${SHAPES[aspect].label}.` }],
      modalities: ["image", "text"],
    },
    timeoutMs: GENERATE_MS,
  });
  const msg = res?.choices?.[0]?.message;
  const url =
    msg?.images?.[0]?.image_url?.url ??
    (Array.isArray(msg?.content)
      ? msg.content.find((c: any) => c?.type === "image_url")?.image_url?.url
      : undefined);
  if (typeof url !== "string")
    throw new Error(
      "The model answered without an image. Check that the model ID is an image model."
    );
  return drawnFrom(url);
}

async function viaNanoBanana(
  ep: Endpoint,
  model: string,
  prompt: string,
  aspect: Aspect
): Promise<Drawn> {
  const res = await requestJson(ep, "/generate", {
    body: {
      prompt,
      model,
      aspect_ratio: SHAPES[aspect].label,
      resolution: "1k",
      output_format: "png",
    },
    timeoutMs: GENERATE_MS,
  });
  if (typeof res?.image_url !== "string")
    throw new Error(
      typeof res?.error === "string" ? res.error : "The endpoint answered without an image."
    );
  const spent = amount(res.bananas_spent);
  return { link: res.image_url, ...(spent !== undefined ? { spent } : {}) };
}

async function draw(cfg: ImageGenConfig, prompt: string, aspect: Aspect): Promise<Drawn> {
  const apiKey = cfg.keyCipher ? await decryptSecret(cfg.keyCipher) : undefined;
  const ep: Endpoint = { baseUrl: normalizeEndpoint(cfg.baseUrl).baseUrl, apiKey, headers: [] };
  const flavor = flavorOf(cfg);
  if (flavor === "nanobanana") return viaNanoBanana(ep, cfg.model, prompt, aspect);
  if (flavor === "chat") return viaChat(ep, cfg.model, prompt, aspect);
  try {
    return await viaImages(ep, cfg.model, prompt, aspect);
  } catch (e) {
    // No images route here: the model may draw through chat completions instead.
    if (e instanceof LlmError && (e.status === 404 || e.status === 405))
      return viaChat(ep, cfg.model, prompt, aspect);
    throw e;
  }
}

/** What went wrong, in words the user can act on. Status first: error pages can say anything. */
function reasonOf(e: unknown, model: string): string {
  if (e instanceof LlmError) {
    const page = e.body.trimStart().startsWith("<");
    if (e.status === 401 || e.status === 403) return "the image endpoint turned down the API key.";
    if (e.status === 402 || (!page && /insufficient|out of credit|top up|balance/i.test(e.body)))
      return "the image account is out of credit. Top it up, then try again.";
    if (e.status === 404 || e.status === 405)
      return model
        ? `the endpoint has no image route at this address, or doesn't know the model "${model}".`
        : "the endpoint has nothing at this address.";
    if (e.status === 429) return "the image endpoint is rate limiting requests right now.";
    if (e.status >= 500)
      return "the image service had a problem on its side. Try again in a moment.";
    if (e.kind === "network") return truncate(e.message, 200);
    if (page) return `the endpoint answered with an error page (${e.status}).`;
    return truncate(e.message.replace(/^\d+ from provider: /, ""), 240);
  }
  return truncate(errorMessage(e), 240);
}

/** Lines the user reads while the image renders: plain, short, no emoji. */
function cleanStep(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, "")
    .replace(/\s+/g, " ")
    .replace(/[.!…]+$/u, "")
    .trim()
    .slice(0, 48);
}

const NOT_SET_UP =
  "Image generation isn't set up. Tell the user, in a sentence, to add their image endpoint and API key in Settings → Image generation and pick a model, then ask again. Don't describe or fake an image.";

export function imageTool(env: ToolEnv): LoopTool {
  return {
    def: {
      type: "function",
      function: {
        name: "generate_image",
        description:
          "Create a new image with the user's own image model and show it in the chat. For pictures the user wants made (illustrations, scenes, logos, wallpapers, concept art), not photos of real things.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "A rich brief for the image model, in English: subject, setting, composition, lighting, style and mood. Include any text that must appear in the image, in quotes.",
            },
            aspect: {
              type: "string",
              enum: ASPECTS,
              description:
                "The shape, for a phone screen: portrait (3:4) unless the picture calls for another. tall (9:16) for wallpapers and stories, square for logos, icons and avatars, landscape (4:3) or wide (16:9) only for panoramas or when the user asks for a wide image.",
            },
            title: {
              type: "string",
              description: "A short caption, 2 to 8 words, e.g. 'Alpine lake at blue hour'.",
            },
            steps: {
              type: "array",
              items: { type: "string" },
              description:
                "4 to 6 short, playful lines the user reads one after another while it renders, in the order you'd work on this picture, 2 to 6 words each, specific to it: 'Mixing a dusk palette', 'Planting pines on the shore', 'Letting the mist settle'. Sentence case, no emoji, no closing punctuation.",
            },
          },
          required: ["prompt", "steps"],
          additionalProperties: false,
        },
      },
    },
    async run(args): Promise<ToolOutcome> {
      const cfg = env.engine.settings.imageGen;
      if (!cfg?.baseUrl || !cfg.model) return { content: NOT_SET_UP };
      if (!env.render) return { content: "Images can only be made in the main chat." };
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return { content: "prompt is required." };
      const aspect: Aspect = ASPECTS.includes(args.aspect) ? args.aspect : "portrait";
      const title = truncate(String(args.title ?? "").trim() || prompt, 80);
      const given: string[] = Array.isArray(args.steps)
        ? args.steps.map(cleanStep).filter(Boolean)
        : [];
      const steps = (given.length >= 2 ? given : DEFAULT_STEPS).slice(0, MAX_STEPS);

      const id = uid("cmp");
      env.sink.add({
        id,
        type: "component",
        name: "ImageGeneration",
        props: {
          title,
          prompt: truncate(prompt, 2000),
          aspect,
          ratio: ratioOf(flavorOf(cfg), cfg.model, aspect),
          steps,
          model: cfg.model,
          state: "working",
          startedAt: Date.now(),
        },
        status: "ready",
        fallbackText: `Creating an image: ${title}`,
      });
      const settle = (patch: Record<string, unknown>, fallbackText: string) =>
        env.sink.update(id, (p) => {
          const card = p as Extract<Part, { type: "component" }>;
          return { ...card, props: { ...(card.props as object), ...patch }, fallbackText };
        });

      const { ctx, userId } = env.engine;
      const done = `Done: the image ("${title}") is on screen above your reply. Answer in one or two short sentences: no Markdown image, no link, no long description. You can offer one specific change they might like.`;

      // A copy kept with the chat: the provider's link may not last, and deleting the chat deletes it.
      const keep = async (drawn: Drawn) => {
        const image = "link" in drawn ? await download(drawn.link) : drawn;
        const size = dimensions(image.bytes);
        const storageId: Id<"_storage"> = await ctx.storage.store(
          new Blob([image.bytes], { type: image.mime })
        );
        await ctx.runMutation(internal.attachments.recordGenerated, {
          userId,
          messageId: env.messageId,
          storageId,
          mime: image.mime,
          width: size?.width,
          height: size?.height,
          size: image.bytes.length,
        });
        const url = await ctx.storage.getUrl(storageId);
        if (!url) throw new Error("The image couldn't be saved.");
        settle(
          {
            state: "done",
            url,
            storageId,
            mime: image.mime,
            width: size?.width,
            height: size?.height,
          },
          `Generated an image: ${title}`
        );
        void env.sink.tick();
      };

      // Spend, the balance after it, and how long the model took, for Settings.
      const account = async (ms: number, spent?: number) => {
        const key = cfg.keyCipher ? await decryptSecret(cfg.keyCipher) : undefined;
        const balance = await readImageBalance(cfg.baseUrl, key, flavorOf(cfg)).catch(
          () => undefined
        );
        await ctx.runMutation(internal.settings.noteImageGen, {
          userId,
          model: cfg.model,
          ms,
          ...(spent !== undefined ? { spent } : {}),
          ...(balance !== undefined ? { balance } : {}),
        });
      };

      try {
        const startedAt = Date.now();
        const drawn = await draw(cfg, prompt, aspect);
        const ms = Date.now() - startedAt;
        const later = (env.background ??= []);
        if ("link" in drawn) {
          // The phone loads the picture straight from the provider while the server keeps its copy,
          // instead of waiting for the copy before it can start.
          settle(
            { state: "done", url: drawn.link, doneAt: Date.now() },
            `Generated an image: ${title}`
          );
          void env.sink.tick();
          later.push(
            keep(drawn).catch((e) => console.warn("[image] keeping a copy failed", errorMessage(e)))
          );
        } else {
          await keep(drawn);
          settle({ doneAt: Date.now() }, `Generated an image: ${title}`);
        }
        later.push(account(ms, drawn.spent).catch(() => {}));
        return { content: done };
      } catch (e) {
        const reason = reasonOf(e, cfg.model);
        settle(
          { state: "error", error: reason, doneAt: Date.now() },
          `Couldn't create the image: ${reason}`
        );
        return {
          content: `The image couldn't be created: ${reason} Tell the user in a sentence or two. If it's about the key, the model or the endpoint, point them to Settings → Image generation.`,
        };
      }
    },
  };
}
