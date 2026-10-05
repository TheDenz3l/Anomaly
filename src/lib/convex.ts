import { ConvexReactClient } from "convex/react";

export { api } from "../../convex/_generated/api";
export type { Id } from "../../convex/_generated/dataModel";

const url = process.env.EXPO_PUBLIC_CONVEX_URL;
if (!url) {
  throw new Error(
    "EXPO_PUBLIC_CONVEX_URL is missing. Run `npm run convex` once to write .env.local."
  );
}

/** One client for the whole app; the zustand store calls mutations through it. */
export const convex = new ConvexReactClient(url, { unsavedChangesWarning: false });

/** Readable message from a ConvexError (string data) or any thrown value. */
export function errorText(e: unknown): string {
  const data = (e as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/Uncaught (?:ConvexError|Error): ([^\n]+)/);
  return (m?.[1] ?? msg).replace(/\s+at .*$/s, "").slice(0, 200);
}
