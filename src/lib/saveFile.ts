import * as Clipboard from "expo-clipboard";
import { Directory, File, Paths } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Platform, Share } from "react-native";
import { useApp } from "@/lib/store";

/**
 * Downloading text the app wrote as a real file. Web downloads it; iOS writes it to the cache and
 * opens the share sheet, where Save to Files, AirDrop and other apps take it; Android asks for a
 * folder and writes it there.
 */
export type SaveResult = "downloaded" | "shared" | "cancelled";

function webDownload(name: string, text: string, mime: string): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) throw new Error("No document to download into");
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A fresh copy in the cache, under its own name so the share sheet and Files show that name. */
function cacheCopy(name: string, text: string): File {
  const dir = new Directory(Paths.cache, "exports");
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  return file;
}

export async function saveTextFile(name: string, text: string, mime: string): Promise<SaveResult> {
  if (Platform.OS === "web") {
    webDownload(name, text, mime);
    return "downloaded";
  }
  if (Platform.OS === "android") {
    let dir: Directory;
    try {
      dir = await Directory.pickDirectoryAsync();
    } catch {
      return "cancelled";
    }
    dir.createFile(name, mime).write(text);
    return "downloaded";
  }
  const file = cacheCopy(name, text);
  const result = await Share.share({ url: file.uri, title: name });
  return result.action === Share.dismissedAction ? "cancelled" : "shared";
}

/** Copy and download for one file, with a toast for how it went and a tick after copying. */
export function useFileActions(file: { name: string; mime: string }, text: string) {
  const toast = useApp((s) => s.showToast);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    await Clipboard.setStringAsync(text);
    if (Platform.OS === "ios")
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    toast("Copied");
    setTimeout(() => setCopied(false), 1500);
  };

  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await saveTextFile(file.name, text, file.mime);
      if (result === "downloaded") toast(`Downloaded ${file.name}`);
    } catch {
      toast(`${file.name} couldn’t be downloaded. Try again, or copy it instead.`, "danger");
    } finally {
      setBusy(false);
    }
  };

  return { copy, download, copied, busy };
}
