import type { ShareIntent } from "expo-share-intent";
import type { IconName } from "@/components/ui/Icon";
import type { Attachment } from "@/lib/store";

/** Largest file the server accepts (convex/attachments.ts). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Attachments per message, photos and files together (convex/messages.ts). */
export const MAX_ATTACHMENTS = 6;
/** Largest photo the server shows the model as an image; bigger ones go in as files. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
/** Image types the server takes as photos (convex/attachments.ts). */
const PHOTO = /^image\/(png|jpe?g|webp|gif|heic|heif)$/;

/** A file from Files or the share sheet. A photo among them still goes in as one the model sees. */
export function fileAttachment(f: {
  uri: string;
  name?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
}): Attachment {
  const photo = PHOTO.test(f.mime ?? "") && (f.size === undefined || f.size <= MAX_PHOTO_BYTES);
  return photo
    ? { uri: f.uri, mime: f.mime, width: f.width, height: f.height }
    : { uri: f.uri, kind: "file", name: f.name, mime: f.mime, size: f.size };
}

/**
 * What another app shared, as the composer takes it: its photos and files as attachments and any
 * text or link as the message. `note` says what was left out and why.
 */
export function sharedContent(intent: Pick<ShareIntent, "files" | "text" | "webUrl">): {
  text: string;
  attachments: Attachment[];
  note?: string;
} {
  const files = (intent.files ?? []).filter((f) => f.path);
  const tooBig = files.filter((f) => (f.size ?? 0) > MAX_FILE_BYTES);
  const fitting = files
    .filter((f) => (f.size ?? 0) <= MAX_FILE_BYTES)
    .map((f) =>
      fileAttachment({
        uri: f.path,
        name: f.fileName || undefined,
        mime: f.mimeType || undefined,
        size: f.size ?? undefined,
        width: f.width ?? undefined,
        height: f.height ?? undefined,
      })
    );
  const attachments = fitting.slice(0, MAX_ATTACHMENTS);
  const extra = fitting.length - attachments.length;
  let note: string | undefined;
  if (tooBig.length === 1)
    note = `${tooBig[0].fileName || "A file"} is over 25 MB, so it was left out.`;
  else if (tooBig.length > 1)
    note = `${tooBig.length} files are over 25 MB, so they were left out.`;
  else if (extra > 0) {
    note = `Up to ${MAX_ATTACHMENTS} attachments per message, so ${extra} ${extra === 1 ? "was" : "were"} left out.`;
  }
  const text = (intent.text ?? intent.webUrl ?? "").trim();
  return { text, attachments, note };
}

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
