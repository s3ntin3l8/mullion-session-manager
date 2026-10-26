import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardStore } from "./index.js";
import { GITHUB_CACHE_FRESH_MS } from "./slices/github.js";
import { __resetGithubCacheForTests } from "./githubCacheReset.js";
import { api } from "../api/index.js";

const fetchCached = <T>(key: string, fetcher: () => Promise<T>, force?: boolean) =>
  useDashboardStore.getState().githubFetch(key, fetcher, force);

describe("GitHub client cache (githubFetch)", () => {
  beforeEach(() => {
    __resetGithubCacheForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("dedups concurrent requests for one key into a single fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue("v");
    const [a, b] = await Promise.all([
      fetchCached("1:status", fetcher),
      fetchCached("1:status", fetcher),
    ]);
    expect(a).toBe("v");
    expect(b).toBe("v");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh entry without refetching, and refetches once it is stale by age", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    expect(await fetchCached("1:prs", fetcher)).toBe("one");
    expect(await fetchCached("1:prs", fetcher)).toBe("one");
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(GITHUB_CACHE_FRESH_MS + 1);
    expect(await fetchCached("1:prs", fetcher)).toBe("two");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("drops a response that lands after a cache reset instead of writing it back fresh", async () => {
    let resolve!: (v: string) => void;
    const slow = fetchCached("1:late", () => new Promise<string>((r) => (resolve = r)));
    __resetGithubCacheForTests();
    resolve("stale payload");
    await slow;
    expect(useDashboardStore.getState().githubCache["1:late"]).toBeUndefined();
  });

  it("force bypasses freshness", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    await fetchCached("1:prs", fetcher);
    expect(await fetchCached("1:prs", fetcher, true)).toBe("two");
  });

  it("keeps the last good data when a revalidation fails, and records the error", async () => {
    await fetchCached("1:status", () => Promise.resolve({ ok: true }));
    await expect(
      fetchCached("1:status", () => Promise.reject(new Error("boom")), true),
    ).rejects.toThrow("boom");
    const entry = useDashboardStore.getState().githubCache["1:status"];
    expect(entry.data).toEqual({ ok: true });
    expect(entry.error).toBe("boom");
    // Stale after a failure, so the next use retries.
    expect(entry.fetchedAt).toBe(0);
  });

  it("records a non-Error rejection with a generic message", async () => {
    await expect(fetchCached("1:x", () => Promise.reject("nope"))).rejects.toBe("nope");
    expect(useDashboardStore.getState().githubCache["1:x"].error).toBe("Request failed");
  });

  it("turns a synchronous fetcher throw into a rejection", async () => {
    await expect(
      fetchCached("1:y", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
  });
});

describe("prefetchGithubProject / prefetchGithubPr", () => {
  beforeEach(() => {
    __resetGithubCacheForTests();
    useDashboardStore.setState({ githubIssueUiByProject: {} });
  });
  afterEach(() => vi.restoreAllMocks());

  it("starts status, PRs and the first issues page together (no waterfall)", () => {
    const status = vi.spyOn(api, "getProjectGitHub").mockReturnValue(new Promise(() => {}));
    const prs = vi.spyOn(api, "getProjectGitHubPRs").mockReturnValue(new Promise(() => {}));
    const issues = vi.spyOn(api, "getProjectIssues").mockReturnValue(new Promise(() => {}));

    useDashboardStore.getState().prefetchGithubProject(5);

    // All three issued synchronously, none awaiting another's response.
    return Promise.resolve().then(() => {
      expect(status).toHaveBeenCalledWith(5);
      expect(prs).toHaveBeenCalledWith(5);
      expect(issues).toHaveBeenCalledWith(5, expect.objectContaining({ sort: "updated", page: 1 }));
    });
  });

  it("shares one request between repeated prefetches (rail hover then focus)", async () => {
    const status = vi.spyOn(api, "getProjectGitHub").mockResolvedValue(undefined);
    vi.spyOn(api, "getProjectGitHubPRs").mockResolvedValue(undefined);
    vi.spyOn(api, "getProjectIssues").mockResolvedValue({} as never);

    useDashboardStore.getState().prefetchGithubProject(5);
    useDashboardStore.getState().prefetchGithubProject(5);
    await new Promise((r) => setTimeout(r, 0));

    expect(status).toHaveBeenCalledTimes(1);
  });

  it("skips the issues page when the cached status says the token cannot list issues", async () => {
    vi.spyOn(api, "getProjectGitHub").mockResolvedValue(undefined);
    vi.spyOn(api, "getProjectGitHubPRs").mockResolvedValue(undefined);
    const issues = vi.spyOn(api, "getProjectIssues").mockResolvedValue({} as never);
    useDashboardStore.setState({
      githubCache: {
        "5:status": { data: { issuesHidden: true }, fetchedAt: Date.now(), error: null },
      },
    });

    useDashboardStore.getState().prefetchGithubProject(5);
    await new Promise((r) => setTimeout(r, 0));

    expect(issues).not.toHaveBeenCalled();
  });

  it("prefetches a PR's detail under its own key and swallows failures", async () => {
    vi.spyOn(api, "getProjectPr").mockRejectedValue(new Error("502"));
    useDashboardStore.getState().prefetchGithubPr(5, 12);
    await new Promise((r) => setTimeout(r, 0));
    expect(useDashboardStore.getState().githubCache["5:pr:12"].error).toBe("502");
  });
});

describe("persisted Issues UI state", () => {
  it("keeps the open issue per project", () => {
    useDashboardStore.getState().setGithubOpenIssue(1, 9);
    useDashboardStore.getState().setGithubOpenIssue(2, null);
    const s = useDashboardStore.getState().githubOpenIssueByProject;
    expect(s[1]).toBe(9);
    expect(s[2]).toBeNull();
  });

  it("patches filters over the defaults without touching other projects", () => {
    useDashboardStore.getState().patchGithubIssueUi(1, { labels: ["bug"] });
    const ui = useDashboardStore.getState().githubIssueUiByProject;
    expect(ui[1].labels).toEqual(["bug"]);
    expect(ui[1].sort).toBe("updated");
    expect(ui[2]).toBeUndefined();
  });
});
