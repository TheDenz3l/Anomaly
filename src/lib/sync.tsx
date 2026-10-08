import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
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
  const failures = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Sign-in keeps trying with growing pauses (2 s up to a minute), and at once when the app
  // comes back to the foreground, so a launch without network doesn't leave the app signed out.
  useEffect(() => {
    if (isLoading || isAuthenticated || signingIn.current) return;
    signingIn.current = true;
    signIn("anonymous")
      .then(() => {
        failures.current = 0;
      })
      .catch(() => {
        failures.current++;
        if (failures.current === 1)
          useApp
            .getState()
            .showToast("Couldn't sign in. Check your connection; the app keeps trying.", "danger");
        const delay = Math.min(60_000, 2_000 * 2 ** (failures.current - 1));
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => setAttempt((n) => n + 1), delay);
      })
      .finally(() => {
        signingIn.current = false;
      });
  }, [isLoading, isAuthenticated, signIn, attempt]);

  const signedIn = useRef(isAuthenticated);
  useEffect(() => {
    signedIn.current = isAuthenticated;
  }, [isAuthenticated]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || signedIn.current) return;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      setAttempt((n) => n + 1);
    });
    return () => {
      sub.remove();
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  // Incognito chats never outlive the session: whatever an earlier one left on the server goes as
  // soon as the app is signed in again (all but the chat still open). Retried until it goes through.
  const discardIncognito = useMutation(api.threads.discardIncognito);
  const discarded = useRef(false);
  const discarding = useRef(false);
  const [discardAttempt, setDiscardAttempt] = useState(0);
  useEffect(() => {
    if (!isAuthenticated || discarded.current || discarding.current) return;
    discarding.current = true;
    const s = useApp.getState();
    const open = s.activeThreadId ? s.threads[s.activeThreadId] : undefined;
    const keep =
      open?.incognito && !open.id.startsWith("pending_") ? (open.id as Id<"threads">) : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    discardIncognito({ keep })
      .then(() => {
        discarded.current = true;
      })
      .catch(() => {
        timer = setTimeout(() => setDiscardAttempt((n) => n + 1), 10_000);
      })
      .finally(() => {
        discarding.current = false;
      });
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [isAuthenticated, discardIncognito, discardAttempt]);

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
