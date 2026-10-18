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
