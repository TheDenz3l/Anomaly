import { create } from "zustand";
import { decisions, reasoningTokensFor, resolveReasoning } from "@/lib/engine/decision";
import { materialize, play, uid, type Sink } from "@/lib/engine/player";
import {
  isSilentEvent,
  scriptForEvent,
  scriptForPrompt,
  type Script,
  type ScriptContext,
} from "@/lib/engine/scenarios";
import { seedMemories } from "@/lib/mock/memories";
import { DEFAULT_MODEL_REF, mockModels, mockProviders, modelRef } from "@/lib/mock/models";
import type {
  CapabilityProfile,
  ComponentPart,
  Memory,
  Message,
  Model,
  Part,
  Provider,
  Settings,
  Thread,
  ThreadMode,
  UiEventPart,
} from "@/lib/types";

export type Attachment = { uri: string; width?: number; height?: number };

type Draft = { modelRef: string; reasoningLevel: string; incognito: boolean };

type Toast = { id: string; text: string; tone: "default" | "danger" };

type State = {
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
  locationGranted: boolean;
  savedMessageIds: string[];
  toast: Toast | null;
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
  updateSettings(patch: Partial<Settings>): void;
  addMemory(m: Omit<Memory, "id" | "createdAt">): string;
  updateMemory(id: string, patch: Partial<Memory>): void;
  deleteMemory(id: string): void;
  upsertProvider(p: Provider): void;
  removeProvider(providerId: string): void;
  addModels(models: Model[]): void;
  overrideProfile(ref: string, patch: Partial<CapabilityProfile>): void;
  showToast(text: string, tone?: Toast["tone"]): void;
};

export type AppStore = State & Actions;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function findModel(models: Model[], ref: string): Model {
  return models.find((m) => modelRef(m) === ref) ?? models[0];
}

/* ------------------------------------------------------------------ seeds */

function seedThreads(): Pick<State, "threads" | "messages"> {
  const threads: Record<string, Thread> = {};
  const messages: Record<string, Message[]> = {};
  const model = findModel(mockModels, DEFAULT_MODEL_REF);
  const ctx: ScriptContext = {
    model,
    mode: "chat",
    hasImages: false,
    incognito: false,
    memoryEnabled: true,
    subagentMode: "auto",
    locationGranted: true,
  };

  const make = (
    title: string,
    ago: number,
    turns: (
      | { user: string }
      | { event: (prev: Message) => Omit<UiEventPart, "id" | "type"> }
      | { script: Script }
    )[],
    extra: Partial<Thread> = {}
  ) => {
    const id = uid("thr");
    const createdAt = Date.now() - ago;
    const list: Message[] = [];
    let t = createdAt;
    for (const turn of turns) {
      t += 40_000;
      if ("user" in turn) {
        list.push({
          id: uid("msg"),
          threadId: id,
          role: "user",
          parts: [{ id: uid("txt"), type: "text", text: turn.user }],
          createdAt: t,
          status: "done",
        });
      } else if ("event" in turn) {
        const ev = turn.event(list[list.length - 1]);
        list.push({
          id: uid("msg"),
          threadId: id,
          role: "user",
          parts: [{ id: uid("evt"), type: "ui_event", ...ev }],
          createdAt: t,
          status: "done",
        });
      } else {
        const sent = turn.script.difficulty === "hard" ? "high" : "medium";
        list.push({
          id: uid("msg"),
          threadId: id,
          role: "assistant",
          parts: materialize(turn.script, true),
          createdAt: t,
          status: "done",
          meta: {
            modelRef: DEFAULT_MODEL_REF,
            levelRequested: "auto",
            levelSent: sent,
            reasoningTokens: reasoningTokensFor(sent, turn.script.difficulty),
            kind: turn.script.kind,
          },
        });
      }
    }
    threads[id] = {
      id,
      title,
      modelRef: DEFAULT_MODEL_REF,
      mode: "chat",
      reasoningLevel: "auto",
      incognito: false,
      createdAt,
      updatedAt: t,
      ...extra,
    };
    messages[id] = list;
  };

  const componentIn = (m: Message, name: string) =>
    m.parts.find((p): p is ComponentPart => p.type === "component" && p.name === name)!;

  make("Savings at $500 a month", 2 * HOUR, [
    { user: "Show my savings if I add $500 a month" },
    { script: scriptForPrompt("Show my savings if I add $500 a month", ctx) },
  ]);

  make("Movies near me", DAY + 3 * HOUR, [
    { user: "What movies are playing near me?" },
    {
      script: scriptForPrompt("What movies are playing near me?", {
        ...ctx,
        locationGranted: false,
      }),
    },
    {
      event: (prev) => ({
        componentId: componentIn(prev, "LocationRequest").id,
        component: "LocationRequest",
        action: "allow",
        label: "Shared current location",
      }),
    },
    {
      script: scriptForEvent(
        {
          id: "",
          type: "ui_event",
          componentId: "",
          component: "LocationRequest",
          action: "allow",
          label: "",
        },
        ctx
      )!,
    },
  ]);

  const research = { ...ctx, mode: "research" as const };
  make(
    "Best e-bikes under $2,000",
    2 * DAY + 5 * HOUR,
    [
      { user: "Research the best e-bikes under $2,000 for commuting" },
      { script: scriptForPrompt("Research", research) },
      {
        event: (prev) => ({
          componentId: componentIn(prev, "ChoiceChips").id,
          component: "ChoiceChips",
          action: "choose",
          label: "Hill climbing, Light enough to carry",
          payload: { ids: ["hills", "weight"] },
        }),
      },
      {
        script: scriptForEvent(
          {
            id: "",
            type: "ui_event",
            componentId: "",
            component: "ChoiceChips",
            action: "choose",
            label: "",
            payload: { ids: ["hills"] },
          },
          research
        )!,
      },
      {
        event: (prev) => ({
          componentId: componentIn(prev, "ResearchPlan").id,
          component: "ResearchPlan",
          action: "start",
          label: "Started research with 4 steps",
        }),
      },
      {
        script: scriptForEvent(
          {
            id: "",
            type: "ui_event",
            componentId: "",
            component: "ResearchPlan",
            action: "start",
            label: "",
          },
          research
        )!,
      },
    ],
    { mode: "research" }
  );

  make("Packing for Lisbon", 6 * DAY, [
    { user: "Packing list for 4 days in Lisbon" },
    { script: scriptForPrompt("Packing list for 4 days in Lisbon", ctx) },
  ]);

  make(
    "Weekend weather",
    8 * DAY,
    [
      { user: "What's the weather this weekend?" },
      { script: scriptForPrompt("What's the weather this weekend?", ctx) },
    ],
    { incognito: true }
  );

  return { threads, messages };
}

/* ------------------------------------------------------------------ run control */

let runToken = { cancelled: false };

const defaultSettings: Settings = {
  customInstructions: "Be concise. Use metric units. I live in Toronto.",
  memoryEnabled: true,
  subagentMode: "auto",
  webMode: "auto",
  searchProvider: "searxng",
  searchKeyHint: "https://searx.example.org",
  voiceInput: "device",
  voiceOutput: "device",
  readRepliesAloud: false,
  probeSpendCapUsd: 0.05,
  defaultModelRef: DEFAULT_MODEL_REF,
  researchModelRef: "openai/gpt-5",
};

export const useApp = create<AppStore>()((set, get) => {
  const patchMessages = (threadId: string, fn: (list: Message[]) => Message[]) =>
    set((s) => ({ messages: { ...s.messages, [threadId]: fn(s.messages[threadId] ?? []) } }));

  const patchMessage = (threadId: string, messageId: string, fn: (m: Message) => Message) =>
    patchMessages(threadId, (list) => list.map((m) => (m.id === messageId ? fn(m) : m)));

  const touch = (threadId: string) =>
    set((s) =>
      s.threads[threadId]
        ? {
            threads: {
              ...s.threads,
              [threadId]: { ...s.threads[threadId], updatedAt: Date.now() },
            },
          }
        : {}
    );

  const contextFor = (thread: Thread, hasImages: boolean): ScriptContext => {
    const s = get();
    return {
      model: findModel(s.models, thread.modelRef),
      mode: thread.mode,
      hasImages,
      incognito: thread.incognito,
      memoryEnabled: s.settings.memoryEnabled,
      subagentMode: s.settings.subagentMode,
      locationGranted: s.locationGranted,
    };
  };

  /** Runs one assistant turn: resolves reasoning for the endpoint, then streams the script into a new message. */
  const runAssistant = async (threadId: string, script: Script) => {
    const s = get();
    const thread = s.threads[threadId];
    const model = findModel(s.models, thread.modelRef);
    const { sent } = resolveReasoning(model.profile, thread.reasoningLevel, script.difficulty);
    const messageId = uid("msg");
    const message: Message = {
      id: messageId,
      threadId,
      role: "assistant",
      parts: [],
      createdAt: Date.now(),
      status: "streaming",
      meta: {
        modelRef: thread.modelRef,
        levelRequested: thread.reasoningLevel,
        levelSent: sent,
        reasoningTokens: model.profile.reasoning.noop
          ? 0
          : reasoningTokensFor(sent, script.difficulty),
        kind: script.kind,
      },
    };
    runToken.cancelled = true;
    const token = { cancelled: false };
    runToken = token;
    patchMessages(threadId, (list) => [...list, message]);
    set({ streaming: { threadId, messageId } });

    const sink: Sink = {
      append: (part) =>
        patchMessage(threadId, messageId, (m) => ({ ...m, parts: [...m.parts, part] })),
      update: (partId, fn) =>
        patchMessage(threadId, messageId, (m) => ({
          ...m,
          parts: m.parts.map((p) => (p.id === partId ? fn(p) : p)),
        })),
      cancelled: () => token.cancelled,
    };

    const showThinking = model.profile.features.reasoningText && sent !== "off";
    const hiddenThinkMs = sent === "off" ? 350 : showThinking ? 250 : sent === "high" ? 1600 : 900;
    const outcome = await play(script, { showThinking, hiddenThinkMs }, sink);
    patchMessage(threadId, messageId, (m) => ({
      ...m,
      status: outcome,
      parts: m.parts.map((p) =>
        p.type === "thinking" && !p.done ? { ...p, done: true, durationMs: 1000 } : p
      ),
    }));
    touch(threadId);
    if (get().streaming?.messageId === messageId) set({ streaming: null });
  };

  const ensureThread = (firstText: string): string => {
    const s = get();
    if (s.activeThreadId && s.threads[s.activeThreadId]) return s.activeThreadId;
    const id = uid("thr");
    const now = Date.now();
    const mode: ThreadMode = s.researchArmed ? "research" : "chat";
    const thread: Thread = {
      id,
      title: decisions.title(firstText),
      mode,
      ...s.draft,
      createdAt: now,
      updatedAt: now,
    };
    set({
      threads: { ...s.threads, [id]: thread },
      messages: { ...s.messages, [id]: [] },
      activeThreadId: id,
    });
    return id;
  };

  const patchActiveOrDraft = (patch: Partial<Draft & { mode: ThreadMode }>) => {
    const s = get();
    if (s.activeThreadId && s.threads[s.activeThreadId]) {
      set({
        threads: { ...s.threads, [s.activeThreadId]: { ...s.threads[s.activeThreadId], ...patch } },
      });
    } else {
      set({ draft: { ...s.draft, ...patch } });
    }
  };

  return {
    providers: mockProviders,
    models: mockModels,
    ...seedThreads(),
    activeThreadId: null,
    draft: { modelRef: DEFAULT_MODEL_REF, reasoningLevel: "auto", incognito: false },
    settings: defaultSettings,
    researchArmed: false,
    memories: seedMemories,
    streaming: null,
    locationGranted: false,
    savedMessageIds: [],
    toast: null,

    newChat() {
      const s = get();
      set({
        activeThreadId: null,
        draft: { modelRef: s.settings.defaultModelRef, reasoningLevel: "auto", incognito: false },
        researchArmed: false,
      });
    },

    openThread(id) {
      set({ activeThreadId: id });
    },

    deleteThread(id) {
      const s = get();
      if (s.streaming?.threadId === id) runToken.cancelled = true;
      const { [id]: _t, ...threads } = s.threads;
      const { [id]: _m, ...messages } = s.messages;
      set({
        threads,
        messages,
        activeThreadId: s.activeThreadId === id ? null : s.activeThreadId,
        streaming: s.streaming?.threadId === id ? null : s.streaming,
      });
    },

    renameThread(id, title) {
      const s = get();
      if (s.threads[id]) set({ threads: { ...s.threads, [id]: { ...s.threads[id], title } } });
    },

    setModel(ref) {
      patchActiveOrDraft({ modelRef: ref });
    },

    setReasoningLevel(level) {
      patchActiveOrDraft({ reasoningLevel: level });
    },

    setResearchMode(on) {
      set({ researchArmed: on });
    },

    setIncognito(on) {
      patchActiveOrDraft({ incognito: on });
    },

    send(text, attachments) {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      const threadId = ensureThread(trimmed || "Photo");
      const parts: Part[] = [
        ...attachments.map((a): Part => ({
          id: uid("img"),
          type: "image",
          uri: a.uri,
          width: a.width,
          height: a.height,
        })),
        ...(trimmed ? [{ id: uid("txt"), type: "text", text: trimmed } as Part] : []),
      ];
      patchMessages(threadId, (list) => [
        ...list,
        { id: uid("msg"), threadId, role: "user", parts, createdAt: Date.now(), status: "done" },
      ]);
      const research = get().researchArmed;
      if (research) {
        patchActiveOrDraft({ mode: "research" });
        set({ researchArmed: false });
      }
      const thread = get().threads[threadId];
      // Research is a one-shot preset: clarify → plan → run continues through ui_events, not later prompts.
      const ctx = {
        ...contextFor(thread, attachments.length > 0),
        mode: research ? ("research" as const) : ("chat" as const),
      };
      void runAssistant(threadId, scriptForPrompt(trimmed, ctx));
    },

    emitUiEvent(threadId, event) {
      const part: UiEventPart = { id: uid("evt"), type: "ui_event", ...event };
      patchMessages(threadId, (list) => [
        ...list,
        {
          id: uid("msg"),
          threadId,
          role: "user",
          parts: [part],
          createdAt: Date.now(),
          status: "done",
        },
      ]);
      if (event.component === "LocationRequest" && event.action === "allow")
        set({ locationGranted: true });
      touch(threadId);
      if (isSilentEvent(part)) return;
      const thread = get().threads[threadId];
      const script = scriptForEvent(part, contextFor(thread, false));
      if (script) void runAssistant(threadId, script);
    },

    stop() {
      runToken.cancelled = true;
      set({ streaming: null });
    },

    regenerate(messageId) {
      const s = get();
      const threadId = Object.keys(s.messages).find((k) =>
        s.messages[k].some((m) => m.id === messageId)
      );
      if (!threadId || s.streaming) return;
      const list = s.messages[threadId];
      const idx = list.findIndex((m) => m.id === messageId);
      const prompt = list
        .slice(0, idx)
        .reverse()
        .find((m) => m.role === "user");
      if (!prompt) return;
      const thread = s.threads[threadId];
      const ev = prompt.parts.find((p): p is UiEventPart => p.type === "ui_event");
      const text = prompt.parts.find((p) => p.type === "text");
      const hasImages = prompt.parts.some((p) => p.type === "image");
      const script = ev
        ? scriptForEvent(ev, contextFor(thread, false))
        : scriptForPrompt(text?.type === "text" ? text.text : "", {
            ...contextFor(thread, hasImages),
            mode:
              list.findIndex((m) => m.role === "user") === list.indexOf(prompt)
                ? thread.mode
                : "chat",
          });
      if (!script) return;
      patchMessages(threadId, (l) => l.filter((m) => m.id !== messageId));
      void runAssistant(threadId, script);
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
    },

    updateSettings(patch) {
      set((s) => ({ settings: { ...s.settings, ...patch } }));
    },

    addMemory(m) {
      const id = uid("mem");
      set((s) => ({ memories: [{ ...m, id, createdAt: Date.now() }, ...s.memories] }));
      return id;
    },

    updateMemory(id, patch) {
      set((s) => ({ memories: s.memories.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
    },

    deleteMemory(id) {
      set((s) => ({ memories: s.memories.filter((m) => m.id !== id) }));
    },

    upsertProvider(p) {
      set((s) => {
        const exists = s.providers.some((x) => x.providerId === p.providerId);
        return {
          providers: exists
            ? s.providers.map((x) => (x.providerId === p.providerId ? p : x))
            : [...s.providers, p],
        };
      });
    },

    removeProvider(providerId) {
      set((s) => ({
        providers: s.providers.filter((p) => p.providerId !== providerId),
        models: s.models.filter((m) => m.providerId !== providerId),
      }));
    },

    addModels(list) {
      set((s) => ({
        models: [
          ...s.models.filter((m) => !list.some((n) => modelRef(n) === modelRef(m))),
          ...list,
        ],
      }));
    },

    overrideProfile(ref, patch) {
      set((s) => ({
        models: s.models.map((m) =>
          modelRef(m) === ref
            ? {
                ...m,
                profile: {
                  ...m.profile,
                  ...patch,
                  version: m.profile.version + 1,
                  lastVerified: Date.now(),
                },
              }
            : m
        ),
      }));
    },

    showToast(text, tone = "default") {
      const id = uid("toast");
      set({ toast: { id, text, tone } });
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, 2400);
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

/** ui_events the user has sent back for a given component — lets components replay their chosen state. */
export function useComponentEvents(threadId: string, componentId: string): UiEventPart[] {
  const list = useApp((s) => s.messages[threadId]);
  const out: UiEventPart[] = [];
  for (const m of list ?? []) {
    for (const p of m.parts)
      if (p.type === "ui_event" && p.componentId === componentId) out.push(p);
  }
  return out;
}
