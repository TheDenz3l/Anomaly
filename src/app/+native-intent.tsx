/**
 * The share extension opens the app at anomaly://dataUrl=anomalyShareKey…, which is no screen.
 * It lands on the chat, where ShareReceiver reads what was shared.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return path.includes("dataUrl=") ? "/" : path;
  } catch {
    return "/";
  }
}
