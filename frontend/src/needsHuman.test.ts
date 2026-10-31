import { describe, it, expect } from "vitest";
import { needsHumanText, reviewPhaseText } from "./needsHuman.js";

describe("needsHumanText", () => {
  it("names each reason the automatic loop stopped", () => {
    expect(needsHumanText("cap")).toBe("round cap reached");
    expect(needsHumanText("no-progress")).toBe("worker returned without a change");
    expect(needsHumanText("finding-persisted")).toBe("same finding still open after two rounds");
  });

  it("reads a missing reason as the round cap — the original, still most common, case", () => {
    expect(needsHumanText(null)).toBe("round cap reached");
    expect(needsHumanText(undefined)).toBe("round cap reached");
  });
});

describe("reviewPhaseText", () => {
  it("is null outside a waiting phase", () => {
    expect(reviewPhaseText(null, null, true)).toBeNull();
    expect(reviewPhaseText(undefined, undefined, false)).toBeNull();
  });

  it("says a review is waiting to start", () => {
    expect(reviewPhaseText("awaiting-review", null, false)).toBe("Waiting for the review to start");
  });

  it("says nothing will start a review when no review agent is configured", () => {
    expect(reviewPhaseText("no-reviewer", null, false)).toMatch(/^No review agent is configured/);
  });

  it("explains the rebase hold-back, with the re-review time when known", () => {
    expect(reviewPhaseText("rebasing", Date.now() + 12 * 60_000, true)).toBe(
      "Reviewed, then conflicted with main — auto-rebasing; re-review starts in 12m at the latest",
    );
    expect(reviewPhaseText("rebasing", null, false)).toBe(
      "Conflicted with main — auto-rebasing; re-review starts",
    );
  });
});
