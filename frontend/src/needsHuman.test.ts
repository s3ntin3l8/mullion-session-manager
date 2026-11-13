import { describe, it, expect } from "vitest";
import { isMergeNeedsHumanReason, needsHumanText, reviewPhaseText } from "./needsHuman.js";

describe("needsHumanText", () => {
  it("names each reason the automatic loop stopped", () => {
    expect(needsHumanText("cap")).toBe("round cap reached");
    expect(needsHumanText("no-progress")).toBe("worker returned without a change");
    expect(needsHumanText("finding-persisted")).toBe("same finding still open after two rounds");
    expect(needsHumanText("review-post-failed")).toBe(
      "approving review could not be posted to GitHub",
    );
    expect(needsHumanText("pr-closed")).toBe(
      "the PR was closed without merging, so nothing landed",
    );
    // #2904 — the card must not read as "merely reviewing" once the coverage
    // re-uploads have been spent and the status is still stuck.
    expect(needsHumanText("ci-status-stalled")).toBe(
      "a CI status stayed pending after green CI — a Codecov-side stall; re-run the coverage upload",
    );
  });

  it("treats pr-closed as a merge-tied reason, standing on its own", () => {
    expect(isMergeNeedsHumanReason("pr-closed")).toBe(true);
    expect(isMergeNeedsHumanReason("cap")).toBe(false);
    expect(isMergeNeedsHumanReason(null)).toBe(false);
  });

  it("treats ci-status-stalled as a merge-tied reason, standing on its own", () => {
    expect(isMergeNeedsHumanReason("ci-status-stalled")).toBe(true);
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

describe("merge blocked-thread detail", () => {
  it("falls back to null on absent, malformed or empty detail", async () => {
    const { parseMergeBlockedThreads } = await import("./needsHuman.js");
    expect(parseMergeBlockedThreads(null)).toBeNull();
    expect(parseMergeBlockedThreads("not json")).toBeNull();
    expect(parseMergeBlockedThreads('{"total":1,"threads":[]}')).toBeNull();
  });

  it("describes an alert thread and rejects non-GitHub links", async () => {
    const { blockedThreadText, safeGithubUrl } = await import("./needsHuman.js");
    expect(
      blockedThreadText({
        author: "github-advanced-security",
        location: "a.ts:1",
        excerpt: "Path injection",
        url: null,
        alert: { number: 5, url: null },
      }),
    ).toBe("github-advanced-security at a.ts:1: Path injection (code-scanning alert #5)");
    expect(safeGithubUrl("javascript:alert(1)")).toBeNull();
    expect(safeGithubUrl("https://github.com/o/r")).toBe("https://github.com/o/r");
  });
});
