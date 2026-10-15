import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Thread } from "@/lib/types";

const mutation = vi.fn();

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Linking: { openURL: vi.fn(async () => {}) },
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock("expo-location", () => ({}));
/** Native uploads go through expo-file-system's UploadTask; each one waits on `fs.next`. */
const fs = vi.hoisted(() => ({
  next: Promise.resolve({ status: 200, body: '{"storageId":"st1"}', headers: {} }) as Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  }>,
  tasks: [] as { uri: string; url: string; headers: Record<string, string> }[],
}));
vi.mock("expo-file-system", () => ({
  File: class {
    type = "";
    constructor(public uri: string) {}
  },
  UploadTask: class {
    constructor(file: { uri: string }, url: string, options: { headers: Record<string, string> }) {
      fs.tasks.push({ uri: file.uri, url, headers: options.headers });
    }
    uploadAsync() {
      return fs.next;
    }
    release() {}
  },
}));
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
const { citationNumbers, citationsAfterPunctuation, isCitationRun, publisherName, stripCitations } =
  await import("@/lib/citations");
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
    const upload = deferred<{ status: number; body: string; headers: Record<string, string> }>();
    fs.next = upload.promise;
    fs.tasks = [];
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
    await vi.waitFor(() => expect(fs.tasks).toHaveLength(1));
    // A local file has no type of its own: the upload names one, or storage refuses it.
    expect(fs.tasks[0]).toMatchObject({
      uri: "file://a.jpg",
      url: "https://upload",
      headers: { "Content-Type": "image/jpeg" },
    });
    upload.resolve({ status: 200, body: JSON.stringify({ storageId: "st1" }), headers: {} });
    await vi.waitFor(() => expect(calls("messages.send")).toHaveLength(1));
    expect(calls("messages.send")[0][1].draft.incognito).toBe(true);
    expect(calls("attachments.register")[0][1]).toMatchObject({
      storageId: "st1",
      mime: "image/jpeg",
    });
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

  it("keeps showing a sent photo from the device when the server copy arrives", async () => {
    fs.next = Promise.resolve({ status: 200, body: '{"storageId":"st1"}', headers: {} });
    useApp.setState({ threads: { t1: thread("t1") }, messages: { t1: [] }, activeThreadId: "t1" });
    mutation.mockImplementation(async (name: string) =>
      name === "attachments.generateUploadUrl"
        ? "https://upload"
        : name === "messages.send"
          ? { threadId: "t1", userMessageId: "u1", messageId: "r1" }
          : null
    );
    useApp.getState().send("look", [{ uri: "file://a.jpg", width: 4, height: 3 }]);
    await vi.waitFor(() => expect(calls("messages.send")).toHaveLength(1));
    const server = (uri: string) => [
      msg("u1", "t1", {
        role: "user",
        parts: [
          { id: "img_1", type: "image", uri, width: 4, height: 3 },
          { id: "txt_1", type: "text", text: "look" },
        ],
      }),
      msg("r1", "t1", { status: "streaming", parts: [] }),
    ];
    useApp.getState().hydrateMessages("t1", server("https://storage/st1"));
    const first = useApp.getState().messages.t1[0];
    expect(first.parts[0]).toMatchObject({ type: "image", uri: "file://a.jpg" });
    // Later updates of the thread keep the same row object, so the photo doesn't redraw.
    useApp.getState().hydrateMessages("t1", server("https://storage/st1"));
    expect(useApp.getState().messages.t1[0]).toBe(first);
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

describe("citations", () => {
  it("reads every way a reply writes them as one run", () => {
    // verifyCitations writes several sources as [3, 5]; models also chain or use ranges.
    for (const run of [" [1]", "[1, 7]", " [3, 5, 7, 9]", "[1][7]", " [1] [7]", "[2–4]", "[1; 2]"])
      expect(isCitationRun(run)).toBe(true);
    for (const text of ["[a]", "[1, b]", "[]", "[2023 report]"])
      expect(isCitationRun(text)).toBe(false);
    expect(citationNumbers("[3, 5][5] [1]")).toEqual([3, 5, 1]);
    expect(citationNumbers("[2–4]")).toEqual([2, 3, 4]);
  });

  it("moves the pill after the sentence's punctuation", () => {
    expect(citationsAfterPunctuation("Newark, New Jersey [1, 7]. He was")).toBe(
      "Newark, New Jersey.[1, 7] He was"
    );
    expect(citationsAfterPunctuation("the 280 [3][5], with Moose [9].")).toBe(
      "the 280,[3][5] with Moose.[9]"
    );
    expect(citationsAfterPunctuation("Rated R [2] is his")).toBe("Rated R [2] is his");
  });

  it("leaves no markers in plain text", () => {
    expect(stripCitations("Newark, New Jersey [1, 7]. Big Moose 280 [3][5].")).toBe(
      "Newark, New Jersey. Big Moose 280."
    );
  });

  it("names the publisher the way it styles itself", () => {
    expect(
      publisherName("https://www.youtube.com/watch?v=x", "Qua Louie - Lotta Bars - YouTube")
    ).toBe("YouTube");
    expect(
      publisherName("https://genius.com/x", "Qua Louie – Free the Army Lyrics | Genius Lyrics")
    ).toBe("Genius");
    expect(
      publisherName(
        "https://soundcloud.com/x",
        "Stream XXL by Big Moose 280 | Listen online for free on SoundCloud"
      )
    ).toBe("SoundCloud");
    expect(
      publisherName("https://www.investing.com/news/x", "Ed Sheeran tour news | Investing.com")
    ).toBe("Investing.com");
    expect(
      publisherName("https://www.washingtonpost.com/x", "Ed Sheeran - The Washington Post")
    ).toBe("Washington Post");
    // No name in the title: the domain's own, capitalised, short ones as initials.
    expect(publisherName("https://www.complex.com/music/x", "Best albums of 2026")).toBe("Complex");
    expect(publisherName("https://www.bbc.co.uk/news/x", "Headline")).toBe("BBC");
  });
});
