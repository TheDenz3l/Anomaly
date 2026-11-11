import type { ShareIntentFile } from "expo-share-intent";
import { describe, expect, it } from "vitest";
import { fileAttachment, MAX_ATTACHMENTS, sharedContent } from "../src/lib/files";

const file = (over: Partial<ShareIntentFile> = {}): ShareIntentFile => ({
  path: "file:///group/a.pdf",
  fileName: "a.pdf",
  mimeType: "application/pdf",
  size: 1000,
  width: null,
  height: null,
  duration: null,
  ...over,
});

describe("fileAttachment", () => {
  it("keeps a photo a photo and anything else a file", () => {
    expect(
      fileAttachment({ uri: "x.jpg", mime: "image/jpeg", size: 1000, width: 4, height: 3 })
    ).toEqual({
      uri: "x.jpg",
      mime: "image/jpeg",
      width: 4,
      height: 3,
    });
    expect(
      fileAttachment({ uri: "x.pdf", name: "x.pdf", mime: "application/pdf", size: 9 }).kind
    ).toBe("file");
    expect(fileAttachment({ uri: "big.png", mime: "image/png", size: 9 * 1024 * 1024 }).kind).toBe(
      "file"
    );
  });
});

describe("sharedContent", () => {
  it("turns shared photos and files into attachments", () => {
    const out = sharedContent({
      text: null,
      webUrl: null,
      files: [
        file(),
        file({
          path: "file:///group/b.heic",
          fileName: "b.heic",
          mimeType: "image/heic",
          width: 4032,
          height: 3024,
        }),
      ],
    });
    expect(out.text).toBe("");
    expect(out.note).toBeUndefined();
    expect(out.attachments).toEqual([
      {
        uri: "file:///group/a.pdf",
        kind: "file",
        name: "a.pdf",
        mime: "application/pdf",
        size: 1000,
      },
      { uri: "file:///group/b.heic", mime: "image/heic", width: 4032, height: 3024 },
    ]);
  });

  it("leaves out files over 25 MB and past the attachment limit, and says so", () => {
    const tooBig = sharedContent({
      text: null,
      webUrl: null,
      files: [file({ size: 30 * 1024 * 1024 })],
    });
    expect(tooBig.attachments).toEqual([]);
    expect(tooBig.note).toBe("a.pdf is over 25 MB, so it was left out.");
    const many = sharedContent({
      text: null,
      webUrl: null,
      files: Array.from({ length: MAX_ATTACHMENTS + 2 }, () => file()),
    });
    expect(many.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(many.note).toBe(`Up to ${MAX_ATTACHMENTS} attachments per message, so 2 were left out.`);
  });

  it("puts shared text or a link in the message", () => {
    expect(sharedContent({ text: " look at this ", webUrl: null, files: null }).text).toBe(
      "look at this"
    );
    expect(sharedContent({ text: null, webUrl: "https://example.com", files: null }).text).toBe(
      "https://example.com"
    );
  });
});
