import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { uid } from "../lib/util";
import type { MessageStatus, Part, ReplyMeta } from "../lib/validators";

/** Where a model loop writes its output: the live message for the main agent, a buffer for workers. */
export interface Sink {
  readonly stopped: boolean;
  text(delta: string): void;
  thinking(delta: string): void;
  add(part: Part): string;
  update(id: string, fn: (p: Part) => Part): void;
  get(id: string): Part | undefined;
  last(): Part | undefined;
  find(fn: (p: Part) => boolean): Part | undefined;
  /** Ends the reasoning step in progress, as adding a part does. */
  closeThinking(): void;
  remove(id: string): void;
  /** Flushes if due. Resolves true once the user stopped the reply. */
  tick(): Promise<boolean>;
}

const FLUSH_MS = 200;
const HEARTBEAT_MS = 1500;

/**
 * Buffered writer for one assistant message (PRD §3.1: flush ~200 ms). Parts mutate in memory;
 * at most one write is in flight. A heartbeat keeps checking for "stop" while the model is silent.
 */
export class PartWriter implements Sink {
  parts: Part[];
  stopped = false;
  private dirty = false;
  private lastFlush = 0;
  private inflight: Promise<void> | null = null;
  private thinkStartedAt = 0;
  /** When the model last showed something. Hidden reasoning before the first summary counts as thinking. */
  private quietSince = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Skeletons shown before the model asks for a card (Jev component selection, PRD §4). */
  private preloaded = new Map<string, string>();
  onStop?: () => void;

  constructor(
    private ctx: ActionCtx,
    private messageId: Id<"messages">,
    initial: Part[] = []
  ) {
    this.parts = initial.map((p) => ({ ...p }));
  }

  start(): this {
    const beat = () => {
      this.timer = setTimeout(() => {
        if (this.closed) return;
        this.kick(true);
        beat();
      }, HEARTBEAT_MS);
    };
    beat();
    return this;
  }

  text(delta: string): void {
    if (!delta) return;
    const last = this.parts[this.parts.length - 1];
    if (last?.type === "text") last.text += delta;
    else {
      this.closeThinking();
      this.parts.push({ id: uid("txt"), type: "text", text: delta });
    }
    this.quietSince = Date.now();
    this.dirty = true;
  }

  thinking(delta: string): void {
    if (!delta) return;
    const last = this.parts[this.parts.length - 1];
    if (last?.type === "thinking" && !last.done) last.text += delta;
    else {
      this.thinkStartedAt = this.quietSince;
      this.parts.push({ id: uid("think"), type: "thinking", text: delta, done: false });
    }
    this.dirty = true;
  }

  closeThinking(): void {
    for (const p of this.parts) {
      if (p.type === "thinking" && !p.done) {
        p.done = true;
        p.durationMs = Date.now() - (this.thinkStartedAt || Date.now());
        this.dirty = true;
      }
    }
    this.quietSince = Date.now();
  }

  add(part: Part): string {
    this.closeThinking();
    const skeleton = part.type === "component" ? this.preloaded.get(part.name) : undefined;
    const at = skeleton ? this.parts.findIndex((p) => p.id === skeleton) : -1;
    if (at >= 0 && part.type === "component") {
      this.preloaded.delete(part.name);
      this.parts[at] = part;
    } else {
      this.parts.push(part);
    }
    this.quietSince = Date.now();
    this.dirty = true;
    return part.id;
  }

  /** Shows a loading skeleton for a card the model is very likely to build. */
  preload(name: string): void {
    if (this.preloaded.has(name)) return;
    const id = uid("cmp");
    this.parts.push({
      id,
      type: "component",
      name,
      props: {},
      status: "streaming",
      fallbackText: "",
    });
    this.preloaded.set(name, id);
    this.dirty = true;
  }

  /** Removes skeletons the model never filled. */
  dropUnusedPreloads(): void {
    for (const id of this.preloaded.values()) this.remove(id);
    this.preloaded.clear();
  }

  update(id: string, fn: (p: Part) => Part): void {
    const i = this.parts.findIndex((p) => p.id === id);
    if (i < 0) return;
    this.parts[i] = fn(this.parts[i]);
    this.quietSince = Date.now();
    this.dirty = true;
  }

  get(id: string): Part | undefined {
    return this.parts.find((p) => p.id === id);
  }

  last(): Part | undefined {
    return this.parts[this.parts.length - 1];
  }

  find(fn: (p: Part) => boolean): Part | undefined {
    return this.parts.find(fn);
  }

  remove(id: string): void {
    const before = this.parts.length;
    this.parts = this.parts.filter((p) => p.id !== id);
    if (this.parts.length !== before) this.dirty = true;
  }

  async tick(): Promise<boolean> {
    if (this.dirty && Date.now() - this.lastFlush >= FLUSH_MS) this.kick(false);
    return this.stopped;
  }

  async flush(): Promise<void> {
    if (this.inflight) await this.inflight;
    await this.write();
  }

  private kick(force: boolean): void {
    if (this.inflight || this.closed) return;
    if (!this.dirty && !force) return;
    this.inflight = this.write().finally(() => {
      this.inflight = null;
    });
  }

  private async write(final?: {
    status: MessageStatus;
    meta?: ReplyMeta;
    error?: string;
    searchText?: string;
  }): Promise<void> {
    this.dirty = false;
    this.lastFlush = Date.now();
    const parts = JSON.parse(JSON.stringify(this.parts)) as Part[];
    try {
      const r = await this.ctx.runMutation(internal.engine.data.writeParts, {
        messageId: this.messageId,
        parts,
        ...(final ?? {}),
      });
      if (r.stopped && !this.stopped) {
        this.stopped = true;
        this.onStop?.();
      }
    } catch (e) {
      if (final) throw e;
      this.dirty = true;
      console.warn("flush failed", (e as Error).message);
    }
  }

  /** Flushes and stops the heartbeat without changing status — another action continues this message. */
  async detach(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.inflight) await this.inflight;
    this.closeThinking();
    await this.write();
  }

  async finish(final: {
    status: MessageStatus;
    meta?: ReplyMeta;
    error?: string;
    searchText?: string;
  }): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.inflight) await this.inflight;
    this.closeThinking();
    for (const p of this.parts) {
      if (p.type === "search" && p.phase !== "done") p.phase = "done";
      if (p.type === "component" && p.status === "streaming") {
        p.status = "invalid";
        p.error = "The reply ended before this card finished.";
      }
    }
    await this.write(final);
  }
}

/** Collects a worker's output without touching the database; cancellation is polled. */
export class BufferSink implements Sink {
  stopped = false;
  parts: Part[] = [];
  out = "";
  private lastCheck = Date.now();

  constructor(private isCancelled?: () => Promise<boolean>) {}

  text(delta: string): void {
    this.out += delta;
  }
  thinking(): void {}
  closeThinking(): void {}
  add(part: Part): string {
    this.parts.push(part);
    return part.id;
  }
  update(id: string, fn: (p: Part) => Part): void {
    const i = this.parts.findIndex((p) => p.id === id);
    if (i >= 0) this.parts[i] = fn(this.parts[i]);
  }
  get(id: string): Part | undefined {
    return this.parts.find((p) => p.id === id);
  }
  last(): Part | undefined {
    return this.parts[this.parts.length - 1];
  }
  find(fn: (p: Part) => boolean): Part | undefined {
    return this.parts.find(fn);
  }
  remove(id: string): void {
    this.parts = this.parts.filter((p) => p.id !== id);
  }
  async tick(): Promise<boolean> {
    if (this.isCancelled && Date.now() - this.lastCheck > 2500) {
      this.lastCheck = Date.now();
      if (await this.isCancelled()) this.stopped = true;
    }
    return this.stopped;
  }
}
