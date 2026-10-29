import { describe, expect, it } from "vitest";
import {
  derivePrPhase,
  diffPrSnapshots,
  snapshotPr,
  type PrPhaseInput,
  type PrSnapshot,
} from "../../src/services/github-pr-phase.js";

const base: PrPhaseInput = {
  reviewStateKnown: true,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  requestedReviewers: [],
  reviewers: [],
  ciStatus: "success",
};

describe("derivePrPhase", () => {
  it("is ready_to_merge when approved, mergeable and CI is green", () => {
    expect(derivePrPhase(base)).toBe("ready_to_merge");
  });

  it("treats a draft as draft regardless of everything else", () => {
    expect(derivePrPhase({ ...base, isDraft: true, ciStatus: "failure" })).toBe("draft");
  });

  it("ranks conflicts above red CI, and red CI above review state", () => {
    expect(derivePrPhase({ ...base, mergeable: "CONFLICTING", ciStatus: "failure" })).toBe(
      "conflicts",
    );
    expect(
      derivePrPhase({ ...base, ciStatus: "failure", reviewDecision: "CHANGES_REQUESTED" }),
    ).toBe("ci_failing");
  });

  it("maps review decisions", () => {
    expect(derivePrPhase({ ...base, reviewDecision: "CHANGES_REQUESTED" })).toBe(
      "changes_requested",
    );
    expect(derivePrPhase({ ...base, reviewDecision: "REVIEW_REQUIRED" })).toBe("review_pending");
  });

  it("a landed COMMENTED review with no approval is `reviewed`, only where it was review_pending", () => {
    const commented = { reviewers: [], hasCommentedReview: true };
    expect(derivePrPhase({ ...base, reviewDecision: "REVIEW_REQUIRED", ...commented })).toBe(
      "reviewed",
    );
    expect(
      derivePrPhase({
        ...base,
        reviewDecision: null,
        requestedReviewers: ["a"],
        ...commented,
      }),
    ).toBe("reviewed");
    expect(
      derivePrPhase({
        ...base,
        reviewDecision: null,
        mergeStateStatus: "BLOCKED",
        ...commented,
      }),
    ).toBe("reviewed");
    // An approval alongside the comment is not "no approval".
    expect(
      derivePrPhase({
        ...base,
        reviewDecision: "REVIEW_REQUIRED",
        hasCommentedReview: true,
        reviewers: [{ state: "APPROVED" }],
      }),
    ).toBe("review_pending");
    // Merge gating is untouched: a comment never turns ready_to_merge into anything else.
    expect(derivePrPhase({ ...base, reviewDecision: null, ...commented })).toBe("ready_to_merge");
  });

  it("waits on CI when approved but runs are still in progress", () => {
    expect(derivePrPhase({ ...base, ciStatus: "in_progress" })).toBe("ci_pending");
  });

  it("with no review requirement, requested reviewers still mean review_pending", () => {
    expect(derivePrPhase({ ...base, reviewDecision: null, requestedReviewers: ["octocat"] })).toBe(
      "review_pending",
    );
    expect(derivePrPhase({ ...base, reviewDecision: null })).toBe("ready_to_merge");
  });

  it("sees a changes-requested review even when no review rule makes reviewDecision null", () => {
    expect(
      derivePrPhase({
        ...base,
        reviewDecision: null,
        reviewers: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }],
      }),
    ).toBe("changes_requested");
    // An APPROVED decision from GitHub's own rollup wins over stale reviewers.
    expect(derivePrPhase({ ...base, reviewers: [{ state: "CHANGES_REQUESTED" }] })).toBe(
      "ready_to_merge",
    );
  });

  it("treats a BLOCKED merge state as review_pending unless CI is the blocker", () => {
    expect(derivePrPhase({ ...base, mergeStateStatus: "BLOCKED" })).toBe("review_pending");
    expect(derivePrPhase({ ...base, mergeStateStatus: "BLOCKED", ciStatus: "in_progress" })).toBe(
      "ci_pending",
    );
  });

  it("a recovered block outranks GitHub's decision, which never saw it", () => {
    const approved = { ...base, reviewDecision: "APPROVED" as const };
    expect(
      derivePrPhase({ ...approved, reviewers: [{ state: "CHANGES_REQUESTED", recovered: true }] }),
    ).toBe("changes_requested");
    // Whereas GitHub's own word still wins over an opinionated reviewer's.
    expect(derivePrPhase({ ...approved, reviewers: [{ state: "CHANGES_REQUESTED" }] })).toBe(
      "ready_to_merge",
    );
  });

  it("says unknown, not waiting, when the thread lookup did not answer", () => {
    const blocked = { ...base, mergeStateStatus: "BLOCKED" };
    expect(derivePrPhase({ ...blocked, unresolvedThreads: null })).toBe("unknown");
    // A caller that does not track threads at all keeps its behaviour.
    expect(derivePrPhase({ ...blocked })).toBe("review_pending");
    expect(derivePrPhase({ ...blocked, unresolvedThreads: 0 })).toBe("review_pending");
  });

  it("does not blame conversations when CI was never read", () => {
    const blocked = { ...base, mergeStateStatus: "BLOCKED", unresolvedThreads: 2 };
    expect(derivePrPhase({ ...blocked, ciStatus: null, ciFetched: false })).toBe("unknown");
    expect(derivePrPhase({ ...blocked, ciStatus: null, ciFetched: true })).toBe(
      "threads_unresolved",
    );
  });

  it("names open conversations as the block when nothing else is missing", () => {
    const blocked = { ...base, mergeStateStatus: "BLOCKED", unresolvedThreads: 2 };
    expect(derivePrPhase(blocked)).toBe("threads_unresolved");
    expect(derivePrPhase({ ...blocked, reviewDecision: "REVIEW_REQUIRED" })).toBe("review_pending");
    expect(derivePrPhase({ ...blocked, ciStatus: "in_progress" })).toBe("ci_pending");
    expect(derivePrPhase({ ...blocked, unresolvedThreads: 0 })).toBe("review_pending");
    expect(derivePrPhase({ ...base, unresolvedThreads: 2 })).toBe("ready_to_merge");
  });

  it("names a strict-protection BEHIND head as the next step; only draft, conflicts, CI and review outrank it", () => {
    const behind = { ...base, mergeStateStatus: "BEHIND" };
    expect(derivePrPhase(behind)).toBe("behind");
    expect(derivePrPhase({ ...behind, unresolvedThreads: 2 })).toBe("behind");
    expect(derivePrPhase({ ...behind, reviewDecision: "REVIEW_REQUIRED" })).toBe("review_pending");
    expect(derivePrPhase({ ...behind, ciStatus: "failure" })).toBe("ci_failing");
    expect(derivePrPhase({ ...behind, ciStatus: "in_progress" })).toBe("ci_pending");
    expect(derivePrPhase({ ...behind, mergeable: "CONFLICTING" })).toBe("conflicts");
    // Non-strict repos do not report BEHIND: a genuinely behind head there reads
    // BLOCKED (observed on this repo's own #2276/#2278/#2279, behind_by 1-2), so
    // they cannot reach this phase; ancestry (behindBy) drives the optional icon.
  });

  it("lets an ancestry answer of 0 overrule GitHub's collapsed BEHIND (lazygit#5975)", () => {
    const behind = { ...base, mergeStateStatus: "BEHIND" };
    expect(derivePrPhase({ ...behind, behindBy: 0 })).toBe("ready_to_merge");
    // Open conversations still block once the BEHIND is discounted.
    expect(derivePrPhase({ ...behind, behindBy: 0, unresolvedThreads: 2 })).toBe(
      "threads_unresolved",
    );
    // Genuinely behind, or no answer: stays behind (never claim ready on a failed lookup).
    expect(derivePrPhase({ ...behind, behindBy: 2 })).toBe("behind");
    expect(derivePrPhase({ ...behind, behindBy: null })).toBe("behind");
    // behindBy only matters for a BEHIND head.
    expect(derivePrPhase({ ...base, mergeStateStatus: "CLEAN", behindBy: 2 })).toBe(
      "ready_to_merge",
    );
  });

  it("claims nothing beyond CI when review state wasn't fetched", () => {
    const unknown = { ...base, reviewStateKnown: false, reviewDecision: null as null };
    expect(derivePrPhase(unknown)).toBe("unknown");
    expect(derivePrPhase({ ...unknown, ciStatus: "failure" })).toBe("ci_failing");
    expect(derivePrPhase({ ...unknown, ciStatus: "in_progress" })).toBe("ci_pending");
    expect(derivePrPhase({ ...unknown, isDraft: true })).toBe("draft");
  });

  it("won't call a PR ready without a CI answer, unless GitHub says CLEAN", () => {
    // Head runs never fetched: nothing proves CI is fine.
    const unconfirmed = { ...base, mergeStateStatus: "UNSTABLE" };
    expect(derivePrPhase({ ...unconfirmed, ciStatus: null, ciFetched: false })).toBe("unknown");
    expect(
      derivePrPhase({ ...base, ciStatus: null, ciFetched: false, mergeStateStatus: "CLEAN" }),
    ).toBe("ready_to_merge");
    // Fetched (even with no runs) or not tracked: ready as before.
    expect(derivePrPhase({ ...unconfirmed, ciStatus: null, ciFetched: true })).toBe(
      "ready_to_merge",
    );
    expect(derivePrPhase({ ...unconfirmed, ciStatus: null })).toBe("ready_to_merge");
    // Review/conflict/CI-failure phases never depend on it.
    expect(derivePrPhase({ ...base, ciFetched: false, reviewDecision: "CHANGES_REQUESTED" })).toBe(
      "changes_requested",
    );
    expect(derivePrPhase({ ...base, ciFetched: false, mergeable: "CONFLICTING" })).toBe(
      "conflicts",
    );
  });

  it("does not call an UNKNOWN mergeable a conflict", () => {
    expect(derivePrPhase({ ...base, mergeable: "UNKNOWN" })).toBe("ready_to_merge");
  });
});

function snap(number: number, over: Partial<PrSnapshot> = {}): PrSnapshot {
  return snapshotPr({
    number,
    headSha: "abc",
    isDraft: false,
    ciStatus: "success",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    unresolvedThreads: 0,
    commentCount: 0,
    prPhase: "ready_to_merge",
    ...over,
  });
}

describe("diffPrSnapshots", () => {
  it("reports nothing when nothing changed", () => {
    expect(diffPrSnapshots(new Map([[1, snap(1)]]), [snap(1)])).toEqual([]);
  });

  it("does not treat GitHub finishing its mergeability computation as a change", () => {
    const prev = new Map([[1, snap(1, { mergeable: "UNKNOWN" })]]);
    expect(diffPrSnapshots(prev, [snap(1, { mergeable: null })])).toEqual([]);
    expect(diffPrSnapshots(prev, [snap(1, { mergeable: "CONFLICTING" })])).toHaveLength(1);
  });

  it("reports a review landing (relay state change) so the panel is pushed (#1744)", () => {
    const requested = snapshotPr({
      ...snap(1),
      relayReview: { state: "requested", runId: "run_1" },
    });
    const landed = snapshotPr({
      ...snap(1),
      relayReview: { state: "landed", runId: "run_1", verdict: "APPROVED" },
    });
    expect(requested).toMatchObject({ relayState: "requested", relayVerdict: null });
    expect(diffPrSnapshots(new Map([[1, requested]]), [landed])).toMatchObject([
      { number: 1, kind: "updated" },
    ]);
    // A PR the relay never touched snapshots as null/null, so it adds no noise.
    expect(snap(1)).toMatchObject({ relayState: null, relayVerdict: null });
  });

  it("reports opened, updated and closed PRs in that order", () => {
    const prev = new Map([
      [1, snap(1)],
      [2, snap(2)],
    ]);
    const changes = diffPrSnapshots(prev, [snap(1, { ciStatus: "failure" }), snap(3)]);
    expect(changes.map((c) => [c.number, c.kind])).toEqual([
      [1, "updated"],
      [3, "opened"],
      [2, "closed"],
    ]);
    expect(changes[0].before?.ciStatus).toBe("success");
    expect(changes[0].after?.ciStatus).toBe("failure");
    expect(changes[2].after).toBeNull();
  });

  it("notices a new review comment (count) and a resolved thread", () => {
    const prev = new Map([[7, snap(7, { commentCount: 1, unresolvedThreads: 2 })]]);
    expect(
      diffPrSnapshots(prev, [snap(7, { commentCount: 2, unresolvedThreads: 2 })]),
    ).toHaveLength(1);
    expect(
      diffPrSnapshots(prev, [snap(7, { commentCount: 1, unresolvedThreads: 1 })]),
    ).toHaveLength(1);
  });
});
