import { describe, expect, it } from "vitest";
import { dimensions, imageModelsFrom, normalizeEndpoint, wantsImage } from "../convex/engine/image";
import { DotFlow } from "../src/genui/components/dotflow";

describe("generated image size", () => {
  it("reads a PNG header", () => {
    const b = new Uint8Array(32);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    b.set([0, 0, 4, 0], 16);
    b.set([0, 0, 6, 0], 20);
    expect(dimensions(b)).toEqual({ width: 1024, height: 1536 });
  });

  it("reads a JPEG frame header", () => {
    const b = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x00,
      0x04, 0x00, 0x03,
    ]);
    expect(dimensions(b)).toEqual({ width: 1024, height: 1536 });
  });

  it("gives up on anything else", () => {
    expect(dimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe("image endpoints", () => {
  it("finds Nano Banana's API base from any part of it", () => {
    for (const raw of [
      "https://nanobanana.expert",
      "https://nanobanana.expert/docs",
      "https://nanobanana.expert/api/v1",
      "https://nanobanana.expert/api/v1/generate/",
    ])
      expect(normalizeEndpoint(raw)).toEqual({
        baseUrl: "https://nanobanana.expert/api/v1",
        flavor: "nanobanana",
      });
  });

  it("keeps an OpenAI-style base and drops a route pasted after it", () => {
    expect(normalizeEndpoint("https://api.openai.com/v1/images/generations")).toEqual({
      baseUrl: "https://api.openai.com/v1",
    });
    expect(normalizeEndpoint("https://openrouter.ai")).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      flavor: "chat",
    });
  });

  it("picks the image models out of a model list", () => {
    const models = imageModelsFrom([
      { id: "gpt-4o" },
      { id: "gpt-image-1" },
      { id: "dall-e-3" },
      { id: "text-embedding-3-small" },
      {
        id: "google/gemini-2.5-flash-image",
        name: "Gemini Flash Image",
        architecture: { output_modalities: ["image", "text"] },
      },
      { id: "openai/gpt-4o", architecture: { output_modalities: ["text"] } },
      { id: "black-forest-labs/FLUX.1-schnell", type: "image" },
      { id: "meta-llama/Llama-3-8b", type: "chat" },
    ]).map((m) => m.id);
    expect(models.sort()).toEqual(
      [
        "black-forest-labs/FLUX.1-schnell",
        "dall-e-3",
        "google/gemini-2.5-flash-image",
        "gpt-image-1",
      ].sort()
    );
  });
});

describe("image requests", () => {
  it("spots a request for a picture", () => {
    for (const t of [
      "Generate an image of a duck riding a bike",
      "Generate me an image of a boxing monkey",
      "can you make a logo for my coffee shop",
      "Draw a cat in a spacesuit",
      "create a wallpaper with neon mountains",
    ])
      expect(wantsImage(t)).toBe(true);
  });

  it("leaves other requests alone", () => {
    for (const t of [
      "What's the weather in Toronto?",
      "Show me photos of the Eiffel Tower",
      "How do I make a sourdough starter?",
    ])
      expect(wantsImage(t)).toBe(false);
  });
});

describe("dot field", () => {
  it("draws dots while the image renders", () => {
    const f = new DotFlow(340, 340).step(1 / 30, 0);
    expect(f.done).toBe(false);
    expect(f.bands.some((d) => d.length > 100)).toBe(true);
    expect(f.cover).toBe("M0 0H340V340H0Z");
  });

  it("opens the cover cell by cell until the image is whole", () => {
    const flow = new DotFlow(300, 200);
    let now = 0;
    for (let i = 0; i < 10; i++) flow.step(1 / 30, (now += 33));
    flow.reveal(now);
    let frame = flow.step(1 / 30, (now += 33));
    for (let i = 0; i < 200 && !frame.done; i++) frame = flow.step(1 / 30, (now += 33));
    expect(frame.done).toBe(true);
    // Every cell is a rectangle by then: no round windows left, nothing overlapping.
    expect(frame.cover).not.toContain("a");
    expect(frame.dots).toBe(0);
  });
});
