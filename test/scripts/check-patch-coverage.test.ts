import { describe, expect, it } from "vitest";
import {
  evaluatePatchCoverage,
  parseGitDiffHunks,
  resolveBaseRef,
} from "../../scripts/check-patch-coverage.mjs";

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

  it("resolveBaseRef returns explicitRef if provided", () => {
    expect(resolveBaseRef("feature-branch")).toBe("feature-branch");
  });
});
