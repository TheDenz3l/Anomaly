"use node";

import { inflateRawSync } from "node:zlib";
import { v } from "convex/values";
import { extractText, getDocumentProxy } from "unpdf";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { errorMessage } from "./lib/util";

/**
 * Text from files attached to a chat, read once on the server and kept beside the upload so every
 * later turn can quote it: PDFs (unpdf), Word, Excel, PowerPoint, OpenDocument and EPUB (read from
 * their ZIP parts), HTML, RTF, notebooks, ZIP archives (their listing plus any text files inside)
 * and anything that decodes as text (code, CSV, JSON, Markdown, logs).
 */

/** Text kept per file; the turn decides how much of it fits in the model's context. */
const MAX_TEXT = 400_000;
/** A ZIP part inflating past this is skipped: no document needs it, and it bounds a zip bomb. */
const MAX_PART = 40 * 1024 * 1024;
/** Text files inside an archive larger than this are listed but not read. */
const MAX_ARCHIVE_FILE = 256 * 1024;

export type Extracted = {
  status: "ok" | "empty" | "unsupported" | "error";
  text?: string;
  pages?: number;
  note?: string;
};

// ── ZIP ────────────────────────────────────────────────────────────────────────

type ZipEntry = { name: string; size: number; read: () => Buffer | null };

/** The entries of a ZIP file (Office, OpenDocument, EPUB and plain archives), read lazily. */
function unzip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    out.push({
      name,
      size,
      read: () => {
        if (size > MAX_PART || local + 30 > buf.length) return null;
        if (buf.readUInt32LE(local) !== 0x04034b50) return null;
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + compressed);
        if (method === 0) return data;
        if (method !== 8) return null;
        try {
          return inflateRawSync(data, { maxOutputLength: MAX_PART });
        } catch {
          return null;
        }
      },
    });
  }
  return out;
}

function part(entries: ZipEntry[], name: string): string | null {
  const bytes = entries.find((e) => e.name === name)?.read();
  return bytes ? bytes.toString("utf8") : null;
}

const byNumber = (re: RegExp) => (a: ZipEntry, b: ZipEntry) =>
  Number(a.name.match(re)?.[1] ?? 0) - Number(b.name.match(re)?.[1] ?? 0);

// ── Markup ─────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

/** Tags out, entities decoded, runs of blank lines folded. */
function plain(markup: string): string {
  return decode(markup.replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlText(html: string): string {
  return plain(
    html
      .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<\/t[dh]>/gi, "\t")
  );
}

function docxText(entries: ZipEntry[]): string {
  const xml = part(entries, "word/document.xml");
  if (xml === null) throw new Error("word/document.xml missing");
  return plain(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
  );
}

function pptxText(entries: ZipEntry[]): { text: string; pages: number } {
  const re = /^ppt\/slides\/slide(\d+)\.xml$/;
  const slides = entries.filter((e) => re.test(e.name)).sort(byNumber(re));
  const text = slides
    .map((s, i) => {
      const xml = s.read()?.toString("utf8") ?? "";
      return `--- Slide ${i + 1} ---\n${plain(xml.replace(/<a:br\/>/g, "\n").replace(/<\/a:p>/g, "\n"))}`;
    })
    .join("\n\n");
  return { text, pages: slides.length };
}

/** Column index of a cell reference: "C7" → 2. */
function column(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return Math.max(0, n - 1);
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function xlsxText(entries: ZipEntry[]): { text: string; pages: number } {
  const shared = [
    ...(part(entries, "xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const workbook = part(entries, "xl/workbook.xml") ?? "";
  const rels = part(entries, "xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [
      m[1],
      m[2].replace(/^\/?(xl\/)?/, "xl/"),
    ])
  );
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)].map(
    (m) => ({ name: decode(m[1]), path: targets.get(m[2]) })
  );
  const out: string[] = [];
  let size = 0;
  for (const sheet of sheets) {
    const xml = sheet.path ? part(entries, sheet.path) : null;
    if (!xml) continue;
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];
        const body = c[2] ?? "";
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const value =
          type === "s"
            ? (shared[Number(raw)] ?? "")
            : type === "inlineStr"
              ? decode([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""))
              : decode(raw ?? "");
        cells[ref ? column(ref) : cells.length] = value;
      }
      if (cells.some(Boolean)) rows.push(Array.from(cells, (x) => csvCell(x ?? "")).join(","));
      size += rows[rows.length - 1]?.length ?? 0;
      if (size > MAX_TEXT) break;
    }
    out.push(`--- Sheet: ${sheet.name} (${rows.length} rows) ---\n${rows.join("\n")}`);
    if (size > MAX_TEXT) break;
  }
  return { text: out.join("\n\n"), pages: sheets.length };
}

function odfText(entries: ZipEntry[]): string {
  const xml = part(entries, "content.xml");
  if (xml === null) throw new Error("content.xml missing");
  return plain(
    xml
      .replace(/<text:tab\/>/g, "\t")
      .replace(/<text:line-break\/>/g, "\n")
      .replace(/<\/table:table-cell>/g, "\t")
      .replace(/<\/(text:p|text:h|table:table-row)>/g, "\n")
  );
}

function epubText(entries: ZipEntry[]): string {
  return entries
    .filter((e) => /\.x?html?$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((e) => htmlText(e.read()?.toString("utf8") ?? ""))
    .filter(Boolean)
    .join("\n\n");
}

/** RTF groups that hold settings, not text (font and colour tables, metadata, pictures). */
const RTF_SKIP = new Set([
  "fonttbl",
  "colortbl",
  "expandedcolortbl",
  "stylesheet",
  "info",
  "pict",
  "header",
  "headerl",
  "headerr",
  "footer",
  "footerl",
  "footerr",
  "listtable",
  "listoverridetable",
  "generator",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "xmlnstbl",
  "rsidtbl",
  "object",
]);
const RTF_CHARS: Record<string, string> = {
  emdash: "—",
  endash: "–",
  bullet: "•",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
};

/** Index just past the group that opens at s[i]. */
function skipGroup(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return s.length;
}

function rtfText(s: string): string {
  const word = /\\([a-z]+)(-?\d+)? ?/iy;
  let out = "";
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "{") {
      word.lastIndex = i + 1;
      const w = word.exec(s)?.[1];
      if (s.startsWith("\\*", i + 1) || (w && RTF_SKIP.has(w))) i = skipGroup(s, i);
      else i++;
      continue;
    }
    if (c === "}" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const n = s[i + 1];
    if (n === "\\" || n === "{" || n === "}") {
      out += n;
      i += 2;
    } else if (n === "\n" || n === "\r") {
      out += "\n";
      i += 2;
    } else if (n === "'") {
      out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16) || 32);
      i += 4;
    } else if (n === "~") {
      out += " ";
      i += 2;
    } else {
      word.lastIndex = i;
      const m = word.exec(s);
      if (!m) {
        i += 2;
        continue;
      }
      i += m[0].length;
      const [, w, num] = m;
      if (w === "par" || w === "line" || w === "row" || w === "page" || w === "sect") out += "\n";
      else if (w === "tab" || w === "cell") out += "\t";
      else if (RTF_CHARS[w]) out += RTF_CHARS[w];
      else if (w === "u" && num) {
        const code = Number(num);
        out += String.fromCharCode(code < 0 ? code + 65536 : code);
        // The plain-text stand-in that follows a \u character is skipped.
        if (s[i] === "\\" && s[i + 1] === "'") i += 4;
        else if (s[i] && !"\\{}".includes(s[i])) i++;
      }
    }
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function notebookText(json: string): string {
  const nb = JSON.parse(json) as { cells?: { cell_type?: string; source?: string | string[] }[] };
  return (nb.cells ?? [])
    .map((c) => {
      const src = Array.isArray(c.source) ? c.source.join("") : (c.source ?? "");
      return c.cell_type === "code" ? `\`\`\`\n${src}\n\`\`\`` : src;
    })
    .join("\n\n");
}

// ── Plain text ─────────────────────────────────────────────────────────────────

/** The bytes as text when they are text (UTF-8, or Latin-1 that reads as text); null for binary. */
function asText(bytes: Buffer): string | null {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    const latin = bytes.toString("latin1");
    const sample = latin.slice(0, 8192);
    const printable = sample.replace(/[^\t\n\r\x20-\x7e\xa0-\xff]/g, "").length;
    return printable / Math.max(1, sample.length) > 0.95 ? latin : null;
  }
}

function archiveText(entries: ZipEntry[]): string {
  const files = entries.filter(
    (e) => !e.name.endsWith("/") && !/(^|\/)(__MACOSX|\.git|node_modules)\//.test(e.name)
  );
  const listing = files
    .slice(0, 300)
    .map((e) => `- ${e.name} (${humanSize(e.size)})`)
    .join("\n");
  const more = files.length > 300 ? `\n- …and ${files.length - 300} more` : "";
  const bodies: string[] = [];
  let size = listing.length;
  for (const e of files) {
    if (e.size > MAX_ARCHIVE_FILE || size > MAX_TEXT) continue;
    const bytes = e.read();
    const text = bytes ? asText(bytes) : null;
    if (!text?.trim()) continue;
    bodies.push(`=== ${e.name} ===\n${text}`);
    size += text.length;
  }
  return `Archive with ${files.length} files:\n${listing}${more}${bodies.length ? `\n\n${bodies.join("\n\n")}` : ""}`;
}

// ── Dispatch ───────────────────────────────────────────────────────────────────

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

export async function extractFile(bytes: Buffer, name: string, mime: string): Promise<Extracted> {
  const e = ext(name);
  const m = mime.toLowerCase();
  const done = (
    text: string,
    pages?: number,
    empty = "The file has no readable text."
  ): Extracted =>
    text.trim()
      ? { status: "ok", text: text.slice(0, MAX_TEXT), pages }
      : { status: "empty", pages, note: empty };

  if (m === "application/pdf" || e === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const body = text
      .map((t, i) => (t.trim() ? `--- Page ${i + 1} ---\n${t.trim()}` : ""))
      .filter(Boolean)
      .join("\n\n");
    return done(body, totalPages, "No selectable text: it may be a scan or made of images.");
  }
  if (e === "docx" || m.includes("wordprocessingml")) return done(docxText(unzip(bytes)));
  if (e === "pptx" || m.includes("presentationml")) {
    const r = pptxText(unzip(bytes));
    return done(r.text, r.pages);
  }
  if (e === "xlsx" || m.includes("spreadsheetml")) {
    const r = xlsxText(unzip(bytes));
    return done(r.text, r.pages);
  }
  if (["odt", "ods", "odp"].includes(e) || m.includes("opendocument"))
    return done(odfText(unzip(bytes)));
  if (e === "epub" || m === "application/epub+zip") return done(epubText(unzip(bytes)));
  if (e === "zip" || m === "application/zip" || m === "application/x-zip-compressed")
    return done(archiveText(unzip(bytes)));
  if (["doc", "xls", "ppt", "pages", "numbers", "key"].includes(e))
    return {
      status: "unsupported",
      note: `.${e} files can't be read here. Save it as ${e === "xls" || e === "numbers" ? ".xlsx or .csv" : e === "ppt" || e === "key" ? ".pptx or PDF" : ".docx or PDF"} and attach it again.`,
    };
  if (m.startsWith("image/"))
    return {
      status: "unsupported",
      note: "This image is too large to show the model. Attach it as a photo instead.",
    };
  if (m.startsWith("audio/") || m.startsWith("video/"))
    return { status: "unsupported", note: "Audio and video files can't be read here yet." };

  const text = asText(bytes);
  if (text === null) return { status: "unsupported", note: "This file type can't be read here." };
  if (e === "ipynb") {
    try {
      return done(notebookText(text));
    } catch {
      return done(text);
    }
  }
  if (["html", "htm", "xhtml"].includes(e) || m === "text/html") return done(htmlText(text));
  if (e === "rtf" || m.includes("rtf")) return done(rtfText(text));
  return done(text);
}

/** Reads one attachment's text and stores it next to the upload. Safe to run twice. */
export const extract = internalAction({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }): Promise<void> => {
    const row = await ctx.runQuery(internal.attachments.byStorage, { storageId });
    if (!row || row.kind !== "file" || (row.extract && row.extract !== "pending")) return;
    const blob = await ctx.storage.get(storageId);
    let out: Extracted;
    if (!blob) out = { status: "error", note: "The upload is gone." };
    else {
      try {
        out = await extractFile(
          Buffer.from(await blob.arrayBuffer()),
          row.name ?? "file",
          row.mime
        );
      } catch (e) {
        const msg = errorMessage(e);
        out = {
          status: "error",
          note: /password/i.test(msg)
            ? "The file is password-protected."
            : `The file couldn't be read (${msg.slice(0, 120)}).`,
        };
      }
    }
    const textStorageId = out.text
      ? await ctx.storage.store(new Blob([out.text], { type: "text/plain;charset=utf-8" }))
      : undefined;
    await ctx.runMutation(internal.attachments.setExtract, {
      storageId,
      extract: out.status,
      textStorageId,
      textChars: out.text?.length,
      pages: out.pages,
      note: out.note,
    });
  },
});
