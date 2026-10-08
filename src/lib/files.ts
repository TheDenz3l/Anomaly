import type { IconName } from "@/components/ui/Icon";

/** Largest file the server accepts (convex/attachments.ts). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Attachments per message, photos and files together (convex/messages.ts). */
export const MAX_ATTACHMENTS = 6;

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const extOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";

/** "PDF", "DOCX", "CSV": the word people use for the file's type. */
export function typeLabel(name: string, mime = ""): string {
  const ext = extOf(name);
  if (ext) return ext.toUpperCase();
  const sub = mime.split("/")[1]?.split(/[;+]/)[0];
  return sub && sub !== "octet-stream" ? sub.toUpperCase() : "File";
}

const CODE = new Set(
  "js jsx ts tsx py rb go rs java kt swift c h cpp hpp cs php sh zsh sql json yaml yml toml xml html css scss ipynb".split(
    " "
  )
);

export function fileIcon(name: string, mime = ""): IconName {
  const ext = extOf(name);
  if (ext === "pdf" || ["doc", "docx", "odt", "rtf", "txt", "md", "pages"].includes(ext))
    return "document-text-outline";
  if (["xls", "xlsx", "ods", "csv", "tsv", "numbers"].includes(ext)) return "grid-outline";
  if (["ppt", "pptx", "odp", "key"].includes(ext)) return "easel-outline";
  if (["zip", "rar", "7z", "tar", "gz", "tgz"].includes(ext)) return "archive-outline";
  if (CODE.has(ext)) return "code-slash-outline";
  if (mime.startsWith("audio/")) return "musical-notes-outline";
  if (mime.startsWith("video/")) return "film-outline";
  if (mime.startsWith("image/")) return "image-outline";
  return "document-outline";
}
