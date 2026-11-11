import { describe, expect, it } from "vitest";
import type { Doc } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server";
import { toChatMessages } from "../convex/engine/history";
import { stripVideos } from "../convex/engine/loop";
import { linkedVideos, videoSight, type VideoBlock } from "../convex/engine/video";
import {
  frameSheets,
  parseCaptions,
  parseStoryboard,
  pickTrack,
  transcriptText,
  unescapeCaption,
  videoText,
  withoutVideoLinks,
  youtubeIds,
  type VideoInfo,
} from "../convex/web/youtube";

describe("YouTube links", () => {
  it("finds every form of video link, once each", () => {
    expect(
      youtubeIds(
        "look https://youtu.be/JI3bbZNdyeA?si=x and https://www.youtube.com/watch?v=jNQXAC9IVRw&t=4 " +
          "https://m.youtube.com/shorts/5eJnIYrr8rg https://youtube.com/live/abcdefghijk again https://youtu.be/JI3bbZNdyeA"
      )
    ).toEqual(["JI3bbZNdyeA", "jNQXAC9IVRw", "5eJnIYrr8rg"]);
    expect(youtubeIds("https://www.youtube.com/@matthew_berman and https://example.com")).toEqual(
      []
    );
  });

  it("tells a message that links only videos from one that links a page too", () => {
    expect(withoutVideoLinks("analyze https://youtu.be/JI3bbZNdyeA?si=x please")).not.toMatch(
      /https?:/
    );
    expect(withoutVideoLinks("vs https://example.com/a")).toContain("https://example.com/a");
    expect(withoutVideoLinks("channel https://www.youtube.com/@matthew_berman")).toContain(
      "youtube.com/@"
    );
  });
});

describe("captions", () => {
  it("reads both caption formats and their escapes", () => {
    expect(
      parseCaptions(
        '<transcript><text start="0.5" dur="2">It&amp;#39;s happening</text><text start="3" dur="1">  </text><text start="4.2" dur="1">A &amp;amp; B</text></transcript>'
      )
    ).toEqual([
      { at: 0.5, text: "It's happening" },
      { at: 4.2, text: "A & B" },
    ]);
    expect(
      parseCaptions(
        '<timedtext><body><p t="1500" d="900"><s>Hello</s><s> world</s></p></body></timedtext>'
      )
    ).toEqual([{ at: 1.5, text: "Hello world" }]);
    expect(unescapeCaption("Tom &amp;quot;T&amp;quot;\n&#x1F600;")).toBe('Tom "T" 😀');
  });

  it("prefers written English captions, then generated English, then any", () => {
    const t = (languageCode: string, kind?: string) => ({
      baseUrl: languageCode + (kind ?? ""),
      languageCode,
      kind,
    });
    expect(pickTrack([t("en", "asr"), t("en-GB"), t("de")])?.baseUrl).toBe("en-GB");
    expect(pickTrack([t("de"), t("en", "asr")])?.baseUrl).toBe("enasr");
    expect(pickTrack([t("ja", "asr"), t("ko")])?.baseUrl).toBe("ko");
    expect(pickTrack([])).toBeNull();
  });

  it("joins lines into timed paragraphs", () => {
    const lines = [
      { at: 0, text: "one" },
      { at: 12, text: "two" },
      { at: 31, text: "three" },
      { at: 3700, text: "late" },
    ];
    expect(transcriptText(lines)).toBe("[0:00] one two\n[0:31] three\n[1:01:40] late");
  });
});

const info = (over: Partial<VideoInfo> = {}): VideoInfo => ({
  id: "JI3bbZNdyeA",
  title: "It's happening...",
  channel: "Matthew Berman",
  seconds: 2061,
  live: false,
  description: "Anthropic files its S-1",
  published: "2026-10-26",
  views: 8200,
  transcript: {
    language: "English (auto-generated)",
    auto: true,
    lines: Array.from({ length: 400 }, (_, i) => ({ at: i * 5, text: `line ${i} about the S-1` })),
  },
  ...over,
});

describe("videoText", () => {
  it("says what the video is, then its timed transcript", () => {
    const text = videoText(info());
    expect(text).toMatch(
      /^YouTube video: "It's happening\.\.\." by Matthew Berman \(34:21, published 2026-10-26, 8K views\)/
    );
    expect(text).toContain("generated from the audio");
    expect(text).toContain("[0:00] line 0 about the S-1");
    expect(text).not.toContain("transcript is cut");
  });

  it("cuts a long transcript at a paragraph and says where", () => {
    const text = videoText(info(), 4_000);
    expect(text.length).toBeLessThan(4_000);
    expect(text).toMatch(/The transcript is cut here, at [\d:]+ of 34:21/);
  });

  it("says why there's no transcript", () => {
    expect(videoText(info({ transcript: null, note: "the video has no captions" }))).toContain(
      "No transcript: the video has no captions."
    );
  });
});

describe("storyboard frames", () => {
  const spec =
    "https://i.ytimg.com/sb/ID/storyboard3_L$L/$N.jpg?sqp=abc|48#27#100#10#10#0#default#rs$a|80#45#208#10#10#10000#M$M#rs$b|160#90#208#5#5#10000#M$M#rs$c|320#180#208#3#3#10000#M$M#rs$d";

  it("reads every size with its signed URL", () => {
    const sb = parseStoryboard(spec)!;
    expect(sb.levels.map((l) => [l.width, l.cols, l.intervalMs])).toEqual([
      [48, 10, 0],
      [80, 10, 10000],
      [160, 5, 10000],
      [320, 3, 10000],
    ]);
    expect(sb.levels[3].url).toBe(
      "https://i.ytimg.com/sb/ID/storyboard3_L3/$N.jpg?sqp=abc&sigh=rs$d"
    );
  });

  it("takes the sharpest size that covers the whole video", () => {
    const sheets = frameSheets(parseStoryboard(spec)!, 2061, 10);
    expect(sheets).toHaveLength(9);
    expect(sheets[0]).toMatchObject({ from: 0, to: 240, frames: 25, cols: 5, step: 10 });
    expect(sheets[0].url).toContain("storyboard3_L2/M0.jpg");
    expect(sheets[8]).toMatchObject({ from: 2000, to: 2061, frames: 8 });
  });

  it("spreads sheets through a video too long to cover", () => {
    const sheets = frameSheets(parseStoryboard(spec)!, 2061, 4);
    expect(sheets.map((s) => s.url.match(/M(\d+)/)![1])).toEqual(["0", "3", "5", "8"]);
  });
});

describe("how a model is shown a video", () => {
  it("lets Gemini on OpenRouter watch it and gives other vision models frames", () => {
    const or = "https://openrouter.ai/api/v1";
    expect(videoSight({ baseUrl: or, modelId: "google/gemini-4-argon", vision: true })).toBe(
      "native"
    );
    expect(
      videoSight({ baseUrl: "https://7api.st", modelId: "gemini-4-argon", vision: true })
    ).toBe("frames");
    expect(videoSight({ baseUrl: or, modelId: "openai/gpt-6", vision: true })).toBe("frames");
    expect(videoSight({ baseUrl: or, modelId: "google/gemini-4-argon", vision: false })).toBe(
      "none"
    );
  });

  it("drops video parts when an endpoint refuses them", () => {
    const out = stripVideos([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "video_url", video_url: { url: "https://www.youtube.com/watch?v=JI3bbZNdyeA" } },
        ],
      },
    ]);
    expect(out[0].content).toEqual([{ type: "text", text: "hi" }]);
  });
});

const user = (text: string) =>
  ({
    role: "user",
    parts: [{ id: `t-${text}`, type: "text", text }],
  }) as unknown as Doc<"messages">;
const reply = (text: string) =>
  ({
    role: "assistant",
    parts: [{ id: `a-${text}`, type: "text", text }],
  }) as unknown as Doc<"messages">;

describe("videos in the conversation", () => {
  it("finds the videos linked in recent user turns", () => {
    const history = [
      user("https://youtu.be/AAAAAAAAAAA"),
      reply("ok"),
      user("and https://youtu.be/BBBBBBBBBBB"),
    ];
    expect(linkedVideos(history)).toEqual([
      { index: 0, ids: ["AAAAAAAAAAA"] },
      { index: 2, ids: ["BBBBBBBBBBB"] },
    ]);
  });

  it("go after the message that last linked them, transcript and frames together", async () => {
    const block: VideoBlock = {
      text: "[The user linked the YouTube video …]\n<untrusted_web_content>transcript</untrusted_web_content>",
      parts: [
        { type: "text", text: "[Frames 0:00–4:00 …]" },
        { type: "image_url", image_url: { url: "data:image/webp;base64,AAA" } },
      ],
      info: null,
    };
    const history = [
      user("Can you analyze this video? https://youtu.be/JI3bbZNdyeA"),
      reply("Sure."),
      user("What did he say about the S-1?"),
    ];
    const out = await toChatMessages({} as ActionCtx, history, {
      vision: true,
      maxChars: 100_000,
      videos: new Map([["JI3bbZNdyeA", block]]),
    });
    const first = out.messages[0].content as { type: string; text?: string }[];
    expect(first.map((c) => c.type)).toEqual(["text", "text", "text", "image_url"]);
    expect(first[1].text).toContain("transcript");
    expect(out.messages[2].content).toBe("What did he say about the S-1?");
  });
});
