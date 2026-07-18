import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitHubApiError,
  getRepoStatus,
  getCacheSizeForTests,
  MAX_CACHE_ENTRIES,
} from "../../src/services/github.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const ISSUE = {
  number: 27,
  title: "GitHub integration",
  html_url: "https://github.com/o/r/issues/27",
  user: { login: "s3ntin3l8" },
};
const PR = {
  number: 38,
  title: "add credential storage",
  html_url: "https://github.com/o/r/pull/38",
  user: { login: "s3ntin3l8" },
  pull_request: {},
};

describe("getRepoStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("splits issues API entries into issues vs. PRs by the pull_request field", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [ISSUE, PR]));
    // Unique owner/repo per test — getRepoStatus's cache is module-level
    // (shared across tests in this file), so a repeated "o/r" key would
    // read a previous test's cached result instead of hitting the mock.
    const status = await getRepoStatus("tok", "split-owner", "split-repo");
    expect(status.openIssues).toBe(1);
    expect(status.openPRs).toBe(1);
    expect(status.issues).toEqual([
      { number: 27, title: "GitHub integration", htmlUrl: ISSUE.html_url, author: "s3ntin3l8" },
    ]);
    expect(status.pulls).toEqual([
      { number: 38, title: "add credential storage", htmlUrl: PR.html_url, author: "s3ntin3l8" },
    ]);
    expect(status.repo).toEqual({
      owner: "split-owner",
      repo: "split-repo",
      htmlUrl: "https://github.com/split-owner/split-repo",
    });
  });

  it("sends a bearer token, User-Agent, and Accept header", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await getRepoStatus("my-token", "auth-owner", "auth-repo");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/auth-owner/auth-repo/issues?state=open&per_page=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my-token",
          "User-Agent": expect.any(String),
          Accept: expect.any(String),
        }),
      }),
    );
  });

  it("caches within the TTL window without a second fetch", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [ISSUE]));
    await getRepoStatus("tok", "cache-owner", "cache-repo");
    await getRepoStatus("tok", "cache-owner", "cache-repo");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws GitHubApiError on a non-ok response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "Not Found" }));
    await expect(getRepoStatus("tok", "missing-owner", "missing-repo")).rejects.toThrow(
      GitHubApiError,
    );
  });

  it("throws GitHubApiError when the network request fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(getRepoStatus("tok", "unreachable-owner", "unreachable-repo")).rejects.toThrow(
      GitHubApiError,
    );
  });

  it("caps the module-level cache at MAX_CACHE_ENTRIES, evicting the oldest entry (Hermes review, PR #39)", async () => {
    // A fresh Response per call — a Response body can only be read once,
    // and mockResolvedValue would hand back the exact same instance for
    // every one of these MAX_CACHE_ENTRIES+ calls.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, [])));
    for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) {
      await getRepoStatus("tok", `cap-owner-${i}`, "repo");
    }
    expect(getCacheSizeForTests()).toBe(MAX_CACHE_ENTRIES);

    // The oldest entries (0-4) were evicted to make room — re-fetching one
    // of them costs a real fetch again, not a cache hit.
    const callsBefore = fetchMock.mock.calls.length;
    await getRepoStatus("tok", "cap-owner-0", "repo");
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
  });
});
