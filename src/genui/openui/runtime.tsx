import {
  ACTION_STEPS,
  createQueryManager,
  createStore,
  createStreamingParser,
  evaluate,
  evaluateElementProps,
  resolveStateField,
  type ActionPlan,
  type ElementNode,
  type EvaluationContext,
  type Library,
  type StateField,
  type Store,
} from "@openuidev/lang-core";
import {
  Component,
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import type { CardStateEntry } from "@/genui/schemas";
import { isPhotoUrl, type PhotoPick } from "./library";

/**
 * A native renderer for OpenUI Lang on @openuidev/lang-core: parses the program as it streams,
 * keeps its $variables, evaluates expressions over them, runs Action([...]) steps and fetches its
 * Query(…) data through the app's card tools. A port of @openuidev/react-lang's Renderer, whose
 * output wraps everything in DOM elements, without its devtools or observability.
 */

export type OpenUIRenderProps<P = Record<string, unknown>> = {
  props: P;
  renderNode: (value: unknown) => ReactNode;
  statementId?: string;
  /** Still streaming in: its last argument may be cut short. */
  partial?: boolean;
};
export type OpenUIComponent<P = Record<string, unknown>> = ComponentType<OpenUIRenderProps<P>>;
export type OpenUILibrary = Library<OpenUIComponent<any>>;

/** Where a component's action goes when it leaves the card. */
export type OpenUIHandlers = {
  /** @ToAssistant(message), or a button with no action: the user's next message. */
  toAssistant: (message: string) => void;
  openUrl: (url: string) => void;
  /** Query(…) and Mutation(…) data: a card tool run on the server (convex/cardTools.ts). */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

type Runtime = {
  library: OpenUILibrary;
  renderNode: (value: unknown) => ReactNode;
  run: (action: unknown, label: string) => void;
  streaming: boolean;
  /** A Query is fetching. */
  loading: boolean;
  store: Store;
  evaluation: EvaluationContext;
};

const RuntimeContext = createContext<Runtime | null>(null);

function useRuntime(): Runtime {
  const rt = useContext(RuntimeContext);
  if (!rt) throw new Error("OpenUI components render inside <OpenUIRenderer>.");
  return rt;
}

export const useRenderNode = () => useRuntime().renderNode;
export const useIsStreaming = () => useRuntime().streaming;
/** Whether a Query is still fetching, so data components can hold their place. */
export const useQueryLoading = () => useRuntime().loading;
/** Fires an action prop: its Action([...]) steps, or with none, `label` to the assistant. */
export const useRunAction = () => useRuntime().run;

/** Form fields are stored as { value }; $variables as the bare value. */
const unwrap = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) && "value" in v
    ? (v as { value: unknown }).value
    : v;

type Photos = { picks: Map<string, string | null>; settled: boolean };
const PhotoContext = createContext<Photos>({ picks: new Map(), settled: true });

/**
 * Photo URLs for image arguments, in order: a URL as written, the photo the server found for a
 * phrase, undefined while it's still looking, null when there's none.
 */
export function usePhotos(sources: unknown[]): (string | null | undefined)[] {
  const { picks, settled } = useContext(PhotoContext);
  return sources.map((s) => {
    const src = typeof s === "string" ? s.trim() : "";
    if (!src) return null;
    // The server's word first: it may have dropped a photo the chat already showed.
    if (picks.has(src)) return picks.get(src)!;
    if (isPhotoUrl(src)) return src;
    return settled ? null : undefined;
  });
}

export const usePhoto = (src: unknown) => usePhotos([src])[0];

/** How long after the last change a card saves what the user set, and refetches its queries. */
const SAVE_DELAY_MS = 800;
const REFETCH_DELAY_MS = 400;

/** The store's values as saved: $variables as they are, components' fields as { value }. */
function toEntries(snapshot: Record<string, unknown>): CardStateEntry[] {
  const out: CardStateEntry[] = [];
  const plain = (v: unknown): v is CardStateEntry["v"] =>
    v === null || ["string", "number", "boolean"].includes(typeof v);
  for (const [k, v] of Object.entries(snapshot)) {
    if (plain(v)) out.push({ k, v });
    else if (v && typeof v === "object" && "value" in v && plain((v as { value: unknown }).value))
      out.push({ k, v: (v as { value: CardStateEntry["v"] }).value, field: true });
  }
  return out;
}

function fromEntries(entries: CardStateEntry[] | undefined): Record<string, unknown> {
  return Object.fromEntries(
    (entries ?? []).map((e) => [e.k, e.field ? { value: e.v } : e.v] as const)
  );
}

/** A value the user can change: the $variable it's bound to, or the component's own state. */
export function useStateField<T>(name: string, binding: unknown): StateField<T> {
  // The value lives in the card's store, outside React: React Compiler would otherwise keep the
  // first value it read (name and binding don't change), so a tap would land and never show.
  "use no memo";
  const { store, evaluation } = useRuntime();
  // Read through the snapshot, so the value is the one this render subscribed to.
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return resolveStateField<T>(
    name,
    binding,
    store,
    evaluation,
    (field) => unwrap(snapshot[field]),
    (field, value) => store.set(field, { value })
  );
}

export function OpenUIRenderer({
  source,
  library,
  streaming,
  handlers,
  photos,
  photosDone,
  initialState,
  onStateChange,
  placeholder = null,
}: {
  source: string;
  library: OpenUILibrary;
  streaming: boolean;
  handlers: OpenUIHandlers;
  /** Photos the server found for the card's phrases; absent on cards from before it did. */
  photos?: PhotoPick[];
  /** Every phrase has had its lookup. */
  photosDone?: boolean;
  /** What the user set on the card last time, restored before the defaults fill in. */
  initialState?: CardStateEntry[];
  /** What the user has set, a moment after they stop changing it. */
  onStateChange?: (state: CardStateEntry[]) => void;
  /** Shown until the program has something to draw. */
  placeholder?: ReactNode;
}) {
  const parser = useMemo(
    () => createStreamingParser(library.toJSONSchema(), library.root),
    [library]
  );
  const parsed = useMemo(() => {
    if (!source) return null;
    try {
      return parser.set(source);
    } catch {
      return null;
    }
  }, [parser, source]);

  const store = useMemo(() => createStore(), []);
  // What the user set last time goes in once; declared defaults fill only what isn't set, so taps
  // survive the rest of the stream.
  const restored = useRef(false);
  const saved = useRef<string | null>(null);
  useEffect(() => {
    if (!parsed?.stateDeclarations && !initialState?.length) return;
    const persisted = restored.current ? {} : fromEntries(initialState);
    restored.current = true;
    store.initialize(parsed?.stateDeclarations ?? {}, persisted);
    saved.current = JSON.stringify(toEntries(store.getSnapshot()));
  }, [parsed?.stateDeclarations, initialState, store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // Save what the user changes once they pause, and on the way out if they leave before then.
  const onChangeRef = useRef(onStateChange);
  useLayoutEffect(() => {
    onChangeRef.current = onStateChange;
  });
  useEffect(() => {
    if (streaming) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const entries = toEntries(store.getSnapshot());
      const json = JSON.stringify(entries);
      if (json === saved.current) return;
      saved.current = json;
      onChangeRef.current?.(entries);
    };
    const off = store.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DELAY_MS);
    });
    return () => {
      off();
      if (timer) {
        clearTimeout(timer);
        flush();
      }
    };
  }, [streaming, store]);

  // Actions and queries read the latest handlers and declarations when they run.
  const handlersRef = useRef(handlers);
  const declsRef = useRef(parsed?.stateDeclarations);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
    declsRef.current = parsed?.stateDeclarations;
  });

  // The card tool caller is stable (OpenUI.tsx), so fetched data lives as long as the card.
  const { callTool } = handlers;
  const queries = useMemo(() => createQueryManager({ callTool }), [callTool]);
  useEffect(() => {
    queries.activate();
    return () => queries.dispose();
  }, [queries]);
  const fetched = useSyncExternalStore(queries.subscribe, queries.getSnapshot, queries.getSnapshot);

  const evaluation = useMemo<EvaluationContext>(
    () => ({
      getState: (name) => unwrap(store.get(name)),
      resolveRef: (name) => queries.getMutationResult(name) ?? queries.getResult(name),
    }),
    [store, queries]
  );

  // Queries run once the program is complete, and again when a $variable they use changes: after a
  // short pause, so dragging a slider that feeds one fetches once, not at every step.
  const queried = useRef(false);
  useEffect(() => {
    if (streaming) return;
    const timer = setTimeout(evaluateAll, queried.current ? REFETCH_DELAY_MS : 0);
    queried.current = true;
    return () => clearTimeout(timer);

    function evaluateAll() {
      queries.evaluateQueries(
        (parsed?.queryStatements ?? []).map((q) => {
          const deps = Object.fromEntries((q.deps ?? []).map((d) => [d, snapshot[d]]));
          return {
            statementId: q.statementId,
            toolName: q.toolAST ? String(evaluate(q.toolAST, evaluation)) : "",
            args: q.argsAST ? evaluate(q.argsAST, evaluation) : null,
            defaults: q.defaultsAST ? evaluate(q.defaultsAST, evaluation) : null,
            refreshInterval: q.refreshAST ? Number(evaluate(q.refreshAST, evaluation)) : undefined,
            deps: Object.keys(deps).length ? deps : undefined,
            complete: q.complete,
          };
        })
      );
      queries.registerMutations(
        (parsed?.mutationStatements ?? []).map((m) => ({
          statementId: m.statementId,
          toolName: m.toolAST ? String(evaluate(m.toolAST, evaluation)) : "",
        }))
      );
    }
  }, [streaming, parsed, evaluation, queries, snapshot]);

  const run = useCallback(
    async (action: unknown, label: string) => {
      const plan = action as ActionPlan | { type?: string; url?: string } | null | undefined;
      if (!plan || !("steps" in plan)) {
        if (plan && plan.type === "open_url" && plan.url) handlersRef.current.openUrl(plan.url);
        else if (label) handlersRef.current.toAssistant(label);
        return;
      }
      for (const step of plan.steps) {
        switch (step.type) {
          case ACTION_STEPS.ToAssistant:
            handlersRef.current.toAssistant(step.message);
            break;
          case ACTION_STEPS.OpenUrl:
            handlersRef.current.openUrl(step.url);
            break;
          case ACTION_STEPS.Set:
            if (step.valueAST) store.set(step.target, evaluate(step.valueAST, evaluation));
            break;
          case ACTION_STEPS.Reset:
            for (const target of step.targets)
              store.set(target, declsRef.current?.[target] ?? null);
            break;
          case ACTION_STEPS.Run:
            if (step.refType === "query") queries.invalidate([step.statementId]);
            else {
              const m = parsed?.mutationStatements.find((x) => x.statementId === step.statementId);
              const args = m?.argsAST ? evaluate(m.argsAST, evaluation) : {};
              // A failed mutation stops the steps after it.
              if (!(await queries.fireMutation(step.statementId, args as Record<string, unknown>)))
                return;
            }
            break;
        }
      }
    },
    [store, evaluation, queries, parsed]
  );

  const root = useMemo(() => {
    if (!parsed?.root) return null;
    try {
      return evaluateElementProps(parsed.root, { ctx: evaluation, library, store, errors: [] });
    } catch {
      return parsed.root;
    }
    // Expressions read the $variables and fetched data: re-evaluate when either changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, evaluation, library, store, snapshot, fetched]);

  const loading = fetched.__openui_loading.length > 0;
  const runtime = useMemo<Runtime>(
    () => ({
      library,
      renderNode,
      run: (a, l) => void run(a, l),
      streaming,
      loading,
      store,
      evaluation,
    }),
    [library, run, streaming, loading, store, evaluation]
  );
  const photoContext = useMemo<Photos>(
    () => ({
      picks: new Map((photos ?? []).map((p) => [p.q, p.url])),
      // Cards from before the server found photos have none to wait for.
      settled: !streaming && (photosDone === true || photos === undefined),
    }),
    [photos, photosDone, streaming]
  );

  if (!root) return placeholder;
  return (
    <RuntimeContext.Provider value={runtime}>
      <PhotoContext.Provider value={photoContext}>
        <RenderNode node={root} />
      </PhotoContext.Provider>
    </RuntimeContext.Provider>
  );
}

/** A parsed value as React: elements render through the library, text as text, arrays in order. */
function renderNode(value: unknown): ReactNode {
  if (value == null || value === false) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value))
    return value.map((v, i) => <Fragment key={i}>{renderNode(v)}</Fragment>);
  if (typeof value === "object" && (value as ElementNode).type === "element")
    return <RenderNode node={value as ElementNode} />;
  return null;
}

function RenderNode({ node }: { node: ElementNode }) {
  const { library } = useRuntime();
  const Comp = library.components[node.typeName]?.component;
  if (!Comp) return null;
  return (
    <KeepLastGood>
      <Comp
        props={node.props}
        renderNode={renderNode}
        statementId={node.statementId}
        partial={node.partial}
      />
    </KeepLastGood>
  );
}

/**
 * A component that throws (props mid-stream it can't draw yet) keeps showing what it last drew,
 * and tries again when its props change.
 */
class KeepLastGood extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  last: ReactNode = null;
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(prev: { children: ReactNode }) {
    if (!this.state.failed) this.last = this.props.children;
    else if (prev.children !== this.props.children) this.setState({ failed: false });
  }
  componentDidMount() {
    this.last = this.props.children;
  }
  render() {
    return this.state.failed ? this.last : this.props.children;
  }
}
