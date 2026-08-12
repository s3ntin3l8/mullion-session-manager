// Was piggybacked on SessionRow.test.tsx (the sole consumer of
// parseUnifiedDiff is FileChanges.tsx's SessionFileDiff, formerly SessionRow's
// own module-scope helper) — moved to its own file alongside diffUtils.ts
// as part of splitting that 1912-line test file (PR 27 phase 2, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md). Pure-function tests, no DOM
// needed — default (node) vitest environment, unlike the jsdom-flagged
// component test files elsewhere in this directory.
import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "./diffUtils.js";

describe("parseUnifiedDiff", () => {
  it("classifies added lines as 'add'", () => {
    expect(parseUnifiedDiff("+added line")).toEqual([{ type: "add", text: "+added line" }]);
  });

  it("classifies '+++ ' file-header lines as 'file'", () => {
    expect(parseUnifiedDiff("+++ b/path/to/file.ts")).toEqual([
      { type: "file", text: "+++ b/path/to/file.ts" },
    ]);
  });

  it("classifies deleted lines as 'del'", () => {
    expect(parseUnifiedDiff("-removed line")).toEqual([{ type: "del", text: "-removed line" }]);
  });

  it("classifies '--- ' file-header lines as 'file'", () => {
    expect(parseUnifiedDiff("--- a/path/to/file.ts")).toEqual([
      { type: "file", text: "--- a/path/to/file.ts" },
    ]);
  });

  it("classifies hunk headers (@@) as 'hunk'", () => {
    expect(parseUnifiedDiff("@@ -1,4 +1,5 @@")).toEqual([
      { type: "hunk", text: "@@ -1,4 +1,5 @@" },
    ]);
  });

  it("classifies 'diff --git' lines as 'file'", () => {
    expect(parseUnifiedDiff("diff --git a/file.ts b/file.ts")).toEqual([
      { type: "file", text: "diff --git a/file.ts b/file.ts" },
    ]);
  });

  it("classifies unmarked context lines as 'context'", () => {
    expect(parseUnifiedDiff("  unchanged context line")).toEqual([
      { type: "context", text: "  unchanged context line" },
    ]);
  });

  it("handles a full unified diff patch", () => {
    const patch = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,4 +1,5 @@",
      " unchanged",
      "+added",
      "-removed",
      " more context",
    ].join("\n");
    expect(parseUnifiedDiff(patch)).toEqual([
      { type: "file", text: "diff --git a/src/foo.ts b/src/foo.ts" },
      { type: "file", text: "--- a/src/foo.ts" },
      { type: "file", text: "+++ b/src/foo.ts" },
      { type: "hunk", text: "@@ -1,4 +1,5 @@" },
      { type: "context", text: " unchanged" },
      { type: "add", text: "+added" },
      { type: "del", text: "-removed" },
      { type: "context", text: " more context" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
