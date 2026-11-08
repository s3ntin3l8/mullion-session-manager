import { describe, it, expect } from "vitest";
import { reviewRoundLabel } from "../../src/services/task-round-label.js";

const base = { autoReturnRounds: 0, lastAutoReturnReason: null, inconclusiveReviewRearmCount: 0 };

describe("reviewRoundLabel", () => {
  it("keeps the plain heading for a round that was never re-armed", () => {
    expect(reviewRoundLabel(base)).toBe("## Round 1");
    expect(reviewRoundLabel({ ...base, autoReturnRounds: 2 })).toBe("## Round 3");
  });

  it("keeps the suggestions suffix", () => {
    expect(reviewRoundLabel({ ...base, lastAutoReturnReason: "suggestions" })).toBe(
      "## Round 1 (re-review after suggestions)",
    );
  });

  it("numbers a re-armed round distinctly from the first attempt", () => {
    const first = reviewRoundLabel(base);
    const retry = reviewRoundLabel({ ...base, inconclusiveReviewRearmCount: 1 });
    expect(retry).toBe("## Round 1 (retry 2)");
    expect(retry).not.toBe(first);
    expect(reviewRoundLabel({ ...base, inconclusiveReviewRearmCount: 2 })).toBe(
      "## Round 1 (retry 3)",
    );
  });

  it("joins both notes in a single parenthetical", () => {
    expect(
      reviewRoundLabel({
        ...base,
        lastAutoReturnReason: "suggestions",
        inconclusiveReviewRearmCount: 1,
      }),
    ).toBe("## Round 1 (retry 2, re-review after suggestions)");
  });
});
