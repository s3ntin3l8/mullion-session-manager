import { describe, expect, it } from "vitest";
import { runHook, THRESHOLD } from "../../scripts/check-patch-coverage-hook.mjs";

describe("check-patch-coverage-hook", () => {
  it("skips (exit 0) when no base ref is available", () => {
    // A git hook must not fail a push because the clone has nothing to
    // diff against — that is a repository-state problem, not a coverage
    // problem.
    const result = runHook({
      baseRef: null,
      check: () => {
        throw new Error("the check must not run when there is no base ref");
      },
    });
    expect(result).toBe(0);
  });

  it("passes (exit 0) when the patch meets the threshold", () => {
    const result = runHook({
      baseRef: "origin/main",
      check: () => ({ ok: true, overallPercent: 100 }),
    });
    expect(result).toBe(0);
  });

  it("fails (exit 1) when the patch is below the threshold", () => {
    const result = runHook({
      baseRef: "origin/main",
      check: () => ({ ok: false, overallPercent: 42.5 }),
    });
    expect(result).toBe(1);
  });

  it("passes the 75% threshold and the base ref through to the check", () => {
    let seen: { threshold?: number; baseRef?: string } = {};
    runHook({
      baseRef: "origin/main",
      check: (options: { threshold: number; baseRef: string }) => {
        seen = options;
        return { ok: true, overallPercent: 100 };
      },
    });
    expect(seen.threshold).toBe(THRESHOLD);
    expect(seen.baseRef).toBe("origin/main");
  });
});
