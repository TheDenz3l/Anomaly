import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { useShareIntentContext } from "expo-share-intent";
import { useEffect, useRef } from "react";
import { sharedContent } from "@/lib/files";
import { useApp, type Attachment } from "@/lib/store";

/** Longest side a shared photo keeps; the picker's photos come out about this size too. */
const MAX_SIDE = 2560;
/** Above this a shared photo is re-encoded, so it stays under the server's photo limit. */
const REENCODE_BYTES = 4 * 1024 * 1024;

/**
 * Photos from the Photos app often arrive as HEIC, which most models can't read, and at full
 * camera size. Those become a JPEG the size the photo picker would have made.
 */
async function readyPhoto(a: Attachment): Promise<Attachment> {
  if (a.kind === "file") return a;
  const heic = /^image\/hei[cf]$/.test(a.mime ?? "");
  const big = (a.size ?? 0) > REENCODE_BYTES;
  const long = Math.max(a.width ?? 0, a.height ?? 0) > MAX_SIDE;
  if (!heic && !big && !long) return a;
  const ctx = ImageManipulator.manipulate(a.uri);
  try {
    if (long) {
      ctx.resize((a.width ?? 0) >= (a.height ?? 0) ? { width: MAX_SIDE } : { height: MAX_SIDE });
    }
    const image = await ctx.renderAsync();
    try {
      const out = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
      return { uri: out.uri, width: out.width, height: out.height, mime: "image/jpeg" };
    } finally {
      image.release();
    }
  } catch {
    // The server still takes the original; the model may or may not read it.
    return a;
  } finally {
    ctx.release();
  }
}

/**
 * Takes what another app sent through the iOS share sheet (or an Android share) and opens a new
 * chat with it in the composer. expo-share-intent's extension saves the items to the app group
 * and opens anomaly://dataUrl=…; +native-intent.tsx routes that to the chat.
 */
export function ShareReceiver() {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntentContext();
  const shareToComposer = useApp((s) => s.shareToComposer);
  const showToast = useApp((s) => s.showToast);
  const handled = useRef<unknown>(null);

  useEffect(() => {
    if (!hasShareIntent || handled.current === shareIntent) return;
    handled.current = shareIntent;
    const { text, attachments, note } = sharedContent(shareIntent);
    resetShareIntent();
    if (note) showToast(note, "danger");
    if (!text && !attachments.length) return;
    void Promise.all(attachments.map(readyPhoto)).then((ready) => shareToComposer(text, ready));
  }, [hasShareIntent, shareIntent, resetShareIntent, shareToComposer, showToast]);

  useEffect(() => {
    if (error) showToast("Anomaly couldn’t open what was shared. Try sharing it again.", "danger");
  }, [error, showToast]);

  return null;
}
