/**
 * Files written in a reply. A fenced block whose info string names a file (```markdown PRD.md)
 * is a document the user can copy and download; any other fence is code they can copy and save
 * too. Pure, so the chat, the Artifacts gallery and tests share one reading of a reply.
 */

export type FenceInfo = { lang: string; name?: string };

export type Fence = {
  info: string;
  body: string;
  /** False while a streaming reply hasn't written the closing fence yet. */
  closed: boolean;
  /** Index of the line after the fence. */
  next: number;
};

export type DocFile = { name: string; ext: string; mime: string; lang: string; named: boolean };

const OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([^`]*?)\s*$/;
const CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

const LANG_EXT: Record<string, string> = {
  markdown: "md",
  md: "md",
  mdx: "mdx",
  text: "txt",
  txt: "txt",
  plain: "txt",
  plaintext: "txt",
  json: "json",
  jsonc: "json",
  csv: "csv",
  tsv: "tsv",
  html: "html",
  xml: "xml",
  svg: "svg",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  env: "env",
  javascript: "js",
  js: "js",
  jsx: "jsx",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  python: "py",
  py: "py",
  ruby: "rb",
  rb: "rb",
  go: "go",
  rust: "rs",
  rs: "rs",
  java: "java",
  kotlin: "kt",
  kt: "kt",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  csharp: "cs",
  cs: "cs",
  "c#": "cs",
  php: "php",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  zsh: "sh",
  console: "sh",
  powershell: "ps1",
  sql: "sql",
  css: "css",
  scss: "scss",
  lua: "lua",
  r: "r",
  latex: "tex",
  tex: "tex",
  graphql: "graphql",
  diff: "diff",
  patch: "diff",
  mermaid: "mmd",
  ics: "ics",
  vcard: "vcf",
};

const MIME: Record<string, string> = {
  md: "text/markdown",
  mdx: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  xml: "application/xml",
  svg: "image/svg+xml",
  yaml: "application/yaml",
  js: "text/javascript",
  css: "text/css",
  ics: "text/calendar",
  vcf: "text/vcard",
};

const FILE_NAME = /^[\w\u00C0-\uFFFF][\w\u00C0-\uFFFF .()+@-]*\.[A-Za-z0-9]{1,8}$/;

/** A file name the model wrote, or undefined when it isn't one: no paths, no odd characters. */
function cleanName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const base = raw
    .replace(/^["'`]|["'`]$/g, "")
    .split(/[\\/]/)
    .pop()!
    .trim();
  return FILE_NAME.test(base) && base.length <= 120 ? base : undefined;
}

/** `markdown PRD.md`, `md title="PRD.md"`, `json file=data.json`, `PRD.md`, `markdown:PRD.md`. */
export function parseFenceInfo(info: string): FenceInfo {
  const text = info.trim();
  if (!text) return { lang: "" };
  const attr = /\b(?:file(?:name)?|name|title|path)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/i.exec(text);
  const [first = "", ...rest] = text
    .replace(attr?.[0] ?? "", "")
    .trim()
    .split(/\s+/);
  const colon = /^([\w#+-]+):(.+)$/.exec(first);
  let lang = (colon ? colon[1] : first).toLowerCase();
  let name = cleanName(attr?.[1]) ?? cleanName(colon?.[2]) ?? cleanName(rest.join(" "));
  if (!name && !colon && cleanName(first) && !(lang in LANG_EXT)) {
    name = cleanName(first);
    lang = "";
  }
  return { lang, name };
}

const extOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";

const PROSE = new Set(["md", "mdx", "txt"]);

/** "PRD — Wayfarer" → "PRD-Wayfarer". */
function slug(title: string): string {
  return title
    .replace(/[*_`[\]#]/g, "")
    .replace(/[^\w\u00C0-\u1FFF\u3040-\uFFEF]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** The file a fence makes: its name, extension and type, named after its heading when unnamed. */
export function fileFor(info: FenceInfo, body: string): DocFile {
  if (info.name) {
    const ext = extOf(info.name);
    return {
      name: info.name,
      ext,
      mime: MIME[ext] ?? "text/plain",
      lang: info.lang || ext,
      named: true,
    };
  }
  const ext = LANG_EXT[info.lang] ?? "txt";
  const heading = PROSE.has(ext) ? /^\s*#{1,3}\s+(.+)$/m.exec(body)?.[1] : undefined;
  const stem = (heading && slug(heading)) || (PROSE.has(ext) ? "document" : "snippet");
  return {
    name: `${stem}.${ext}`,
    ext,
    mime: MIME[ext] ?? "text/plain",
    lang: info.lang,
    named: false,
  };
}

/**
 * A long prose fence with no name still reads as a document (the model wrote a whole PRD in a
 * ```markdown block): it gets the file card too.
 */
export function isDocument(file: DocFile, body: string): boolean {
  return file.named || (PROSE.has(file.ext) && body.split("\n").length >= 12);
}

const isMarkdown = (info: FenceInfo) =>
  ["markdown", "md", "mdx"].includes(info.lang) || /\.mdx?$/i.test(info.name ?? "");

/**
 * The fence opening at `lines[i]`, or null. It closes on a bare fence of the same character at
 * least as long. A Markdown document often holds code blocks of its own: models usually open those
 * with a language tag and the same three backticks, so inside a Markdown fence a tagged opener
 * nests and its bare closer belongs to it, not to the document.
 */
export function readFence(lines: string[], i: number): Fence | null {
  const open = OPEN.exec(lines[i]);
  if (!open) return null;
  const mark = open[1];
  const info = open[2];
  const md = isMarkdown(parseFenceInfo(info));
  const body: string[] = [];
  let depth = 0;
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    const close = CLOSE.exec(line);
    if (close && close[1][0] === mark[0] && close[1].length >= mark.length) {
      if (depth === 0) return { info, body: body.join("\n"), closed: true, next: j + 1 };
      depth--;
    } else if (md) {
      const inner = OPEN.exec(line);
      if (inner && inner[2] && inner[1][0] === mark[0] && inner[1].length === mark.length) depth++;
    }
    body.push(line);
  }
  return { info, body: body.join("\n"), closed: false, next: lines.length };
}

export type ReplyFile = DocFile & { body: string };

/** The documents a finished reply wrote, in order. */
export function documentsIn(text: string): ReplyFile[] {
  const out: ReplyFile[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const fence = readFence(lines, i);
    if (!fence) continue;
    i = fence.next - 1;
    if (!fence.closed) continue;
    const file = fileFor(parseFenceInfo(fence.info), fence.body);
    if (isDocument(file, fence.body)) out.push({ ...file, body: fence.body });
  }
  return out;
}
