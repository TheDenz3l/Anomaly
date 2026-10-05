import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { api, type Id } from "@/lib/convex";
import { useApp } from "@/lib/store";
import type { Memory, Message, Model, Provider, Settings, Thread } from "@/lib/types";

/**
 * Mirrors Convex subscriptions into the zustand store and signs the device in anonymously on
 * first launch. Mounted once in the root layout; renders nothing.
 */
export function ConvexSync() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn } = useAuthActions();
  const signingIn = useRef(false);

  useEffect(() => {
    if (isLoading || isAuthenticated || signingIn.current) return;
    signingIn.current = true;
    signIn("anonymous")
      .catch((e) => useApp.getState().showToast(`Couldn't sign in: ${String(e)}`, "danger"))
      .finally(() => {
        signingIn.current = false;
      });
  }, [isLoading, isAuthenticated, signIn]);

  const on = isAuthenticated ? {} : "skip";
  const threads = useQuery(api.threads.list, on);
  const settings = useQuery(api.settings.get, on);
  const providers = useQuery(api.providers.list, on);
  const models = useQuery(api.models.list, on);
  const memories = useQuery(api.memories.list, on);
  const saved = useQuery(api.messages.saved, on);
  const artifacts = useQuery(api.messages.artifacts, on);

  const active = useApp((s) => s.activeThreadId);
  const threadId =
    isAuthenticated && active && !active.startsWith("pending_") ? (active as Id<"threads">) : null;
  const messages = useQuery(api.messages.list, threadId ? { threadId } : "skip");

  const store = useApp.getState;
  useEffect(() => {
    if (threads) store().hydrateThreads(threads as unknown as Thread[]);
  }, [threads, store]);
  useEffect(() => {
    if (settings) store().hydrate({ settings: settings as unknown as Settings });
  }, [settings, store]);
  useEffect(() => {
    if (providers) store().hydrate({ providers: providers as unknown as Provider[] });
  }, [providers, store]);
  useEffect(() => {
    if (models) store().hydrate({ models: models as unknown as Model[] });
  }, [models, store]);
  useEffect(() => {
    if (memories) store().hydrate({ memories: memories as unknown as Memory[] });
  }, [memories, store]);
  useEffect(() => {
    if (saved)
      store().hydrate({ savedMessageIds: saved.messages, pinnedArtifacts: saved.artifacts });
  }, [saved, store]);
  useEffect(() => {
    if (artifacts) store().hydrateArtifacts(artifacts as unknown as Message[]);
  }, [artifacts, store]);
  useEffect(() => {
    if (threadId && messages) store().hydrateMessages(threadId, messages as unknown as Message[]);
  }, [threadId, messages, store]);

  return null;
}
