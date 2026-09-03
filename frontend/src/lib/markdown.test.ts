// Issue #990 — pure-function tests, no DOM needed (default node vitest
// environment), same posture as diffUtils.test.ts.
import { describe, it, expect } from "vitest";
import { parseSimpleMarkdown } from "./markdown.js";

describe("parseSimpleMarkdown", () => {
  it("returns an empty array for an empty string", () => {
    expect(parseSimpleMarkdown("")).toEqual([]);
  });

  it("parses a ## heading", () => {
    expect(parseSimpleMarkdown("## Round 1")).toEqual([
      { type: "heading", level: 2, spans: [{ type: "text", text: "Round 1" }] },
    ]);
  });

  it("parses a ### heading", () => {
    expect(parseSimpleMarkdown("### Critical")).toEqual([
      { type: "heading", level: 3, spans: [{ type: "text", text: "Critical" }] },
    ]);
  });

  it("does not treat a #### (4+ hash) line as a heading", () => {
    const blocks = parseSimpleMarkdown("#### Not a heading");
    expect(blocks).toEqual([
      { type: "paragraph", lines: [[{ type: "text", text: "#### Not a heading" }]] },
    ]);
  });

  it("parses a flat bullet", () => {
    expect(parseSimpleMarkdown("- a plain bullet")).toEqual([
      { type: "bullet", spans: [{ type: "text", text: "a plain bullet" }] },
    ]);
  });

  it("parses **bold** and inline `code` within a bullet", () => {
    const blocks = parseSimpleMarkdown(
      "- [blocker] **cmd/branchdam/main_test.go:669** — `defer occupied.Close()` ignores its error return.",
    );
    expect(blocks).toEqual([
      {
        type: "bullet",
        spans: [
          { type: "text", text: "[blocker] " },
          { type: "bold", text: "cmd/branchdam/main_test.go:669" },
          { type: "text", text: " — " },
          { type: "code", text: "defer occupied.Close()" },
          { type: "text", text: " ignores its error return." },
        ],
      },
    ]);
  });

  it("groups consecutive non-blank plain lines into one paragraph block", () => {
    const blocks = parseSimpleMarkdown("line one\nline two");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        lines: [[{ type: "text", text: "line one" }], [{ type: "text", text: "line two" }]],
      },
    ]);
  });

  it("splits paragraphs on a blank line", () => {
    const blocks = parseSimpleMarkdown("first\n\nsecond");
    expect(blocks).toEqual([
      { type: "paragraph", lines: [[{ type: "text", text: "first" }]] },
      { type: "paragraph", lines: [[{ type: "text", text: "second" }]] },
    ]);
  });

  it("renders a full multi-round structured review as the expected block sequence", () => {
    const src = [
      "## Round 1",
      "",
      "**Verdict:** changes requested — One blocker and a nit.",
      "",
      "### Critical",
      "- [blocker] **cmd/branchdam/main_test.go:669** — `defer occupied.Close()` ignores its error return.",
      "",
      "### Warnings",
      "- None",
      "",
      "## Round 2",
      "",
      "**Verdict:** clean",
    ].join("\n");
    const blocks = parseSimpleMarkdown(src);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading", // ## Round 1
      "paragraph", // **Verdict:** ...
      "heading", // ### Critical
      "bullet",
      "heading", // ### Warnings
      "bullet", // - None
      "heading", // ## Round 2
      "paragraph", // **Verdict:** clean
    ]);
    expect(blocks[6]).toEqual({
      type: "heading",
      level: 2,
      spans: [{ type: "text", text: "Round 2" }],
    });
  });

  it("falls through unrecognized constructs (a fenced code block) as literal paragraph text, never dropped", () => {
    const src = ["Reproduces with:", "```ts", "const x = 1;", "```", "That's the bug."].join("\n");
    const blocks = parseSimpleMarkdown(src);
    // Every source line survives somewhere, verbatim, none silently dropped.
    const allText = blocks
      .flatMap((b) => (b.type === "paragraph" ? b.lines.flat() : b.spans))
      .map((s) => s.text)
      .join("\n");
    for (const line of src.split("\n")) {
      expect(allText).toContain(line);
    }
    // The fence markers are not recognized as anything special -- literal text.
    expect(blocks.some((b) => b.type === "paragraph" && JSON.stringify(b).includes("```ts"))).toBe(
      true,
    );
  });

  it("does not match an unterminated ** as bold", () => {
    expect(parseSimpleMarkdown("5 ** 2 is not bold")).toEqual([
      { type: "paragraph", lines: [[{ type: "text", text: "5 ** 2 is not bold" }]] },
    ]);
  });
});
