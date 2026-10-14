import { File, Paths } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { requestPermissionsAsync, saveToLibraryAsync } from "expo-media-library/legacy";
import { useState } from "react";
import { Platform, Share } from "react-native";
import { useApp } from "@/lib/store";

/** Saving and sharing a generated image: both work from a local copy kept in the cache. */

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}

async function localCopy(url: string, mime?: string): Promise<string> {
  const name = `image-${hashOf(url)}.${EXTENSIONS[mime ?? ""] ?? "png"}`;
  const file = new File(Paths.cache, name);
  if (file.exists) return file.uri;
  return (await File.downloadFileAsync(url, file)).uri;
}

/** Puts the image in the photo library, asking for add-only access the first time. */
export async function saveImage(url: string, mime?: string): Promise<"saved" | "denied"> {
  if (Platform.OS === "web") {
    (globalThis as { open?: (url: string) => void }).open?.(url);
    return "saved";
  }
  const permission = await requestPermissionsAsync(true);
  if (!permission.granted) return "denied";
  await saveToLibraryAsync(await localCopy(url, mime));
  return "saved";
}

/** The system share sheet with the image itself, not a link to it. */
export async function shareImage(url: string, mime?: string, title?: string): Promise<void> {
  if (Platform.OS !== "ios") {
    await Share.share({ message: url, title });
    return;
  }
  await Share.share({ url: await localCopy(url, mime) });
}

/** Save and share for one image, with a toast for how it went and a tick when it's saved. */
export function useImageActions(url: string | undefined, mime?: string, title?: string) {
  const toast = useApp((s) => s.showToast);
  const [busy, setBusy] = useState<"save" | "share" | null>(null);

  const save = async () => {
    if (!url || busy) return;
    setBusy("save");
    try {
      if ((await saveImage(url, mime)) === "saved") {
        if (Platform.OS === "ios")
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast("Saved to Photos");
      } else {
        toast("Allow Anomaly to add to Photos in Settings to save images.", "danger");
      }
    } catch {
      toast("The image couldn’t be saved. Try again.", "danger");
    } finally {
      setBusy(null);
    }
  };

  const share = async () => {
    if (!url || busy) return;
    setBusy("share");
    try {
      await shareImage(url, mime, title);
    } catch {
      toast("The image couldn’t be shared. Try again.", "danger");
    } finally {
      setBusy(null);
    }
  };

  return { save, share, busy };
}
