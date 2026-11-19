import { describe, it, expect } from "vitest";
import { classifyMergeReadiness } from "../../src/services/merge-readiness.js";

function pr(overrides: Partial<Parameters<typeof classifyMergeReadiness>[0]> = {}) {
  return {
    merged: false,
    state: "open" as const,
    mergeableState: "clean",
    ...overrides,
  };
}

describe("classifyMergeReadiness", () => {
  it("classifies a merged PR as already-done regardless of mergeableState", () => {
    expect(classifyMergeReadiness(pr({ merged: true, mergeableState: "dirty" }))).toBe(
      "already-done",
    );
  });

  it("classifies a closed-but-not-merged PR as already-done", () => {
    expect(classifyMergeReadiness(pr({ state: "closed", mergeableState: "clean" }))).toBe(
      "already-done",
    );
  });

  it("classifies mergeableState clean as clean", () => {
    expect(classifyMergeReadiness(pr({ mergeableState: "clean" }))).toBe("clean");
  });

  it("classifies mergeableState behind as behind", () => {
    expect(classifyMergeReadiness(pr({ mergeableState: "behind" }))).toBe("behind");
  });

  it("classifies mergeableState blocked as blocked", () => {
    expect(classifyMergeReadiness(pr({ mergeableState: "blocked" }))).toBe("blocked");
  });

  it("classifies mergeableState dirty as dirty", () => {
    expect(classifyMergeReadiness(pr({ mergeableState: "dirty" }))).toBe("dirty");
  });

  // Regression-prone: "unstable" (a non-required check red or still
  // running) must NOT be classified as mergeable. Merging on "unstable"
  // would silently skip whatever that check was verifying.
  it("classifies mergeableState unstable as unstable, never as clean", () => {
    expect(classifyMergeReadiness(pr({ mergeableState: "unstable" }))).toBe("unstable");
  });

  // Regression-prone: GitHub computes mergeability asynchronously after a
  // push; "unknown" means "still computing, ask again" and must never be
  // treated as false/not-mergeable in a way that looks final.
  it("classifies mergeableState unknown as computing", () => {
    expect(classifyMergeReadiness(pr({ mergeableState: "unknown" }))).toBe("computing");
  });

  it("classifies any unrecognized future mergeableState as computing, not an error", () => {
    expect(classifyMergeReadiness(pr({ mergeableState: "some-future-state" }))).toBe("computing");
  });
  describe("overrideHeadSha (Merge anyway)", () => {
    const HEAD = "a".repeat(40);

    it("reads unstable as clean only while the override matches the PR's head", () => {
      expect(classifyMergeReadiness(pr({ mergeableState: "unstable", headSha: HEAD }), HEAD)).toBe(
        "clean",
      );
      expect(
        classifyMergeReadiness(pr({ mergeableState: "unstable", headSha: "b".repeat(40) }), HEAD),
      ).toBe("unstable");
    });

    it("keeps unstable with no override, a null override, or a PR head that is unknown", () => {
      expect(classifyMergeReadiness(pr({ mergeableState: "unstable", headSha: HEAD }))).toBe(
        "unstable",
      );
      expect(classifyMergeReadiness(pr({ mergeableState: "unstable", headSha: HEAD }), null)).toBe(
        "unstable",
      );
      expect(classifyMergeReadiness(pr({ mergeableState: "unstable" }), HEAD)).toBe("unstable");
    });

    it("never overrides a required check (blocked), a conflict or an out-of-date branch", () => {
      for (const state of ["blocked", "dirty", "behind"]) {
        expect(classifyMergeReadiness(pr({ mergeableState: state, headSha: HEAD }), HEAD)).toBe(
          state,
        );
      }
    });
  });
});
