import { router } from "expo-router";

/** Back to the previous screen, or to Chat when a page was opened directly (web deep link). */
export function goBack(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}
