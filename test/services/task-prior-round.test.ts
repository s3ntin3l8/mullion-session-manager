import { describe, expect, it } from "vitest";
import { priorRoundFor } from "../../src/services/task-prior-round.js";
import type { tasks } from "../../src/db/schema.js";

const FINDINGS = "## Round 1\n\n**Verdict:** changes requested\n\n\n## Round 2\n\nstill broken";
const VERDICT_AT = new Date("2026-01-01T00:00:00Z");

function task(over: Partial<typeof tasks.$inferSelect> = {}) {
  return {
    reviewFindings: FINDINGS,
    lastReviewVerdict: "changes-requested",
    lastReviewVerdictAt: VERDICT_AT,
    lastReviewedHeadSha: "aaa",
    claimedAt: new Date("2025-12-31T00:00:00Z"),
    ...over,
  } as typeof tasks.$inferSelect;
}

describe("priorRoundFor", () => {
  it("is the last round, for a follow-up review of a head that moved", () => {
    const prior = priorRoundFor(task(), "bbb");
    expect(prior).toMatchObject({ reviewedSha: "aaa", approved: false });
    expect(prior!.findings).toContain("Round 2");
  });

  it("marks an approved-with-suggestions round as approved", () => {
    const prior = priorRoundFor(task({ lastReviewVerdict: "approved-with-suggestions" }), "bbb");
    expect(prior?.approved).toBe(true);
  });

  it("is undefined for a first review, an inconclusive one, and a clean one", () => {
    expect(priorRoundFor(task({ reviewFindings: null }), "bbb")).toBeUndefined();
    expect(priorRoundFor(task({ lastReviewVerdict: "inconclusive" }), "bbb")).toBeUndefined();
    expect(priorRoundFor(task({ lastReviewVerdict: "clean" }), "bbb")).toBeUndefined();
  });

  it("is undefined on an unmoved head when no worker has run since — a human's re-review", () => {
    // A follow-up prompt on unchanged code can only re-derive the same verdict.
    expect(priorRoundFor(task(), "aaa")).toBeUndefined();
  });

  it("stays a follow-up on an unmoved head when a worker round ran since the verdict", () => {
    // The auto-return loop's round that pushed nothing: its stall detection needs the dispositions.
    const worker = task({ claimedAt: new Date("2026-01-02T00:00:00Z") });
    expect(priorRoundFor(worker, "aaa")).toMatchObject({ reviewedSha: "aaa" });
  });

  it("stays a follow-up when the caller does not know the head", () => {
    expect(priorRoundFor(task())).toMatchObject({ reviewedSha: "aaa" });
    expect(priorRoundFor(task(), null)).toMatchObject({ reviewedSha: "aaa" });
  });
});
