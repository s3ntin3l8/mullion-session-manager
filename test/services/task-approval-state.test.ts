import { describe, it, expect } from "vitest";
import { deriveApprovalState } from "../../src/services/task-approval-state.js";

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
