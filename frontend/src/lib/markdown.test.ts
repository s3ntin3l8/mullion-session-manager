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
      "break", // blank line closing the Critical list before ### Warnings
      "heading", // ### Warnings
      "bullet", // - None
      "break", // blank line closing the Warnings list before ## Round 2
      "heading", // ## Round 2
      "paragraph", // **Verdict:** clean
    ]);
    expect(blocks[8]).toEqual({
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
      .flatMap((b) => (b.type === "paragraph" ? b.lines.flat() : b.type === "break" ? [] : b.spans))
      .map((s) => s.text)
      .join("\n");
    for (const line of src.split("\n")) {
      expect(allText).toContain(line);
    }
    // The fence markers are not recognized as anything special -- literal text.
    expect(blocks.some((b) => b.type === "paragraph" && JSON.stringify(b).includes("```ts"))).toBe(
      true,
    );
    // No structural block was manufactured out of any fence-internal line.
    expect(blocks.some((b) => b.type === "heading" || b.type === "bullet")).toBe(false);
  });

  // Hermes review, PR #1000 — the fence-fallthrough guarantee above only
  // held for content that ALSO didn't look like markdown structure. Real
  // unstructured escape-hatch content (see this module's own header) can
  // legitimately reproduce a repro command like `## config` or a CLI flag
  // list like `- run --flag`, which the parser used to reinterpret as an
  // actual heading/bullet rather than leaving as code.
  it("does not reinterpret heading/bullet-shaped lines inside a fenced code block", () => {
    const src = ["```", "## config", "- run --flag", "```"].join("\n");
    const blocks = parseSimpleMarkdown(src);
    expect(blocks.every((b) => b.type === "paragraph")).toBe(true);
    const allText = blocks
      .flatMap((b) => (b.type === "paragraph" ? b.lines.flat() : []))
      .map((s) => s.text)
      .join("\n");
    expect(allText).toContain("## config");
    expect(allText).toContain("- run --flag");
  });

  it("preserves a blank line inside a fence verbatim, without splitting into two paragraph blocks", () => {
    const src = ["```", "line one", "", "line two", "```"].join("\n");
    const blocks = parseSimpleMarkdown(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  // Hermes review, PR #1000 (Suggestion) — CommonMark closes and reopens a
  // list across a blank line; the pre-fix renderer merged both runs into
  // one <ul> because the parser dropped the blank line with no trace.
  it("marks a blank line between two bullet runs with a break block, not silently dropping it", () => {
    const src = ["- one", "", "- two"].join("\n");
    const blocks = parseSimpleMarkdown(src);
    expect(blocks.map((b) => b.type)).toEqual(["bullet", "break", "bullet"]);
  });

  it("does not insert a break block for a blank line that isn't between two bullet runs", () => {
    expect(parseSimpleMarkdown(["para one", "", "para two"].join("\n")).map((b) => b.type)).toEqual(
      ["paragraph", "paragraph"],
    );
  });

  it("does not match an unterminated ** as bold", () => {
    expect(parseSimpleMarkdown("5 ** 2 is not bold")).toEqual([
      { type: "paragraph", lines: [[{ type: "text", text: "5 ** 2 is not bold" }]] },
    ]);
  });
});
