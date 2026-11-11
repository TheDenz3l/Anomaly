import { describe, expect, it } from "vitest";
import { documentsIn, fileFor, isDocument, parseFenceInfo, readFence } from "@/lib/docFiles";

describe("parseFenceInfo", () => {
  it("reads the language and the file name in the forms models write", () => {
    expect(parseFenceInfo("markdown PRD.md")).toEqual({ lang: "markdown", name: "PRD.md" });
    expect(parseFenceInfo('md title="PRD.md"')).toEqual({ lang: "md", name: "PRD.md" });
    expect(parseFenceInfo("json file=data.json")).toEqual({ lang: "json", name: "data.json" });
    expect(parseFenceInfo("markdown:notes.md")).toEqual({ lang: "markdown", name: "notes.md" });
    expect(parseFenceInfo("PRD.md")).toEqual({ lang: "", name: "PRD.md" });
    expect(parseFenceInfo("python")).toEqual({ lang: "python", name: undefined });
    expect(parseFenceInfo("")).toEqual({ lang: "" });
  });

  it("keeps the base name and refuses names that aren't files", () => {
    expect(parseFenceInfo("md docs/PRD.md").name).toBe("PRD.md");
    expect(parseFenceInfo("md ../../etc").name).toBeUndefined();
    expect(parseFenceInfo("js").name).toBeUndefined();
  });
});

describe("fileFor", () => {
  it("names an unnamed Markdown document after its heading", () => {
    const f = fileFor({ lang: "markdown" }, "# PRD — Wayfarer\n\nBody");
    expect(f).toMatchObject({ name: "PRD-Wayfarer.md", mime: "text/markdown", named: false });
  });

  it("maps languages and names to types", () => {
    expect(fileFor({ lang: "python" }, "print(1)")).toMatchObject({ name: "snippet.py" });
    expect(fileFor({ lang: "csv", name: "budget.csv" }, "a,b")).toMatchObject({
      ext: "csv",
      mime: "text/csv",
      named: true,
    });
  });

  it("treats named fences and long prose fences as documents", () => {
    expect(isDocument(fileFor({ lang: "js", name: "a.js" }, "x"), "x")).toBe(true);
    expect(isDocument(fileFor({ lang: "js" }, "x"), "x")).toBe(false);
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(isDocument(fileFor({ lang: "markdown" }, long), long)).toBe(true);
  });
});

describe("readFence", () => {
  it("keeps code blocks inside a Markdown document", () => {
    const lines = [
      "```markdown README.md",
      "# App",
      "```bash",
      "npm install",
      "```",
      "Done.",
      "```",
      "after",
    ];
    const f = readFence(lines, 0)!;
    expect(f.closed).toBe(true);
    expect(f.body).toBe("# App\n```bash\nnpm install\n```\nDone.");
    expect(lines[f.next]).toBe("after");
  });

  it("closes a four-backtick fence only on four or more", () => {
    const f = readFence(["````md a.md", "```", "x", "```", "````"], 0)!;
    expect(f.body).toBe("```\nx\n```");
    expect(f.closed).toBe(true);
  });

  it("reports a fence still being written", () => {
    expect(readFence(["```json", "{"], 0)).toMatchObject({ closed: false, body: "{" });
  });
});

describe("documentsIn", () => {
  it("lists the finished documents in a reply, not plain snippets", () => {
    const text = [
      "Here it is.",
      "```markdown PRD.md",
      "# PRD",
      "```",
      "And a tip:",
      "```js",
      "x()",
      "```",
    ].join("\n");
    const docs = documentsIn(text);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ name: "PRD.md", body: "# PRD" });
  });
});
