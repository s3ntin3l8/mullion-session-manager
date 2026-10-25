import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  cli,
  deletedFiles,
  fallbackExecutableLines,
  isNonExecutableLine,
  isSourceFile,
  evaluatePatchCoverage,
  loadCoverageReports,
  nonExecutableLines,
  parseGitDiffHunks,
  resolveBaseRef,
  runPatchCoverageCheck,
} from "../../scripts/check-patch-coverage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("check-patch-coverage", () => {
  it("isSourceFile keeps coverable code and skips tests, specs and fixtures", () => {
    expect(isSourceFile("src/a.ts")).toBe(true);
    expect(isSourceFile("frontend/src/b.tsx")).toBe(true);
    expect(isSourceFile("src/a.test.ts")).toBe(false);
    expect(isSourceFile("frontend/src/b.spec.tsx")).toBe(false);
    expect(isSourceFile("src/fixtures/x.ts")).toBe(false);
    expect(isSourceFile("src/data.json")).toBe(false);
    expect(isSourceFile("docs/a.ts")).toBe(false);
  });

  it("deletedFiles lists only files the diff deletes", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const x = 1;",
      "diff --git a/src/kept.ts b/src/kept.ts",
      "--- a/src/kept.ts",
      "+++ b/src/kept.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
    ].join("\n");
    expect(deletedFiles(diff)).toEqual(["src/gone.ts"]);
    expect(deletedFiles("")).toEqual([]);
  });

  it("fails when the patch deletes every source file at the base (a damaged index)", () => {
    const del = (file: string) => [
      `diff --git a/${file} b/${file}`,
      "deleted file mode 100644",
      `--- a/${file}`,
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    ];
    const diffText = [...del("src/a.ts"), ...del("frontend/src/b.tsx")].join("\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        runPatchCoverageCheck({
          diffText,
          noRun: true,
          baseSourceFiles: ["src/a.ts", "frontend/src/b.tsx"],
        }),
      ).toEqual({ ok: false, overallPercent: 0, error: "index-damaged" });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("git index is damaged"));
      // Tests and fixtures at the base don't count: the coverable set is.
      expect(
        runPatchCoverageCheck({
          diffText,
          noRun: true,
          baseSourceFiles: ["src/a.ts", "frontend/src/b.tsx", "src/a.test.ts", "src/fixtures/x.ts"],
        }).error,
      ).toBe("index-damaged");
      // Deleting only some of them is a real (if unusual) patch.
      const partial = runPatchCoverageCheck({
        diffText,
        noRun: true,
        baseSourceFiles: ["src/a.ts", "frontend/src/b.tsx", "src/kept.ts"],
      });
      expect(partial.ok).toBe(true);
    } finally {
      error.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("warns instead of passing silently when the patch only deletes source files", () => {
    const diffText = [
      "diff --git a/src/app.ts b/src/app.ts",
      "deleted file mode 100644",
      "--- a/src/app.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    ].join("\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(runPatchCoverageCheck({ diffText, noRun: true }).ok).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("index may be damaged"));
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("parses git diff hunks into file line sets, ignoring tests and non-src files", () => {
    const diff = `
diff --git a/src/services/example.ts b/src/services/example.ts
--- a/src/services/example.ts
+++ b/src/services/example.ts
@@ -10,2 +10,3 @@
+line1
+line2
+line3
@@ -30 +31,1 @@
+line31
diff --git a/test/services/example.test.ts b/test/services/example.test.ts
--- a/test/services/example.test.ts
+++ b/test/services/example.test.ts
@@ -1,3 +1,3 @@
+test line
diff --git a/docs/README.md b/docs/README.md
--- a/docs/README.md
+++ b/docs/README.md
@@ -5 +5 @@
+docs line
    `.trim();

    const result = parseGitDiffHunks(diff);
    expect(result.size).toBe(1);
    expect(result.has("src/services/example.ts")).toBe(true);
    const lines = result.get("src/services/example.ts");
    expect(lines).toEqual(new Set([10, 11, 12, 31]));
  });

  it("evaluates coverage correctly when statements are covered or uncovered", () => {
    const modifiedFiles = new Map([["src/services/example.ts", new Set([10, 11, 12, 20])]]);

    const coverageData = {
      "src/services/example.ts": {
        statementMap: {
          "0": { start: { line: 10, column: 0 }, end: { line: 10, column: 20 } },
          "1": { start: { line: 11, column: 0 }, end: { line: 11, column: 20 } },
          "2": { start: { line: 12, column: 0 }, end: { line: 12, column: 20 } },
          // line 20 has no statement (e.g. comment / blank line)
        },
        s: {
          "0": 5,
          "1": 0,
          "2": 2,
        },
      },
    };

    const summary = evaluatePatchCoverage(modifiedFiles, coverageData);
    expect(summary.totalExecutableLines).toBe(3);
    expect(summary.totalCoveredLines).toBe(2);
    expect(summary.overallPercent).toBeCloseTo(66.67, 1);
    expect(summary.results[0].uncoveredLines).toEqual([11]);
  });

  it("handles 100% patch coverage when all executable lines are hit", () => {
    const modifiedFiles = new Map([["src/services/example.ts", new Set([5, 6])]]);

    const coverageData = {
      "src/services/example.ts": {
        statementMap: {
          "0": { start: { line: 5, column: 0 }, end: { line: 5, column: 20 } },
          "1": { start: { line: 6, column: 0 }, end: { line: 6, column: 20 } },
        },
        s: {
          "0": 1,
          "1": 3,
        },
      },
    };

    const summary = evaluatePatchCoverage(modifiedFiles, coverageData);
    expect(summary.totalExecutableLines).toBe(2);
    expect(summary.totalCoveredLines).toBe(2);
    expect(summary.overallPercent).toBe(100);
    expect(summary.results[0].uncoveredLines).toEqual([]);
  });

  it("handles 0 executable lines as 100% coverage", () => {
    const modifiedFiles = new Map([["src/services/types.ts", new Set([1, 2, 3])]]);

    const coverageData = {
      "src/services/types.ts": {
        statementMap: {},
        s: {},
      },
    };

    const summary = evaluatePatchCoverage(modifiedFiles, coverageData);
    expect(summary.totalExecutableLines).toBe(0);
    expect(summary.overallPercent).toBe(100);
  });

  it("skips non-executable lines (imports, types, comments, braces) in no-coverage fallback", () => {
    // Test that the fallback correctly skips non-executable lines when reading an actual file
    const modifiedFiles = new Map([["src/shared/types.ts", new Set([1, 2, 3, 4, 5])]]);

    // No coverage data for this file
    const summary = evaluatePatchCoverage(modifiedFiles, {});
    // All lines in types.ts are imports/types/interfaces, so 0 executable lines
    expect(summary.totalExecutableLines).toBe(0);
    expect(summary.overallPercent).toBe(100);
  });

  // Issue #1899 — the fallback guessed "is this line executable?" from the
  // line's OWN first characters, so the BODY of a multi-line type
  // declaration counted as uncovered executable code, and so did the
  // continuation lines of a multi-line import. A type-only module reported
  // "0/6 uncovered" for six lines that hold no executable statement at all.
  it("nonExecutableLines marks a multi-line type declaration's body, not just its first line", () => {
    const source = [
      "export interface Example {",
      "  a: string;",
      "  b: number;",
      "}",
      "",
      "export const real = 1;",
    ].join("\n");

    const lines = nonExecutableLines(source, "src/example.ts");
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    // The statement below it is executable, and must NOT be marked.
    expect(lines.has(6)).toBe(false);
  });

  it("nonExecutableLines marks the continuation lines of a multi-line import", () => {
    const source = [
      "import type {",
      "  Alpha,",
      "  Beta,",
      '} from "./somewhere.js";',
      "",
      "const real = 1;",
    ].join("\n");

    const lines = nonExecutableLines(source, "src/example.ts");
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(lines.has(6)).toBe(false);
  });

  it("nonExecutableLines marks a type alias body and a type-only export", () => {
    const source = [
      "export type Alias = {",
      "  c: boolean;",
      "};",
      "",
      "export type { Alpha, Beta };",
      "",
      "const real = 1;",
    ].join("\n");

    const lines = nonExecutableLines(source, "src/example.ts");
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 5]);
    expect(lines.has(7)).toBe(false);
  });

  it("nonExecutableLines marks an ambient declaration, which has no runtime code", () => {
    // `declare module "x" { … }` is a type-only declaration — the header
    // line was the last shape the old heuristic counted as executable
    // (src/plugins/db.ts's `declare module "fastify"`).
    const source = [
      'declare module "fastify" {',
      "  interface FastifyInstance {",
      "    db: string;",
      "  }",
      "}",
      "",
      "export const real = 1;",
    ].join("\n");

    const lines = nonExecutableLines(source, "src/example.ts");
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(lines.has(7)).toBe(false);
  });

  it("nonExecutableLines marks a plain value import, and leaves a statement alone", () => {
    const source = ["import { thing } from './thing.js';", "", "thing();"].join("\n");
    const lines = nonExecutableLines(source, "src/example.ts");
    expect([...lines].sort((a, b) => a - b)).toEqual([1]);
    expect(lines.has(3)).toBe(false);
  });

  it("fallbackExecutableLines does not count a type declaration's body as executable", () => {
    const source = ["export interface Example {", "  a: string;", "}"].join("\n");
    expect(fallbackExecutableLines(source, "src/example.ts", [1, 2, 3])).toEqual([]);
  });

  it("fallbackExecutableLines still counts a real statement in a no-coverage file", () => {
    // The gate must not get weaker: code that was never measured is still
    // uncovered.
    const source = [
      "export interface Example {",
      "  a: string;",
      "}",
      "",
      "export const real = 1;",
    ].join("\n");
    expect(fallbackExecutableLines(source, "src/example.ts", [1, 2, 3, 5])).toEqual([5]);
  });

  it("evaluatePatchCoverage reports a type-only file as having no executable lines", () => {
    // The bug's exact symptom, end to end: a file the coverage provider
    // never loaded (every import of a type-only module is erased), whose
    // changed lines are all inside type declarations.
    const relPath = "test/fixtures/patch-coverage-type-only.ts";
    const lineCount = readFileSync(path.join(root, relPath), "utf8").split("\n").length;
    const changed = new Set(Array.from({ length: lineCount }, (_, i) => i + 1));

    const summary = evaluatePatchCoverage(new Map([[relPath, changed]]), {});
    expect(summary.totalExecutableLines).toBe(0);
    expect(summary.overallPercent).toBe(100);
  });

  it("isNonExecutableLine keeps the original line heuristic", () => {
    expect(isNonExecutableLine("")).toBe(true);
    expect(isNonExecutableLine("  // a comment")).toBe(true);
    expect(isNonExecutableLine("import { x } from './x.js';")).toBe(true);
    expect(isNonExecutableLine("export type X = string;")).toBe(true);
    expect(isNonExecutableLine("export interface X {")).toBe(true);
    expect(isNonExecutableLine("}")).toBe(true);
    expect(isNonExecutableLine("export const x = 1;")).toBe(false);
  });

  it("resolveBaseRef returns sanitized explicitRef if provided", () => {
    expect(resolveBaseRef("feature-branch")).toBe("feature-branch");
    expect(resolveBaseRef("origin/main")).toBe("origin/main");
    expect(resolveBaseRef("HEAD~1")).toBe("HEAD~1");
    // Invalid characters rejected and falls back
    expect(resolveBaseRef("bad;rm -rf")).not.toBe("bad;rm -rf");
  });

  it("resolveBaseRef honors PATCH_BASE_REF environment variable", () => {
    const old = process.env.PATCH_BASE_REF;
    try {
      process.env.PATCH_BASE_REF = "origin/main";
      expect(resolveBaseRef()).toBe("origin/main");
    } finally {
      process.env.PATCH_BASE_REF = old;
    }
  });

  it("loadCoverageReports reads coverage data if available", () => {
    const data = loadCoverageReports();
    expect(typeof data).toBe("object");
  });

  it("runPatchCoverageCheck executes cleanly with no-run option against HEAD", () => {
    const res = runPatchCoverageCheck({ baseRef: "HEAD", threshold: 0.0, noRun: true });
    expect(res.ok).toBe(true);
  });

  it("CLI executes successfully with --base HEAD", () => {
    const scriptPath = path.join(root, "scripts/check-patch-coverage.mjs");
    const output = execFileSync(
      "node",
      [scriptPath, "--base", "HEAD", "--threshold", "0", "--no-run"],
      {
        encoding: "utf8",
      },
    );
    expect(output).toMatch(/Patch [Cc]overage/);
  });

  it("cli returns 0 when threshold is satisfied", () => {
    expect(cli(["--base", "HEAD", "--threshold", "0", "--no-run"])).toBe(0);
  });

  it("cli returns 1 when threshold is not satisfied", () => {
    const mockDiff = `
diff --git a/src/services/task-reconciler.ts b/src/services/task-reconciler.ts
--- a/src/services/task-reconciler.ts
+++ b/src/services/task-reconciler.ts
@@ -10,0 +11,5 @@
+const a = 1;
+const b = 2;
`;
    expect(cli(["--threshold", "101", "--no-run"], { diffText: mockDiff })).toBe(1);
  });

  it("runPatchCoverageCheck returns ok: false when baseRef cannot be resolved", () => {
    const res = runPatchCoverageCheck({ baseRef: "non-existent-ref-xyz-12345", noRun: true });
    expect(res.ok).toBe(false);
  });
});
