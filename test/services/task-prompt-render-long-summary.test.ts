import { describe, it, expect } from "vitest";
import {
  parseReviewFindings,
  renderReviewFindingsMarkdown,
} from "../../src/services/task-prompt.js";

describe("renderReviewFindingsMarkdown with a long structured summary", () => {
  it("keeps the sections when a long summary sits beside findings, verified and looksGood", () => {
    const longSummary =
      "Reviewed the full diff across every changed file and the verdict follows. ".repeat(5);
    expect(longSummary.length).toBeGreaterThan(300);
    const parsed = parseReviewFindings(
      JSON.stringify({
        verdict: "approved",
        summary: longSummary,
        findings: [{ severity: "suggestion", path: "src/a.ts", line: 3, body: "Tidy this." }],
        verified: ["ran make lint"],
        looksGood: ["clean types"],
      }),
    );
    expect(parsed.verdict).toBe("approved-with-suggestions");
    const comment = renderReviewFindingsMarkdown(parsed);
    expect(comment).toContain(`**Verdict:** approved with suggestions — ${longSummary}`);
    expect(comment).toContain("### Verified\n- ran make lint");
    expect(comment).toContain("### Looks Good\n- clean types");
    expect(comment).toContain("**src/a.ts:3**");
    const body = renderReviewFindingsMarkdown(parsed, "review-body");
    expect(body).toContain("- 1 finding(s) anchored inline below");
  });
});
