/**
 * YouTube videos as text: title, channel, length, description and the captions with their times.
 * A watch page is a player with nothing to read, so links to videos are read through YouTube's own
 * player API instead: the watch page gives its public API key, and the Android client's player
 * response lists caption tracks whose URLs work without the web player's proof-of-origin token.
 * No imports, so it runs anywhere fetch does (actions, tests).
 */

const ID =
  /(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

/** The video id when a URL points at a YouTube video. */
export function youtubeId(url: string): string | null {
  return url.match(ID)?.[1] ?? null;
}

/** The text with its YouTube links taken out, to tell whether it links anything else. */
export function withoutVideoLinks(text: string): string {
  return text.replace(/\S*(?:youtube\.com|youtu\.be)\/\S*/gi, (u) => (youtubeId(u) ? "" : u));
}

/** Ids of the YouTube videos a message links to, in order, without repeats. */
export function youtubeIds(text: string, max = 3): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(ID.source, "g"))) {
    if (!out.includes(m[1])) out.push(m[1]);
    if (out.length >= max) break;
  }
  return out;
}

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export type CaptionLine = { at: number; text: string };

export type VideoInfo = {
  id: string;
  title: string;
  channel: string;
  seconds: number;
  live: boolean;
  description: string;
  published?: string;
  views?: number;
  transcript: {
    language: string;
    /** Captions YouTube generated from the audio, not ones the creator wrote. */
    auto: boolean;
    lines: CaptionLine[];
    /** Lines past this were left out to keep the video small enough to keep. */
    cutAt?: number;
  } | null;
  /** Why there's no transcript, or why the video couldn't be read at all. */
  note?: string;
  /** YouTube's seek-bar previews: sheets of small frames at a fixed interval. */
  storyboard?: Storyboard;
};

/** One size of the seek-bar previews. Sheet `n` is `url` with $N replaced by the sheet name. */
export type StoryboardLevel = {
  url: string;
  width: number;
  height: number;
  count: number;
  cols: number;
  rows: number;
  /** Milliseconds between frames; 0 when YouTube left it to the video's length. */
  intervalMs: number;
  /** "M$M" for numbered sheets (M0, M1…), "default" for a single one. */
  name: string;
};
export type Storyboard = { levels: StoryboardLevel[] };

/**
 * The player's storyboard spec: a URL template, then one "w#h#count#cols#rows#interval#name#sigh"
 * group per size, smallest first.
 */
export function parseStoryboard(spec: string): Storyboard | null {
  const [template, ...groups] = spec.split("|");
  if (!template?.startsWith("https://") || !groups.length) return null;
  const levels: StoryboardLevel[] = [];
  groups.forEach((g, i) => {
    const [w, h, count, cols, rows, interval, name, sigh] = g.split("#");
    const n = (s: string) => Number.parseInt(s, 10);
    if (![w, h, count, cols, rows].every((s) => n(s) > 0) || !name) return;
    const base = template.replace("$L", String(i));
    levels.push({
      url: `${base}${sigh ? `${base.includes("?") ? "&" : "?"}sigh=${sigh}` : ""}`,
      width: n(w),
      height: n(h),
      count: n(count),
      cols: n(cols),
      rows: n(rows),
      intervalMs: n(interval) || 0,
      name,
    });
  });
  return levels.length ? { levels } : null;
}

export type FrameSheet = {
  url: string;
  /** Seconds into the video of the sheet's first and last frame. */
  from: number;
  to: number;
  frames: number;
  cols: number;
  rows: number;
  /** Seconds between its frames. */
  step: number;
};

/**
 * Frame sheets that show the video, at most `max` of them: the sharpest size that covers the whole
 * video in that many sheets, or else sheets spread evenly through it.
 */
export function frameSheets(sb: Storyboard, seconds: number, max = 10): FrameSheet[] {
  const numbered = sb.levels.filter((l) => l.name.includes("$M"));
  if (!numbered.length) return [];
  const sheetsOf = (l: StoryboardLevel) => Math.ceil(l.count / (l.cols * l.rows));
  const sharpest = [...numbered].sort((a, b) => b.width - a.width);
  // Frames under ~120 px show nothing: better a sample of readable frames than all of tiny ones.
  const usable = sharpest.filter((l) => Math.max(l.width, l.height) >= 120);
  const pool = usable.length ? usable : sharpest.slice(0, 1);
  const level = pool.find((l) => sheetsOf(l) <= max) ?? pool[pool.length - 1];
  const per = level.cols * level.rows;
  const total = sheetsOf(level);
  const step = (level.intervalMs || (seconds > 0 ? (seconds * 1000) / level.count : 0)) / 1000;
  const picks =
    total <= max
      ? Array.from({ length: total }, (_, i) => i)
      : Array.from({ length: max }, (_, i) => Math.round((i * (total - 1)) / (max - 1)));
  return [...new Set(picks)].map((n) => {
    const first = n * per;
    const frames = Math.min(per, level.count - first);
    return {
      url: level.url.replace("$N", level.name.replace("$M", String(n))),
      from: first * step,
      to:
        seconds > 0 ? Math.min(seconds, (first + frames - 1) * step) : (first + frames - 1) * step,
      frames,
      cols: level.cols,
      rows: level.rows,
      step,
    };
  });
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
/** Skips the EU cookie-consent interstitial, which has no API key on it. */
const CONSENT = "CONSENT=YES+cb.20210328-17-p0.en+FX+667; SOCS=CAI";
const ANDROID = { clientName: "ANDROID", clientVersion: "20.10.38" };

export class VideoError extends Error {}

async function get(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) throw new VideoError(`YouTube answered ${res.status}`);
  return res;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Caption text is XML-escaped, and often HTML-escaped inside that (&amp;#39;). */
export function unescapeCaption(s: string): string {
  let out = s;
  for (let i = 0; i < 2; i++) {
    out = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code =
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }
  return out
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Both caption formats YouTube serves: <text start dur> (seconds) and srv3's <p t d> (ms). */
export function parseCaptions(xml: string): CaptionLine[] {
  const lines: CaptionLine[] = [];
  for (const m of xml.matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = unescapeCaption(m[2]);
    if (text) lines.push({ at: Number(m[1]), text });
  }
  if (lines.length) return lines;
  for (const m of xml.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = unescapeCaption(m[2]);
    if (text) lines.push({ at: Number(m[1]) / 1000, text });
  }
  return lines;
}

type Track = {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
};

/** Captions the creator wrote beat generated ones; English, then the video's own language. */
export function pickTrack(tracks: Track[], prefer = "en"): Track | null {
  const lang = (t: Track) => t.languageCode.toLowerCase().split("-")[0];
  const human = (t: Track) => t.kind !== "asr";
  return (
    tracks.find((t) => human(t) && lang(t) === prefer) ??
    tracks.find((t) => !human(t) && lang(t) === prefer) ??
    tracks.find(human) ??
    tracks[0] ??
    null
  );
}

const trackName = (t: Track) =>
  t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join("") ?? t.languageCode;

/** Title and channel from oEmbed, which answers even when the player API won't. */
async function oembed(
  id: string,
  signal?: AbortSignal
): Promise<{ title: string; channel: string } | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl(id))}`,
      { headers: { "User-Agent": UA }, signal }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { title?: string; author_name?: string };
    return j.title ? { title: j.title, channel: j.author_name ?? "" } : null;
  } catch {
    return null;
  }
}

/** Keeps a video's stored form under the web cache's size limit. */
const MAX_CAPTION_CHARS = 150_000;

export async function fetchVideo(id: string, signal?: AbortSignal): Promise<VideoInfo> {
  const page = await (
    await get(
      `${watchUrl(id)}&hl=en`,
      { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: CONSENT } },
      signal
    )
  ).text();
  if (/class="g-recaptcha"|\/sorry\/index/.test(page)) {
    throw new VideoError(
      "YouTube is asking this server to prove it isn't a bot, so it can't read videos right now"
    );
  }
  const key = page.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/)?.[1];
  const published = page.match(/"(?:publishDate|uploadDate)":\s*"([^"]+)"/)?.[1]?.slice(0, 10);
  const spec = page.match(
    /"playerStoryboardSpecRenderer":\s*\{\s*"spec":\s*"((?:[^"\\]|\\.)+)"/
  )?.[1];
  let storyboard: Storyboard | null = null;
  if (spec) {
    try {
      storyboard = parseStoryboard(JSON.parse(`"${spec}"`) as string);
    } catch {
      storyboard = null;
    }
  }

  let player: any = null;
  if (key) {
    try {
      player = await (
        await get(
          `https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
              "Accept-Language": "en-US,en;q=0.9",
            },
            body: JSON.stringify({ context: { client: { ...ANDROID, hl: "en" } }, videoId: id }),
          },
          signal
        )
      ).json();
    } catch (e) {
      if (signal?.aborted) throw e;
      player = null;
    }
  }

  const details = player?.videoDetails;
  const status: string = player?.playabilityStatus?.status ?? "";
  const reason: string =
    player?.playabilityStatus?.reason ?? player?.playabilityStatus?.messages?.join(" ") ?? "";
  const basics = details?.title
    ? { title: String(details.title), channel: String(details.author ?? "") }
    : await oembed(id, signal);
  if (!basics) {
    throw new VideoError(
      status && status !== "OK"
        ? `the video isn't available (${reason || status})`
        : "the video wasn't found"
    );
  }
  const info: VideoInfo = {
    id,
    ...basics,
    seconds: Number(details?.lengthSeconds ?? 0),
    live: Boolean(details?.isLiveContent && details?.isLive),
    description: String(details?.shortDescription ?? ""),
    ...(published ? { published } : {}),
    ...(details?.viewCount ? { views: Number(details.viewCount) } : {}),
    ...(storyboard ? { storyboard } : {}),
    transcript: null,
  };

  const tracks: Track[] = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = pickTrack(tracks);
  if (!track) {
    info.note = !player
      ? "YouTube didn't share the video's details with this server"
      : status && status !== "OK"
        ? `YouTube won't play it here (${reason || status})`
        : "the video has no captions";
    return info;
  }
  const xml = await (
    await get(track.baseUrl.replace(/&fmt=[^&]*/, ""), { headers: { "User-Agent": UA } }, signal)
  ).text();
  let lines = parseCaptions(xml);
  if (!lines.length) {
    info.note = "YouTube returned empty captions";
    return info;
  }
  let total = 0;
  const keep = lines.findIndex((l) => (total += l.text.length + 8) > MAX_CAPTION_CHARS);
  const cutAt = keep > 0 ? lines[keep].at : undefined;
  if (keep > 0) lines = lines.slice(0, keep);
  info.transcript = {
    language: trackName(track),
    auto: track.kind === "asr",
    lines,
    ...(cutAt !== undefined ? { cutAt } : {}),
  };
  return info;
}

/** 0:42, 12:05, 1:02:09. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Caption lines joined into paragraphs of about `span` seconds, each opening with its time. */
export function transcriptText(lines: CaptionLine[], span = 30): string {
  const out: string[] = [];
  let start = -Infinity;
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) out.push(`[${clock(start)}] ${cur.join(" ")}`);
    cur = [];
  };
  for (const l of lines) {
    if (l.at - start >= span) {
      flush();
      start = l.at;
    }
    cur.push(l.text);
  }
  flush();
  return out.join("\n");
}

const count = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${Math.round(n / 1e3)}K`
        : String(n);

/**
 * The video as a model reads it: what it is, then its description and timed transcript, cut to
 * `cap` characters. Callers wrap it as untrusted content.
 */
export function videoText(v: VideoInfo, cap = 100_000): string {
  const facts = [
    v.seconds ? clock(v.seconds) : v.live ? "live" : "",
    v.published ? `published ${v.published}` : "",
    v.views !== undefined ? `${count(v.views)} views` : "",
  ].filter(Boolean);
  const head = `YouTube video: "${v.title}"${v.channel ? ` by ${v.channel}` : ""}${facts.length ? ` (${facts.join(", ")})` : ""}\n${watchUrl(v.id)}`;
  const desc = v.description.trim()
    ? `\n\nDescription:\n${v.description.trim().slice(0, 2500)}`
    : "";
  if (!v.transcript) {
    return `${head}${desc}\n\nNo transcript: ${v.note ?? "none was available"}.`;
  }
  const t = v.transcript;
  const label = `Transcript (${t.language}${t.auto ? ", generated from the audio, so names and terms may be misheard" : ""}; [m:ss] is the time in the video):`;
  let body = transcriptText(t.lines);
  const room = Math.max(2000, cap - head.length - desc.length - label.length - 200);
  let cut = t.cutAt;
  if (body.length > room) {
    body = body.slice(0, room);
    body = body.slice(0, body.lastIndexOf("\n") > 0 ? body.lastIndexOf("\n") : room);
    cut = Number.NaN;
  }
  const last = body.match(/\[([\d:]+)\][^\n]*$/)?.[1];
  const note =
    cut !== undefined
      ? `\n[The transcript is cut here${last ? `, at ${last}` : ""}${v.seconds ? ` of ${clock(v.seconds)}` : ""}. Say so if the answer may depend on the rest.]`
      : "";
  return `${head}${desc}\n\n${label}\n${body}${note}`;
}
