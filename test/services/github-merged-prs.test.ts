import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as githubWrite from "../../src/services/github-write.js";
import {
  clearMergedPrsCacheForTests,
  getClosedPrsByBranch,
  invalidateMergedPrs,
  isPullRequestMerged,
} from "../../src/services/github-merged-prs.js";

const pr = (
  number: number,
  headRef: string,
  mergedAt: string | null,
  headRepo: string | null = "o/r",
): githubWrite.ClosedPullRequest => ({
  number,
  htmlUrl: `https://github.com/o/r/pull/${number}`,
  headRef,
  headSha: "a".repeat(40),
  headRepo,
  baseRef: "main",
  mergedAt,
  updatedAt: "2026-01-01T00:00:00Z",
});

describe("github-merged-prs", () => {
  beforeEach(() => clearMergedPrsCacheForTests());
  afterEach(() => vi.restoreAllMocks());

  it("keys the newest same-repo closed PR per head branch and skips fork heads", async () => {
    vi.spyOn(githubWrite, "listClosedPullRequests").mockResolvedValue([
      pr(3, "feat", null),
      pr(2, "feat", "2026-01-01T00:00:00Z"),
      pr(4, "forked", "2026-01-01T00:00:00Z", "someone/r"),
      pr(5, "deleted-fork", "2026-01-01T00:00:00Z", null),
    ]);
    const map = await getClosedPrsByBranch("t", "O", "R");
    expect(map.get("feat")).toMatchObject({ number: 3, state: "closed" });
    expect(map.has("forked")).toBe(false);
    expect(map.has("deleted-fork")).toBe(false);
  });

  it("caches per repo, dedups concurrent loads, and refetches on fresh or invalidation", async () => {
    const list = vi.spyOn(githubWrite, "listClosedPullRequests").mockResolvedValue([]);
    await Promise.all([getClosedPrsByBranch("t", "o", "r"), getClosedPrsByBranch("t", "o", "r")]);
    await getClosedPrsByBranch("t", "o", "r");
    expect(list).toHaveBeenCalledTimes(1);
    await getClosedPrsByBranch("t", "o", "r", { fresh: true });
    expect(list).toHaveBeenCalledTimes(2);
    invalidateMergedPrs("o", "r");
    await getClosedPrsByBranch("t", "o", "r");
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("pages until a short page, capped at three pages", async () => {
    const full = Array.from({ length: 100 }, (_, i) => pr(i + 1, `b${i}`, null));
    const list = vi.spyOn(githubWrite, "listClosedPullRequests").mockResolvedValue(full);
    await getClosedPrsByBranch("t", "o", "r");
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls.map((c) => c[3])).toEqual([1, 2, 3]);
  });

  it("evicts the oldest repo past the cache cap", async () => {
    const list = vi.spyOn(githubWrite, "listClosedPullRequests").mockResolvedValue([]);
    for (let i = 0; i < 101; i++) await getClosedPrsByBranch("t", "o", `r${i}`);
    await getClosedPrsByBranch("t", "o", "r0");
    expect(list).toHaveBeenCalledTimes(102);
  });

  it("does not cache a failed load", async () => {
    const list = vi
      .spyOn(githubWrite, "listClosedPullRequests")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue([]);
    await expect(getClosedPrsByBranch("t", "o", "r")).rejects.toThrow("boom");
    await getClosedPrsByBranch("t", "o", "r");
    expect(list).toHaveBeenCalledTimes(2);
  });

  describe("isPullRequestMerged", () => {
    const live = (merged: boolean, mergedAt: string | null) =>
      vi
        .spyOn(githubWrite, "getPullRequestByNumber")
        .mockResolvedValue({ merged, mergedAt } as Awaited<
          ReturnType<typeof githubWrite.getPullRequestByNumber>
        >);

    it("asks GitHub when nothing is cached", async () => {
      const get = live(true, "2026-02-02T00:00:00Z");
      expect(await isPullRequestMerged("t", "o", "r", 9)).toEqual({
        merged: true,
        mergedAt: "2026-02-02T00:00:00Z",
      });
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("trusts a cached merge, but re-asks for a cached closed-unmerged PR", async () => {
      vi.spyOn(githubWrite, "listClosedPullRequests").mockResolvedValue([
        pr(1, "a", "2026-01-01T00:00:00Z"),
        pr(2, "b", null),
      ]);
      await getClosedPrsByBranch("t", "o", "r");
      const get = live(false, null);
      expect(await isPullRequestMerged("t", "o", "r", 1)).toEqual({
        merged: true,
        mergedAt: "2026-01-01T00:00:00Z",
      });
      expect(get).not.toHaveBeenCalled();
      expect(await isPullRequestMerged("t", "o", "r", 2)).toEqual({
        merged: false,
        mergedAt: null,
      });
      expect(get).toHaveBeenCalledTimes(1);
    });
  });
});
