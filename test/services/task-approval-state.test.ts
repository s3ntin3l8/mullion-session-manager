import { describe, it, expect } from "vitest";
import {
  canSpawnReviewer,
  deriveApprovalState,
  deriveReviewPhase,
} from "../../src/services/task-approval-state.js";

const base = {
  status: "reviewing",
  prNumber: 7 as number | null,
  reviewSessionId: 5 as number | null,
  reviewFindingsIngestedSessionId: 5 as number | null,
  lastReviewVerdict: "approved" as string | null,
  projectAutoApprove: false as boolean | null,
};

describe("deriveApprovalState (#2252)", () => {
  it("is awaiting-human for an approving verdict on a manual project", () => {
    expect(deriveApprovalState(base, true)).toBe("awaiting-human");
  });

  it.each(["approved", "clean", "approved-with-suggestions"])(
    "treats %s as approving",
    (lastReviewVerdict) => {
      expect(deriveApprovalState({ ...base, lastReviewVerdict }, true)).toBe("awaiting-human");
    },
  );

  it.each(["changes-requested", "inconclusive", null])(
    "is null for a non-approving verdict (%s)",
    (lastReviewVerdict) => {
      expect(deriveApprovalState({ ...base, lastReviewVerdict }, true)).toBeNull();
    },
  );

  it("is null unless the task is reviewing", () => {
    expect(deriveApprovalState({ ...base, status: "in_progress" }, true)).toBeNull();
    expect(deriveApprovalState({ ...base, status: "done" }, true)).toBeNull();
  });

  it("is null unless the verdict was ingested for the current review session", () => {
    expect(deriveApprovalState({ ...base, reviewFindingsIngestedSessionId: 4 }, true)).toBeNull();
    expect(
      deriveApprovalState({ ...base, reviewFindingsIngestedSessionId: null }, true),
    ).toBeNull();
    expect(
      deriveApprovalState(
        { ...base, reviewSessionId: null, reviewFindingsIngestedSessionId: null },
        true,
      ),
    ).toBeNull();
  });

  describe("autoApprove x prNumber x Task Master", () => {
    it.each([
      [true, 7, true, "auto-pending"],
      [true, null, true, "awaiting-human"],
      [true, 7, false, "awaiting-human"],
      [true, null, false, "awaiting-human"],
      [false, 7, true, "awaiting-human"],
      [false, null, false, "awaiting-human"],
      [null, 7, true, "awaiting-human"],
    ])("autoApprove=%s prNumber=%s taskMaster=%s -> %s", (auto, prNumber, tm, expected) => {
      expect(deriveApprovalState({ ...base, projectAutoApprove: auto, prNumber }, tm)).toBe(
        expected,
      );
    });
  });
});

describe("deriveReviewPhase", () => {
  const STALE = 30 * 60_000;
  const now = 10_000_000;
  const ctx = { taskMasterEnabled: true, reviewerConfigured: true };
  const row = {
    status: "reviewing",
    reviewSessionId: null as number | null,
    rebaseStartedAt: null as Date | null,
    worktreePath: "/wt/x" as string | null,
  };

  it("is rebasing, with the re-review time, inside the rebase window", () => {
    const started = new Date(now - 5 * 60_000);
    expect(deriveReviewPhase({ ...row, rebaseStartedAt: started }, STALE, ctx, now)).toEqual({
      reviewPhase: "rebasing",
      reReviewAt: started.getTime() + STALE,
    });
  });

  it("is awaiting-review once the rebase window has aged out", () => {
    const started = new Date(now - STALE);
    expect(deriveReviewPhase({ ...row, rebaseStartedAt: started }, STALE, ctx, now)).toEqual({
      reviewPhase: "awaiting-review",
      reReviewAt: null,
    });
  });

  it("is awaiting-review with no rebase and no review session", () => {
    expect(deriveReviewPhase(row, STALE, ctx, now)).toEqual({
      reviewPhase: "awaiting-review",
      reReviewAt: null,
    });
  });

  it("is null while a review session is live", () => {
    expect(
      deriveReviewPhase({ ...row, reviewSessionId: 9 }, STALE, ctx, now).reviewPhase,
    ).toBeNull();
  });

  it("is null outside reviewing", () => {
    expect(deriveReviewPhase({ ...row, status: "done" }, STALE, ctx, now).reviewPhase).toBeNull();
  });

  // Like deriveApprovalState: no promise the spawn pass will not keep.
  it.each([
    ["Task Master is off", { ...ctx, taskMasterEnabled: false }, row],
    ["the task has no worktree", ctx, { ...row, worktreePath: null }],
  ])("is null when %s — nothing will ever spawn, and there is nothing to explain", (_why, c, r) => {
    const started = new Date(now - 5 * 60_000);
    expect(deriveReviewPhase({ ...r, rebaseStartedAt: started }, STALE, c, now)).toEqual({
      reviewPhase: null,
      reReviewAt: null,
    });
  });

  it("is no-reviewer when Task Master is on and there is a worktree but no review agent resolves", () => {
    const started = new Date(now - 5 * 60_000);
    expect(
      deriveReviewPhase(
        { ...row, rebaseStartedAt: started },
        STALE,
        { ...ctx, reviewerConfigured: false },
        now,
      ),
    ).toEqual({ reviewPhase: "no-reviewer", reReviewAt: null });
  });

  it("never reports no-reviewer for a task that is not waiting on a review", () => {
    const noReviewer = { ...ctx, reviewerConfigured: false };
    expect(
      deriveReviewPhase({ ...row, status: "done" }, STALE, noReviewer, now).reviewPhase,
    ).toBeNull();
    expect(
      deriveReviewPhase({ ...row, reviewSessionId: 4 }, STALE, noReviewer, now).reviewPhase,
    ).toBeNull();
  });
});

describe("canSpawnReviewer", () => {
  const ok = { taskMasterEnabled: true, reviewerConfigured: true };
  it("needs Task Master, a worktree and a resolvable review agent", () => {
    expect(canSpawnReviewer({ worktreePath: "/wt" }, ok)).toBe(true);
    expect(canSpawnReviewer({ worktreePath: null }, ok)).toBe(false);
    expect(canSpawnReviewer({ worktreePath: "/wt" }, { ...ok, taskMasterEnabled: false })).toBe(
      false,
    );
    expect(canSpawnReviewer({ worktreePath: "/wt" }, { ...ok, reviewerConfigured: false })).toBe(
      false,
    );
  });
});
