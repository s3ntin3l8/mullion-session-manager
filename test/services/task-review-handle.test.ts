import { describe, it, expect } from "vitest";
import {
  hasIngestedCurrentReview,
  hasReviewHandle,
  type ReviewHandleRow,
} from "../../src/services/task-review-handle.js";

// A task with no review at all; each case overrides what it is about.
const none: ReviewHandleRow = {
  reviewSessionId: null,
  reviewFindingsIngestedSessionId: null,
  reviewRunId: null,
  reviewRunIngestedId: null,
};

describe("hasReviewHandle", () => {
  it("is true for a task with a review session", () => {
    expect(hasReviewHandle({ ...none, reviewSessionId: 5 })).toBe(true);
  });

  it("is true for a task with an external review run", () => {
    expect(hasReviewHandle({ ...none, reviewRunId: "run_1" })).toBe(true);
  });

  it("is false for a task with neither", () => {
    expect(hasReviewHandle(none)).toBe(false);
  });

  it("reads a run column the query never selected as no run", () => {
    // `undefined`, not null: a projection that forgot the column.
    const missing = { reviewSessionId: null } as Pick<ReviewHandleRow, "reviewSessionId"> &
      Pick<ReviewHandleRow, "reviewRunId">;
    expect(hasReviewHandle(missing)).toBe(false);
  });
});

describe("hasIngestedCurrentReview — a review session", () => {
  it("is true when the marker points at the current review", () => {
    expect(
      hasIngestedCurrentReview({
        ...none,
        reviewSessionId: 5,
        reviewFindingsIngestedSessionId: 5,
      }),
    ).toBe(true);
  });

  it("is false while the current review has not been ingested", () => {
    expect(hasIngestedCurrentReview({ ...none, reviewSessionId: 5 })).toBe(false);
  });

  it("is false when the marker still points at an earlier review", () => {
    expect(
      hasIngestedCurrentReview({
        ...none,
        reviewSessionId: 6,
        reviewFindingsIngestedSessionId: 5,
      }),
    ).toBe(false);
  });

  it("is false for a task with no review, whatever the marker holds", () => {
    expect(hasIngestedCurrentReview(none)).toBe(false);
    expect(hasIngestedCurrentReview({ ...none, reviewFindingsIngestedSessionId: 5 })).toBe(false);
  });
});

describe("hasIngestedCurrentReview — an external review run", () => {
  it("is true when the run marker points at the current run", () => {
    expect(
      hasIngestedCurrentReview({ ...none, reviewRunId: "run_1", reviewRunIngestedId: "run_1" }),
    ).toBe(true);
  });

  it("is false while the current run has not been ingested", () => {
    expect(hasIngestedCurrentReview({ ...none, reviewRunId: "run_1" })).toBe(false);
  });

  it("is false when the marker still points at an earlier run", () => {
    expect(
      hasIngestedCurrentReview({ ...none, reviewRunId: "run_2", reviewRunIngestedId: "run_1" }),
    ).toBe(false);
  });

  it("is false for a task with no run, whatever the run marker holds", () => {
    expect(hasIngestedCurrentReview({ ...none, reviewRunIngestedId: "run_1" })).toBe(false);
  });

  it("reads run columns the query never selected as no run", () => {
    const missing = {
      reviewSessionId: null,
      reviewFindingsIngestedSessionId: null,
    } as ReviewHandleRow;
    expect(hasIngestedCurrentReview(missing)).toBe(false);
  });
});

describe("hasIngestedCurrentReview — the two pairs are never mixed", () => {
  it("does not take a session marker for a run's, or the reverse", () => {
    // A session review awaiting its verdict, beside a stale run marker.
    expect(
      hasIngestedCurrentReview({
        ...none,
        reviewSessionId: 5,
        reviewRunId: "run_1",
        reviewRunIngestedId: null,
      }),
    ).toBe(false);
    // A run awaiting its verdict, beside a stale session marker that matches nothing.
    expect(
      hasIngestedCurrentReview({
        ...none,
        reviewSessionId: null,
        reviewFindingsIngestedSessionId: 5,
        reviewRunId: "run_1",
      }),
    ).toBe(false);
  });

  it("is true when either pair is complete", () => {
    expect(
      hasIngestedCurrentReview({
        reviewSessionId: 5,
        reviewFindingsIngestedSessionId: 5,
        reviewRunId: "run_1",
        reviewRunIngestedId: null,
      }),
    ).toBe(true);
  });
});
