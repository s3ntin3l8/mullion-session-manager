import { describe, it, expect } from "vitest";
import {
  hasIngestedCurrentReview,
  hasReviewHandle,
} from "../../src/services/task-review-handle.js";

describe("hasReviewHandle", () => {
  it("is true for a task with a review session", () => {
    expect(hasReviewHandle({ reviewSessionId: 5 })).toBe(true);
  });

  it("is false for a task with no review session", () => {
    expect(hasReviewHandle({ reviewSessionId: null })).toBe(false);
  });
});

describe("hasIngestedCurrentReview", () => {
  it("is true when the latch points at the current review", () => {
    expect(
      hasIngestedCurrentReview({ reviewSessionId: 5, reviewFindingsIngestedSessionId: 5 }),
    ).toBe(true);
  });

  it("is false while the current review has not been ingested", () => {
    expect(
      hasIngestedCurrentReview({ reviewSessionId: 5, reviewFindingsIngestedSessionId: null }),
    ).toBe(false);
  });

  it("is false when the latch still points at an earlier review", () => {
    expect(
      hasIngestedCurrentReview({ reviewSessionId: 6, reviewFindingsIngestedSessionId: 5 }),
    ).toBe(false);
  });

  it("is false for a task with no review, whatever the latch holds", () => {
    expect(
      hasIngestedCurrentReview({ reviewSessionId: null, reviewFindingsIngestedSessionId: null }),
    ).toBe(false);
    expect(
      hasIngestedCurrentReview({ reviewSessionId: null, reviewFindingsIngestedSessionId: 5 }),
    ).toBe(false);
  });
});
