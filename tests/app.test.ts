import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Thread } from "@/lib/types";

const mutation = vi.fn();

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Linking: { openURL: vi.fn(async () => {}) },
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock("expo-location", () => ({}));
vi.mock("expo-web-browser", () => ({
  openBrowserAsync: vi.fn(async () => ({})),
  WebBrowserPresentationStyle: { PAGE_SHEET: "pageSheet" },
}));
vi.mock("@/lib/theme", () => ({ colors: { primaryStrong: "#000" } }));
vi.mock("@/lib/convex", () => ({
  // api.module.fn → "module.fn", so calls can be matched by name.
  api: new Proxy(
    {},
    { get: (_, mod) => new Proxy({}, { get: (_, fn) => `${String(mod)}.${String(fn)}` }) }
  ),
  convex: {
    mutation: (...args: unknown[]) => mutation(...args),
    action: vi.fn(async () => ({})),
    connectionState: () => ({ isWebSocketConnected: true }),
  },
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { useApp, mergeArtifacts } = await import("@/lib/store");
const { reportText, tableMarkdown } = await import("@/lib/artifacts");
const { isOpenableUrl, openLink, trustedImageUrls } = await import("@/lib/links");
const { Linking } = await import("react-native");

const initial = useApp.getState();

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const calls = (name: string) => mutation.mock.calls.filter((c) => c[0] === name);

const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id,
  title: "Chat",
  modelRef: "p/m",
  mode: "chat",
  reasoningLevel: "auto",
  incognito: false,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const msg = (id: string, threadId: string, extra: Partial<Message> = {}): Message => ({
  id,
  threadId,
  role: "assistant",
  parts: [{ id: `${id}-t`, type: "text", text: "hi" }],
  createdAt: 1,
  status: "done",
  ...extra,
});

beforeEach(() => {
  mutation.mockReset();
  vi.unstubAllGlobals();
  useApp.setState({
    ...initial,
    threads: {},
    messages: {},
    activeThreadId: null,
    streaming: null,
    composerRestore: null,
    draft: { modelRef: "p/m", reasoningLevel: "auto", incognito: false },
  });
});

describe("store.send", () => {
  it("sends the draft as it was when Send was pressed", async () => {
    const photo = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "file://a.jpg"
          ? photo.promise
          : Promise.resolve({ ok: true, json: async () => ({ storageId: "st1" }) })
      )
    );
    mutation.mockImplementation(async (name: string) =>
      name === "attachments.generateUploadUrl"
        ? "https://upload"
        : name === "messages.send"
          ? { threadId: "t1", userMessageId: "u1", messageId: "r1" }
          : null
    );
    useApp.getState().setIncognito(true);
    useApp.getState().send("secret", [{ uri: "file://a.jpg" }]);
    // New chat while the photo uploads resets the draft to a normal chat.
    useApp.getState().newChat();
    expect(useApp.getState().draft.incognito).toBe(false);
    photo.resolve({ blob: async () => ({ type: "image/jpeg" }) } as unknown as Response);
    await vi.waitFor(() => expect(calls("messages.send")).toHaveLength(1));
    expect(calls("messages.send")[0][1].draft.incognito).toBe(true);
  });

  it("hands text and photos back and drops the optimistic chat when the server refuses", async () => {
    mutation.mockRejectedValue(new Error("Add a model provider in Settings first."));
    useApp.getState().send("hello", []);
    const pending = useApp.getState().activeThreadId!;
    expect(pending.startsWith("pending_")).toBe(true);
    await vi.waitFor(() => expect(useApp.getState().composerRestore?.text).toBe("hello"));
    const s = useApp.getState();
    expect(s.threads[pending]).toBeUndefined();
    expect(s.messages[pending]).toBeUndefined();
    expect(s.activeThreadId).toBeNull();
    expect(s.streaming).toBeNull();
    expect(s.toast?.tone).toBe("danger");
  });

  it("removes both optimistic messages from an existing chat on failure", async () => {
    useApp.setState({ threads: { t1: thread("t1") }, messages: { t1: [] }, activeThreadId: "t1" });
    mutation.mockRejectedValue(new Error("nope"));
    useApp.getState().send("again", []);
    expect(useApp.getState().messages.t1).toHaveLength(2);
    await vi.waitFor(() => expect(useApp.getState().composerRestore).not.toBeNull());
    expect(useApp.getState().messages.t1).toHaveLength(0);
  });
});

describe("pending chats", () => {
  it("deleting a chat before the server has it removes the server copy when it arrives", async () => {
    const sent = deferred<unknown>();
    mutation.mockImplementation((name: string) =>
      name === "messages.send" ? sent.promise : Promise.resolve(null)
    );
    useApp.getState().send("hello", []);
    const pending = useApp.getState().activeThreadId!;
    useApp.getState().deleteThread(pending);
    sent.resolve({ threadId: "t9", userMessageId: "u", messageId: "r" });
    await vi.waitFor(() => expect(calls("threads.remove")).toHaveLength(1));
    expect(calls("threads.remove")[0][1]).toEqual({ threadId: "t9" });
    expect(useApp.getState().threads.t9).toBeUndefined();
    expect(useApp.getState().messages.t9).toBeUndefined();
  });

  it("renaming a pending chat does nothing", () => {
    useApp.setState({ threads: { pending_x: thread("pending_x") } });
    useApp.getState().renameThread("pending_x", "New name");
    expect(useApp.getState().threads.pending_x.title).toBe("Chat");
    expect(mutation).not.toHaveBeenCalled();
  });

  it("Stop before the server answers stops the reply once it exists", async () => {
    const sent = deferred<unknown>();
    mutation.mockImplementation((name: string) =>
      name === "messages.send" ? sent.promise : Promise.resolve(null)
    );
    useApp.getState().send("hello", []);
    useApp.getState().stop();
    expect(useApp.getState().streaming).toBeNull();
    expect(calls("messages.stop")).toHaveLength(0);
    sent.resolve({ threadId: "t5", userMessageId: "u", messageId: "r5" });
    await vi.waitFor(() => expect(calls("messages.stop")).toHaveLength(1));
    expect(calls("messages.stop")[0][1]).toEqual({ threadId: "t5" });
    expect(useApp.getState().activeThreadId).toBe("t5");
    expect(useApp.getState().streaming).toBeNull();
  });
});

describe("store.regenerate", () => {
  it("puts the previous reply back when the server refuses", async () => {
    const reply = msg("m1", "t1");
    useApp.setState({ threads: { t1: thread("t1") }, messages: { t1: [reply] } });
    mutation.mockRejectedValue(new Error("Only the latest reply can be regenerated."));
    useApp.getState().regenerate("m1");
    expect(useApp.getState().messages.t1[0].status).toBe("streaming");
    await vi.waitFor(() => expect(useApp.getState().messages.t1[0]).toBe(reply));
    expect(useApp.getState().streaming).toBeNull();
  });
});

describe("artifacts in chats that were left", () => {
  it("updates a fully loaded chat once its subscription has ended", () => {
    const store = useApp.getState();
    store.openThread("t1");
    store.hydrateMessages("t1", [
      msg("u1", "t1", { role: "user", createdAt: 1 }),
      msg("r1", "t1", { createdAt: 2, status: "streaming", parts: [] }),
    ]);
    store.openThread("t2");
    const done = msg("r1", "t1", {
      createdAt: 2,
      parts: [
        { id: "c", type: "component", name: "Table", props: {}, status: "ready", fallbackText: "" },
      ],
    });
    useApp.getState().hydrateArtifacts([done]);
    const list = useApp.getState().messages.t1;
    expect(list).toHaveLength(2);
    expect(list[1].status).toBe("done");
  });

  it("leaves the open chat to its own subscription", () => {
    const store = useApp.getState();
    store.openThread("t3");
    store.hydrateMessages("t3", [msg("r1", "t3", { status: "streaming", parts: [] })]);
    useApp.getState().hydrateArtifacts([msg("r1", "t3")]);
    expect(useApp.getState().messages.t3[0].status).toBe("streaming");
  });

  it("mergeArtifacts keeps unchanged messages and their keys", () => {
    const a = msg("a", "t", { key: "k" });
    expect(mergeArtifacts([a], [msg("a", "t")])).toEqual([a]);
    const merged = mergeArtifacts(
      [a],
      [msg("a", "t", { status: "error" }), msg("b", "t", { createdAt: 0 })]
    );
    expect(merged.map((m) => m.id)).toEqual(["b", "a"]);
    expect(merged[1].key).toBe("k");
  });
});

describe("report text", () => {
  it("renders Table cards as Markdown tables", () => {
    const props = {
      title: "Prices",
      columns: [
        { key: "name", label: "Name" },
        { key: "usd", label: "USD", numeric: true },
      ],
      rows: [{ name: "A|B", usd: 3 }],
    };
    expect(tableMarkdown(props)).toBe(
      "**Prices**\n\n| Name | USD |\n| --- | ---: |\n| A\\|B | 3 |"
    );
    const report = msg("r", "t", {
      parts: [
        { id: "1", type: "text", text: "### Findings" },
        { id: "2", type: "component", name: "Table", props, status: "ready", fallbackText: "x" },
      ],
    });
    expect(reportText(report)).toContain("| A\\|B | 3 |");
  });
});

describe("links", () => {
  it("opens only web and email links", async () => {
    expect(isOpenableUrl("https://example.com/a")).toBe(true);
    expect(isOpenableUrl("mailto:a@b.co")).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "tel:123",
      "file:///etc/passwd",
      "intent://x",
      "https://",
    ])
      expect(isOpenableUrl(bad)).toBe(false);
    await openLink("javascript:alert(1)");
    await openLink("sms:123");
    expect(Linking.openURL).not.toHaveBeenCalled();
    await openLink("mailto:a@b.co");
    expect(Linking.openURL).toHaveBeenCalledWith("mailto:a@b.co");
  });

  it("trusts image URLs only from the message's own photos and sources", () => {
    const trusted = trustedImageUrls([
      { id: "i", type: "image", uri: "https://cdn.example/p.jpg" },
      {
        id: "s",
        type: "sources",
        sources: [
          { id: "1", url: "https://site.example/x.png", title: "", snippet: "", origin: "app" },
        ],
      },
    ]);
    expect(trusted.has("https://cdn.example/p.jpg")).toBe(true);
    expect(trusted.has("https://site.example/x.png")).toBe(true);
    expect(trusted.has("https://evil.example/leak.png?d=secret")).toBe(false);
  });
});
