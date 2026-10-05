import { validateComponent } from "@/genui/schemas";
import type { ComponentPart, Part } from "@/lib/types";
import type { Op, Script } from "./scenarios";

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Where streamed parts land. The store implements this; tests could too. */
export type Sink = {
  append(part: Part): void;
  update(partId: string, patch: (part: Part) => Part): void;
  cancelled(): boolean;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Splits text into word-ish tokens that keep their trailing whitespace, like SSE deltas. */
function tokens(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

async function stream(
  text: string,
  sink: Sink,
  partId: string,
  field: "text",
  perTick: number,
  tickMs: number
): Promise<boolean> {
  const toks = tokens(text);
  let acc = "";
  for (let i = 0; i < toks.length; i += perTick) {
    if (sink.cancelled()) return false;
    acc += toks.slice(i, i + perTick).join("");
    const next = acc;
    sink.update(partId, (p) => ({ ...p, [field]: next }) as Part);
    await sleep(tickMs);
  }
  return true;
}

function componentPart(op: Extract<Op, { op: "component" }>): ComponentPart {
  return {
    id: uid("cmp"),
    type: "component",
    name: op.name,
    props: op.props,
    status: "streaming",
    fallbackText: op.fallbackText,
  };
}

function settle(part: ComponentPart): ComponentPart {
  const result = validateComponent(part.name, part.props);
  return result.ok
    ? { ...part, props: result.props, status: "ready" }
    : { ...part, status: "invalid", error: result.error };
}

export type PlayOptions = { showThinking: boolean; hiddenThinkMs: number };

/** Streams a script into the sink with realistic pacing. Resolves "stopped" if the user hits stop. */
export async function play(
  script: Script,
  opts: PlayOptions,
  sink: Sink
): Promise<"done" | "stopped"> {
  if (opts.hiddenThinkMs > 0) {
    await sleep(opts.hiddenThinkMs);
    if (sink.cancelled()) return "stopped";
  }
  for (const op of script.ops) {
    if (sink.cancelled()) return "stopped";
    switch (op.op) {
      case "think": {
        if (!opts.showThinking) break;
        const id = uid("think");
        const started = Date.now();
        sink.append({ id, type: "thinking", text: "", done: false });
        const ok = await stream(op.text, sink, id, "text", 2, 22);
        const durationMs = Math.max(1200, (Date.now() - started) * 2.2);
        sink.update(id, (p) => ({ ...p, done: true, durationMs }) as Part);
        if (!ok) return "stopped";
        break;
      }
      case "text": {
        const id = uid("txt");
        sink.append({ id, type: "text", text: "" });
        if (!(await stream(op.text, sink, id, "text", 3, 34))) return "stopped";
        break;
      }
      case "component": {
        const part = componentPart(op);
        sink.append(part);
        await sleep(op.buildMs ?? 750);
        if (sink.cancelled()) return "stopped";
        const settled = settle(part);
        sink.update(part.id, () => settled);
        await sleep(120);
        break;
      }
      case "search": {
        const id = uid("search");
        const started = Date.now();
        sink.append({ id, type: "search", queries: [], sources: [], phase: "searching" });
        for (const q of op.queries) {
          await sleep(560);
          if (sink.cancelled()) return "stopped";
          sink.update(id, (p) => (p.type === "search" ? { ...p, queries: [...p.queries, q] } : p));
        }
        await sleep(380);
        sink.update(id, (p) => (p.type === "search" ? { ...p, phase: "reading" } : p));
        for (const s of op.sources) {
          await sleep(190);
          if (sink.cancelled()) return "stopped";
          sink.update(id, (p) => (p.type === "search" ? { ...p, sources: [...p.sources, s] } : p));
        }
        await sleep(520);
        sink.update(id, (p) => (p.type === "search" ? { ...p, phase: "done", durationMs: Date.now() - started } : p));
        break;
      }
      case "sources":
        sink.append({ id: uid("src"), type: "sources", sources: op.sources });
        break;
      case "wait":
        for (let t = 0; t < op.ms; t += 200) {
          if (sink.cancelled()) return "stopped";
          await sleep(200);
        }
        break;
    }
  }
  return "done";
}

/** Builds the final parts of a script instantly — used for seeded history threads. */
export function materialize(script: Script, showThinking: boolean): Part[] {
  const parts: Part[] = [];
  for (const op of script.ops) {
    if (op.op === "think" && showThinking) {
      parts.push({
        id: uid("think"),
        type: "thinking",
        text: op.text,
        done: true,
        durationMs: 1500 + op.text.length * 18,
      });
    } else if (op.op === "text") {
      parts.push({ id: uid("txt"), type: "text", text: op.text });
    } else if (op.op === "component") {
      const part = settle(componentPart(op));
      const props = part.props as Record<string, unknown>;
      parts.push("live" in props ? { ...part, props: { ...props, live: false } } : part);
    } else if (op.op === "search") {
      parts.push({
        id: uid("search"),
        type: "search",
        queries: op.queries,
        sources: op.sources,
        phase: "done",
        durationMs: 1800 + op.sources.length * 190,
      });
    } else if (op.op === "sources") {
      parts.push({ id: uid("src"), type: "sources", sources: op.sources });
    }
  }
  return parts;
}
