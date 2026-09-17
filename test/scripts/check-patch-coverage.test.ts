import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cli,
  evaluatePatchCoverage,
  loadCoverageReports,
  parseGitDiffHunks,
  resolveBaseRef,
  runPatchCoverageCheck,
} from "../../scripts/check-patch-coverage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("check-patch-coverage", () => {
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
    expect(output).toContain("Patch coverage:");
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
});
