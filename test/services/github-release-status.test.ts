import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCachedReleasePullRequestStatus,
  invalidateReleaseCache,
  clearReleasePrCacheForTests,
} from "../../src/services/github-write.js";
import { setRepoPRsStatus, computePRSummary } from "../../src/services/github.js";
import { resetGitHubRateLimitForTests } from "../../src/services/github-fetch.js";
import { PR_REVIEW_DEFAULTS } from "../helpers/pr-review-defaults.js";

// The release PR's assembled status (getCachedReleasePullRequestStatus),
// split out of github-write.test.ts to keep that file under its size ceiling.
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string) {
  return new Response(body, { status });
}

describe("github-release status", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    resetGitHubRateLimitForTests();
    clearReleasePrCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearReleasePrCacheForTests();
  });

  describe("getCachedReleasePullRequestStatus", () => {
    // getDefaultBranch -> findReleasePullRequest -> getPullRequestByNumber,
    // in that fixed order — three sequential mocks matching the call order.
    function mockAssemblySequence() {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { default_branch: "main" }));
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, [
          {
            number: 12,
            html_url: "https://github.com/owner/repo/pull/12",
            head: { ref: "release-please--branches--main--components--repo" },
            title: "chore(main): release 0.2.46",
          },
        ]),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          number: 12,
          html_url: "https://github.com/owner/repo/pull/12",
          node_id: "PR_release",
          draft: false,
          head: { sha: "deadbeef", ref: "release-please--branches--main--components--repo" },
          base: { ref: "main" },
          title: "chore(main): release 0.2.46",
          state: "open",
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
        }),
      );
      // The head commit's workflow runs (held / not held), read for the status.
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          total_count: 2,
          workflow_runs: [
            { id: 1, status: "completed", conclusion: "action_required" },
            { id: 2, status: "completed", conclusion: "success" },
          ],
        }),
      );
    }

    it("assembles the release PR's full status, merging in the poller's cached ciStatus", async () => {
      mockAssemblySequence();
      const cachedPr = {
        number: 12,
        title: "chore(main): release 0.2.46",
        htmlUrl: "https://github.com/owner/repo/pull/12",
        author: null,
        ...PR_REVIEW_DEFAULTS,
        headSha: "deadbeef",
        headBranch: "release-please--branches--main--components--repo",
        baseBranch: "main",
        ciStatus: "success" as const,
        actionsRuns: [],
      };
      setRepoPRsStatus("owner", "repo", {
        prs: [cachedPr],
        prSummary: computePRSummary([cachedPr]),
      });

      const result = await getCachedReleasePullRequestStatus("tok", "owner", "repo");
      expect(result).toEqual({
        number: 12,
        htmlUrl: "https://github.com/owner/repo/pull/12",
        title: "chore(main): release 0.2.46",
        headRef: "release-please--branches--main--components--repo",
        headSha: "deadbeef",
        draft: false,
        mergeable: true,
        mergeableState: "clean",
        ciStatus: "success",
        heldRuns: 1,
        noRuns: false,
      });
    });

    it("still returns the PR when reading its runs fails (no Actions: read)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { default_branch: "main" }));
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, [
          {
            number: 12,
            html_url: "https://github.com/owner/repo/pull/12",
            head: { ref: "release-please--branches--main--components--repo" },
            title: "chore(main): release 0.2.46",
          },
        ]),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          number: 12,
          html_url: "https://github.com/owner/repo/pull/12",
          node_id: "PR_release",
          draft: false,
          head: { sha: "deadbeef", ref: "release-please--branches--main--components--repo" },
          base: { ref: "main" },
          title: "chore(main): release 0.2.46",
          state: "open",
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
        }),
      );
      fetchMock.mockResolvedValueOnce(textResponse(403, "Resource not accessible"));
      expect(await getCachedReleasePullRequestStatus("tok", "owner", "repo")).toMatchObject({
        number: 12,
        heldRuns: 0,
        noRuns: false,
      });
    });

    it("returns null when no release PR is open, without a fourth request", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { default_branch: "main" }));
      fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
      expect(await getCachedReleasePullRequestStatus("tok", "owner", "repo")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("caches the result — a second call within the TTL makes no new requests", async () => {
      mockAssemblySequence();
      await getCachedReleasePullRequestStatus("tok", "owner", "repo");
      const callsAfterFirst = fetchMock.mock.calls.length;
      await getCachedReleasePullRequestStatus("tok", "owner", "repo");
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    });

    it("invalidateReleaseCache drops the cache — the next call re-fetches", async () => {
      mockAssemblySequence();
      await getCachedReleasePullRequestStatus("tok", "owner", "repo");
      const callsAfterFirst = fetchMock.mock.calls.length;

      invalidateReleaseCache("owner", "repo");
      mockAssemblySequence();
      await getCachedReleasePullRequestStatus("tok", "owner", "repo");
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });
});
