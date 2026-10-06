import * as Location from "expo-location";
import { useMemo } from "react";
import { Platform } from "react-native";
import { create } from "zustand";
import { collectArtifacts } from "@/lib/artifacts";
import { api, convex, errorText, type Id } from "@/lib/convex";
import { withoutLinkMarkup } from "@/lib/links";
import { modelRef, placeholderModel } from "@/lib/models";
import type {
  CapabilityProfile,
  Memory,
  Message,
  Model,
  Part,
  Provider,
  Settings,
  Thread,
  UiEventPart,
} from "@/lib/types";

/**
 * App state. Server data (threads, messages, models, settings, memories) streams in from Convex
 * through <ConvexSync />; actions call Convex and show optimistic parts so the UI never waits.
 */

export type Attachment = { uri: string; width?: number; height?: number };

type Draft = { modelRef: string; reasoningLevel: string; incognito: boolean };

type Toast = { id: string; text: string; tone: "default" | "danger" };

export const DEFAULT_SETTINGS: Settings = {
  customInstructions: "",
  memoryEnabled: true,
  subagentMode: "auto",
  webMode: "auto",
  searchProvider: "searxng",
  searchKeyHint: "",
  voiceInput: "device",
  voiceOutput: "device",
  readRepliesAloud: false,
  probeSpendCapUsd: 0.05,
  defaultModelRef: "",
  researchModelRef: null,
};

type State = {
  /** Signed in and the first settings/threads have arrived. */
  ready: boolean;
  providers: Provider[];
  models: Model[];
  threads: Record<string, Thread>;
  messages: Record<string, Message[]>;
  activeThreadId: string | null;
  draft: Draft;
  settings: Settings;
  memories: Memory[];
  streaming: { threadId: string; messageId: string } | null;
  /** Deep Research toggle in the composer — applies to the next message only. */
  researchArmed: boolean;
  savedMessageIds: string[];
  /** Artifact ids pinned to the top of Artifacts. */
  pinnedArtifacts: string[];
  /** When each artifact was last opened, for "recently viewed" ordering. */
  artifactViews: Record<string, number>;
  toast: Toast | null;
};

export type ProviderResult = { ok: boolean; saved: boolean; error?: string };

export type ProviderInput = {
  providerId: string;
  label: string;
  baseUrl: string;
  headers: { key: string; value: string }[];
};

type Actions = {
  newChat(): void;
  openThread(id: string): void;
  deleteThread(id: string): void;
  renameThread(id: string, title: string): void;
  setModel(ref: string): void;
  setReasoningLevel(level: string): void;
  setResearchMode(on: boolean): void;
  setIncognito(on: boolean): void;
  send(text: string, attachments: Attachment[]): void;
  emitUiEvent(threadId: string, event: Omit<UiEventPart, "id" | "type">): void;
  stop(): void;
  regenerate(messageId: string): void;
  toggleSaved(messageId: string): void;
  togglePin(artifactId: string): void;
  markViewed(artifactId: string): void;
  updateSettings(patch: Partial<Settings>): void;
  addMemory(m: Omit<Memory, "id" | "createdAt">): void;
  updateMemory(id: string, patch: Partial<Memory>): void;
  deleteMemory(id: string): void;
  /** `saved` is true when the server stored the provider, even if it could not connect yet. */
  saveProvider(input: ProviderInput, apiKey?: string): Promise<ProviderResult>;
  refreshProvider(providerId: string): Promise<ProviderResult>;
  removeProvider(providerId: string): void;
  overrideProfile(ref: string, patch: Partial<CapabilityProfile>): void;
  runProbes(ref: string): Promise<string[]>;
  /** Checks an unverified model's reasoning controls once, in the background. */
  ensureProfile(ref: string): void;
  pinThread(id: string, pinned: boolean): void;
  showToast(text: string, tone?: Toast["tone"]): void;
  /* sync — called by <ConvexSync /> only */
  hydrate(
    patch: Partial<
      Pick<
        State,
        "providers" | "models" | "memories" | "settings" | "savedMessageIds" | "pinnedArtifacts"
      >
    >
  ): void;
  hydrateThreads(list: Thread[]): void;
  hydrateMessages(threadId: string, list: Message[]): void;
  hydrateArtifacts(list: Message[]): void;
};

export type AppStore = State & Actions;

export function findModel(models: Model[], ref: string): Model {
  return (
    models.find((m) => modelRef(m) === ref) ??
    (ref ? placeholderModel(ref) : (models[0] ?? placeholderModel("")))
  );
}

let seq = 0;
const tempId = (prefix: string) => `${prefix}_tmp${Date.now().toString(36)}${(seq++).toString(36)}`;
const isPending = (id: string | null) => Boolean(id?.startsWith("pending_"));

/** Same rule as the server's first title, so a new chat's header doesn't change when the real thread arrives. */
function titleFrom(text: string): string {
  const clean = withoutLinkMarkup(text)
    .replace(/^\/\w+\s*/, "")
    .replace(/[?!.]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "New chat";
  const words = clean.split(" ");
  const short = words.slice(0, 6).join(" ");
  return short.charAt(0).toUpperCase() + short.slice(1) + (words.length > 6 ? "…" : "");
}

const SETTINGS_KEYS = [
  "customInstructions",
  "memoryEnabled",
  "subagentMode",
  "webMode",
  "searchProvider",
  "voiceInput",
  "voiceOutput",
  "readRepliesAloud",
  "probeSpendCapUsd",
  "defaultModelRef",
  "researchModelRef",
] as const;

/** Threads whose full message list is loaded (vs. the artifact-only subset). */
const fullThreads = new Set<string>();

/** How long the socket may stay down before a call is reported as unreachable. */
const OFFLINE_GRACE_MS = 6_000;

/**
 * A call queued on a dead connection never settles by itself, which left buttons spinning forever.
 * Give up with a clear message instead: after `ms`, or sooner once the socket has been down for a
 * few seconds (the server may still finish it later, which is harmless here).
 */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const started = Date.now();
    let offlineSince: number | null = null;
    const timer = setInterval(() => {
      const now = Date.now();
      offlineSince = convex.connectionState().isWebSocketConnected ? null : (offlineSince ?? now);
      if (
        now - started >= ms ||
        (offlineSince !== null && now - offlineSince >= OFFLINE_GRACE_MS)
      ) {
        clearInterval(timer);
        reject(new Error("Can't reach the server. Check your connection and try again."));
      }
    }, 1000);
    p.then(
      (v) => {
        clearInterval(timer);
        resolve(v);
      },
      (err) => {
        clearInterval(timer);
        reject(err);
      }
    );
  });
}
/** Model refs already sent for a background capability check this session. */
const ensured = new Set<string>();
/** Server message id → the optimistic id it replaced, used as a stable React key. */
const aliases = new Map<string, string>();
const isTemp = (id: string) => id.includes("_tmp");

/**
 * Gives server messages the keys of the optimistic messages they replace (matched in order by role),
 * so a reply doesn't remount — and replay its entrance animation — when the real data arrives.
 */
function withStableKeys(prev: Message[], next: Message[]): Message[] {
  const prevIds = new Set(prev.map((m) => m.id));
  const temps = prev.filter((m) => isTemp(m.id));
  const fresh = next.filter((m) => !prevIds.has(m.id) && !aliases.has(m.id));
  for (const t of temps) {
    const match = fresh.find((f) => f.role === t.role && !aliases.has(f.id));
    if (match) aliases.set(match.id, t.key ?? t.id);
  }
  return next.map((m) => (aliases.has(m.id) ? { ...m, key: aliases.get(m.id) } : m));
}
let searchKeyTimer: ReturnType<typeof setTimeout> | null = null;

async function uploadImage(
  a: Attachment
): Promise<{ storageId: Id<"_storage">; width?: number; height?: number }> {
  const blob = await (await fetch(a.uri)).blob();
  const url = await convex.mutation(api.attachments.generateUploadUrl, {});
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": blob.type || "image/jpeg" },
    body: blob,
  });
  if (!res.ok) throw new Error("Photo upload failed.");
  const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
  await convex.mutation(api.attachments.register, { storageId, width: a.width, height: a.height });
  return { storageId, width: a.width, height: a.height };
}

async function currentLocation(): Promise<{ lat: number; lng: number; label?: string } | null> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== "granted") return null;
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const { latitude: lat, longitude: lng } = pos.coords;
  let label: string | undefined;
  if (Platform.OS !== "web") {
    try {
      const [place] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      label =
        [place?.city ?? place?.district, place?.region].filter(Boolean).join(", ") || undefined;
    } catch {
      label = undefined;
    }
  }
  return { lat, lng, label };
}

function streamingIn(threadId: string, list: Message[]): State["streaming"] {
  const m = [...list].reverse().find((x) => x.role === "assistant" && x.status === "streaming");
  return m ? { threadId, messageId: m.id } : null;
}

export const useApp = create<AppStore>()((set, get) => {
  const toastError = (e: unknown) => get().showToast(errorText(e), "danger");

  const patchMessages = (threadId: string, fn: (list: Message[]) => Message[]) =>
    set((s) => ({ messages: { ...s.messages, [threadId]: fn(s.messages[threadId] ?? []) } }));

  const patchThreadOrDraft = (patch: Partial<Draft>) => {
    const s = get();
    const id = s.activeThreadId;
    if (id && s.threads[id] && !isPending(id)) {
      set({ threads: { ...s.threads, [id]: { ...s.threads[id], ...patch } } });
      convex
        .mutation(api.threads.update, { threadId: id as Id<"threads">, ...patch })
        .catch(toastError);
    } else {
      set({ draft: { ...s.draft, ...patch } });
    }
  };

  return {
    ready: false,
    providers: [],
    models: [],
    threads: {},
    messages: {},
    activeThreadId: null,
    draft: { modelRef: "", reasoningLevel: "auto", incognito: false },
    settings: DEFAULT_SETTINGS,
    memories: [],
    streaming: null,
    researchArmed: false,
    savedMessageIds: [],
    pinnedArtifacts: [],
    artifactViews: {},
    toast: null,

    newChat() {
      const s = get();
      set({
        activeThreadId: null,
        streaming: null,
        draft: { modelRef: s.settings.defaultModelRef, reasoningLevel: "auto", incognito: false },
        researchArmed: false,
      });
    },

    openThread(id) {
      const list = get().messages[id] ?? [];
      set({ activeThreadId: id, streaming: streamingIn(id, list) });
    },

    deleteThread(id) {
      const s = get();
      const { [id]: _t, ...threads } = s.threads;
      const { [id]: _m, ...messages } = s.messages;
      set({
        threads,
        messages,
        activeThreadId: s.activeThreadId === id ? null : s.activeThreadId,
        streaming: s.streaming?.threadId === id ? null : s.streaming,
      });
      if (!isPending(id))
        convex.mutation(api.threads.remove, { threadId: id as Id<"threads"> }).catch(toastError);
    },

    pinThread(id, pinned) {
      const s = get();
      if (!s.threads[id] || isPending(id)) return;
      const pinnedAt = pinned ? Date.now() : undefined;
      set({ threads: { ...s.threads, [id]: { ...s.threads[id], pinnedAt } } });
      convex
        .mutation(api.threads.update, { threadId: id as Id<"threads">, pinned })
        .catch(toastError);
    },

    renameThread(id, title) {
      const s = get();
      if (!s.threads[id]) return;
      set({ threads: { ...s.threads, [id]: { ...s.threads[id], title } } });
      convex
        .mutation(api.threads.update, { threadId: id as Id<"threads">, title })
        .catch(toastError);
    },

    setModel(ref) {
      patchThreadOrDraft({ modelRef: ref });
    },

    setReasoningLevel(level) {
      patchThreadOrDraft({ reasoningLevel: level });
    },

    setResearchMode(on) {
      set({ researchArmed: on });
    },

    setIncognito(on) {
      patchThreadOrDraft({ incognito: on });
    },

    send(text, attachments) {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      const s = get();
      const research = s.researchArmed;
      const existing = s.activeThreadId && !isPending(s.activeThreadId) ? s.activeThreadId : null;
      const threadKey = existing ?? `pending_${Date.now().toString(36)}`;
      const now = Date.now();
      const parts: Part[] = [
        ...attachments.map((a): Part => ({
          id: tempId("img"),
          type: "image",
          uri: a.uri,
          width: a.width,
          height: a.height,
        })),
        ...(trimmed ? [{ id: tempId("txt"), type: "text", text: trimmed } as Part] : []),
      ];
      const userMsg: Message = {
        id: tempId("msg"),
        threadId: threadKey,
        role: "user",
        parts,
        createdAt: now,
        status: "done",
      };
      const replyId = tempId("msg");
      const target = existing ? s.threads[existing] : s.draft;
      const reply: Message = {
        id: replyId,
        threadId: threadKey,
        role: "assistant",
        parts: [],
        createdAt: now + 1,
        status: "streaming",
        // Mirrors the server's initial meta so the placeholder row doesn't change label on arrival.
        meta: {
          modelRef: target?.modelRef ?? "",
          levelRequested: target?.reasoningLevel ?? "auto",
          levelSent: "",
          reasoningTokens: 0,
        },
      };
      if (!existing) {
        const thread: Thread = {
          id: threadKey,
          key: threadKey,
          title: titleFrom(trimmed || "Photo"),
          mode: research ? "research" : "chat",
          ...s.draft,
          createdAt: now,
          updatedAt: now,
        };
        set({ threads: { ...s.threads, [threadKey]: thread }, activeThreadId: threadKey });
      }
      patchMessages(threadKey, (list) => [...list, userMsg, reply]);
      set({ streaming: { threadId: threadKey, messageId: replyId }, researchArmed: false });

      void (async () => {
        try {
          const uploaded = await Promise.all(attachments.map(uploadImage));
          const res = await convex.mutation(api.messages.send, {
            threadId: existing ? (existing as Id<"threads">) : undefined,
            text: trimmed,
            attachments: uploaded,
            research,
            draft: existing ? undefined : get().draft,
          });
          if (!existing) {
            const st = get();
            const { [threadKey]: pendingThread, ...threads } = st.threads;
            const { [threadKey]: pendingMsgs, ...messages } = st.messages;
            set({
              threads: { ...threads, [res.threadId]: { ...pendingThread, id: res.threadId } },
              messages: {
                ...messages,
                [res.threadId]:
                  messages[res.threadId] ??
                  (pendingMsgs ?? []).map((m) => ({ ...m, threadId: res.threadId })),
              },
              activeThreadId: st.activeThreadId === threadKey ? res.threadId : st.activeThreadId,
              streaming:
                st.streaming?.threadId === threadKey
                  ? { threadId: res.threadId, messageId: res.messageId }
                  : st.streaming,
            });
          }
        } catch (e) {
          patchMessages(threadKey, (list) => list.filter((m) => m.id !== replyId));
          if (get().streaming?.messageId === replyId) set({ streaming: null });
          toastError(e);
        }
      })();
    },

    emitUiEvent(threadId, event) {
      const tmp: Message = {
        id: tempId("msg"),
        threadId,
        role: "user",
        parts: [{ id: tempId("evt"), type: "ui_event", ...event }],
        createdAt: Date.now(),
        status: "done",
      };
      patchMessages(threadId, (list) => [...list, tmp]);
      void (async () => {
        try {
          let payload = event.payload;
          if (event.component === "LocationRequest" && event.action === "allow") {
            const loc = await currentLocation().catch(() => null);
            if (!loc) {
              patchMessages(threadId, (list) => list.filter((m) => m.id !== tmp.id));
              get().showToast("Location access is off. Pick the city option instead.", "danger");
              return;
            }
            payload = { ...(payload ?? {}), ...loc };
          }
          await convex.mutation(api.messages.emitUiEvent, {
            threadId: threadId as Id<"threads">,
            componentId: event.componentId,
            component: event.component,
            action: event.action,
            label: event.label,
            payload,
          });
        } catch (e) {
          patchMessages(threadId, (list) => list.filter((m) => m.id !== tmp.id));
          toastError(e);
        }
      })();
    },

    stop() {
      const s = get();
      const threadId = s.streaming?.threadId ?? s.activeThreadId;
      set({ streaming: null });
      if (threadId && !isPending(threadId)) {
        convex
          .mutation(api.messages.stop, { threadId: threadId as Id<"threads"> })
          .catch(toastError);
      }
    },

    regenerate(messageId) {
      const s = get();
      if (s.streaming) return;
      const threadId = Object.keys(s.messages).find((k) =>
        s.messages[k].some((m) => m.id === messageId)
      );
      if (!threadId) return;
      patchMessages(threadId, (list) =>
        list.map((m) =>
          m.id === messageId ? { ...m, parts: [], status: "streaming" as const } : m
        )
      );
      set({ streaming: { threadId, messageId } });
      convex
        .mutation(api.messages.regenerate, { messageId: messageId as Id<"messages"> })
        .catch((e) => {
          set({ streaming: null });
          toastError(e);
        });
    },

    toggleSaved(messageId) {
      const s = get();
      const saved = s.savedMessageIds.includes(messageId);
      set({
        savedMessageIds: saved
          ? s.savedMessageIds.filter((x) => x !== messageId)
          : [...s.savedMessageIds, messageId],
      });
      get().showToast(saved ? "Removed from saved" : "Saved");
      convex
        .mutation(api.messages.toggleSaved, { refId: messageId, kind: "message" })
        .catch(toastError);
    },

    togglePin(artifactId) {
      const s = get();
      const pinned = s.pinnedArtifacts.includes(artifactId);
      set({
        pinnedArtifacts: pinned
          ? s.pinnedArtifacts.filter((x) => x !== artifactId)
          : [artifactId, ...s.pinnedArtifacts],
      });
      get().showToast(pinned ? "Unpinned" : "Pinned to Artifacts");
      convex
        .mutation(api.messages.toggleSaved, { refId: artifactId, kind: "artifact" })
        .catch(toastError);
    },

    markViewed(artifactId) {
      set((s) => ({ artifactViews: { ...s.artifactViews, [artifactId]: Date.now() } }));
    },

    updateSettings(patch) {
      const s = get();
      set({ settings: { ...s.settings, ...patch } });
      const server: Record<string, unknown> = {};
      for (const k of SETTINGS_KEYS) if (k in patch) server[k] = patch[k];
      if (Object.keys(server).length) {
        convex.mutation(api.settings.update, server as never).catch(toastError);
      }
      if ("searchKeyHint" in patch) {
        if (searchKeyTimer) clearTimeout(searchKeyTimer);
        const value = (patch.searchKeyHint ?? "").trim();
        const provider = get().settings.searchProvider;
        searchKeyTimer = setTimeout(() => {
          if (provider === "none") return;
          convex
            .action(api.settings.setSearchKey, {
              provider,
              key: provider === "searxng" ? "" : value,
              url: provider === "searxng" ? value : undefined,
            })
            .catch(toastError);
        }, 900);
      }
    },

    addMemory(m) {
      convex
        .mutation(api.memories.create, {
          text: m.text,
          category: m.category,
          scope: m.scope,
          threadId: m.threadId as Id<"threads"> | undefined,
        })
        .catch(toastError);
    },

    updateMemory(id, patch) {
      set((s) => ({ memories: s.memories.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
      convex
        .mutation(api.memories.update, {
          id: id as Id<"memories">,
          text: patch.text,
          category: patch.category,
          scope: patch.scope,
        })
        .catch(toastError);
    },

    deleteMemory(id) {
      set((s) => ({ memories: s.memories.filter((m) => m.id !== id) }));
      convex.mutation(api.memories.remove, { id: id as Id<"memories"> }).catch(toastError);
    },

    async saveProvider(input, apiKey) {
      try {
        const res = await within(
          convex.action(api.providers.save, {
            providerId: input.providerId,
            label: input.label,
            baseUrl: input.baseUrl,
            apiKey: apiKey ? apiKey : undefined,
            headers: input.headers,
          }),
          45_000
        );
        // Failures are shown inline by the provider sheet, which sits above the toast layer.
        if (res.status !== "connected")
          return { ok: false, saved: true, error: res.error ?? "Couldn't list its models." };
        get().showToast(`Connected: ${res.models} models`);
        return { ok: true, saved: true };
      } catch (e) {
        return { ok: false, saved: false, error: errorText(e) };
      }
    },

    async refreshProvider(providerId) {
      try {
        const res = await within(convex.action(api.providers.refresh, { providerId }), 45_000);
        if (res.status === "connected") return { ok: true, saved: true };
        return { ok: false, saved: true, error: res.error ?? "Couldn't fetch models." };
      } catch (e) {
        return { ok: false, saved: true, error: errorText(e) };
      }
    },

    removeProvider(providerId) {
      set((s) => ({
        providers: s.providers.filter((p) => p.providerId !== providerId),
        models: s.models.filter((m) => m.providerId !== providerId),
      }));
      convex.mutation(api.providers.remove, { providerId }).catch(toastError);
    },

    overrideProfile(ref, patch) {
      convex
        .mutation(api.models.setOverride, {
          ref,
          reasoning: patch.reasoning,
          features: patch.features,
        })
        .catch(toastError);
    },

    ensureProfile(ref) {
      if (!ref || ensured.has(ref)) return;
      ensured.add(ref);
      convex.mutation(api.probes.ensure, { ref }).catch(() => ensured.delete(ref));
    },

    async runProbes(ref) {
      try {
        const res = await convex.action(api.probes.run, { ref });
        return res.findings;
      } catch (e) {
        toastError(e);
        return [];
      }
    },

    showToast(text, tone = "default") {
      const id = tempId("toast");
      set({ toast: { id, text, tone } });
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, 2600);
    },

    hydrate(patch) {
      const s = get();
      const next: Partial<State> = { ...patch };
      if (patch.settings && !s.draft.modelRef && patch.settings.defaultModelRef) {
        next.draft = { ...s.draft, modelRef: patch.settings.defaultModelRef };
      }
      if (patch.settings || patch.providers) next.ready = true;
      set(next);
    },

    hydrateThreads(list) {
      const s = get();
      const threads: Record<string, Thread> = {};
      for (const t of list) {
        const key = s.threads[t.id]?.key;
        threads[t.id] = key ? { ...t, key } : t;
      }
      // Keep an optimistic chat until the server knows about it.
      for (const [id, t] of Object.entries(s.threads)) if (isPending(id)) threads[id] = t;
      set({ threads, ready: true });
    },

    hydrateMessages(threadId, list) {
      fullThreads.add(threadId);
      const s = get();
      const keyed = withStableKeys(s.messages[threadId] ?? [], list);
      set({
        messages: { ...s.messages, [threadId]: keyed },
        ...(s.activeThreadId === threadId ? { streaming: streamingIn(threadId, keyed) } : {}),
      });
    },

    hydrateArtifacts(list) {
      const byThread: Record<string, Message[]> = {};
      for (const m of list) (byThread[m.threadId] ??= []).push(m);
      const s = get();
      const messages = { ...s.messages };
      for (const [threadId, msgs] of Object.entries(byThread)) {
        if (!fullThreads.has(threadId))
          messages[threadId] = msgs.sort((a, b) => a.createdAt - b.createdAt);
      }
      set({ messages });
    },
  };
});

/* ------------------------------------------------------------------ selectors */

/** Settings for the thread the composer is pointed at — the active thread, or the draft for a new chat. */
export function useComposerTarget() {
  const thread = useApp((s) => (s.activeThreadId ? s.threads[s.activeThreadId] : undefined));
  const draft = useApp((s) => s.draft);
  const models = useApp((s) => s.models);
  const target = thread ?? draft;
  return { thread, target, model: findModel(models, target.modelRef) };
}

/** Every artifact across non-incognito chats, newest first. */
export function useArtifacts() {
  const threads = useApp((s) => s.threads);
  const messages = useApp((s) => s.messages);
  return useMemo(() => collectArtifacts(threads, messages), [threads, messages]);
}

/** ui_events the user has sent back for a given component — lets components replay their chosen state. */
export function useComponentEvents(threadId: string, componentId: string): UiEventPart[] {
  const list = useApp((s) => s.messages[threadId]);
  return useMemo(() => {
    const out: UiEventPart[] = [];
    for (const m of list ?? []) {
      for (const p of m.parts)
        if (p.type === "ui_event" && p.componentId === componentId) out.push(p);
    }
    return out;
  }, [list, componentId]);
}
