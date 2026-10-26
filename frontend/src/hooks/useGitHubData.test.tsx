// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDashboardStore } from "../store/index.js";
import { api } from "../api/index.js";
import type { GitHubIssuesResponse, GitHubPRsStatus, GitHubStatus } from "../api/types.js";
import {
  useGitHubStatus,
  useIssue,
  useIssues,
  usePrDetail,
  usePrList,
  useRunJobs,
} from "./useGitHubData.js";

const STATUS = {
  repo: { owner: "o", repo: "r", htmlUrl: "u" },
  issuesHidden: false,
} as GitHubStatus;
const PRS = (n: number) =>
  ({ prs: [{ number: n }], prSummary: { total: 1 } }) as unknown as GitHubPRsStatus;
const page = (p: number, nums: number[], hasMore: boolean): GitHubIssuesResponse =>
  ({
    issues: nums.map((number) => ({ number, title: `i${number}`, labels: [] })),
    page: p,
    hasMore,
    labels: [],
    taskMasterEnabled: false,
    taskLabel: "t",
  }) as unknown as GitHubIssuesResponse;

beforeEach(() => {
  useDashboardStore.setState({
    prsByProject: {},
    prsRefreshTriggerByProject: {},
    githubIssueUiByProject: {},
  });
});
afterEach(() => vi.restoreAllMocks());

describe("useGitHubStatus", () => {
  it("is undefined while loading, then the status", async () => {
    vi.spyOn(api, "getProjectGitHub").mockResolvedValue(STATUS);
    const { result } = renderHook(() => useGitHubStatus(1));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toEqual(STATUS));
  });

  it("is null for a 204 and for a failure", async () => {
    vi.spyOn(api, "getProjectGitHub").mockResolvedValueOnce(undefined);
    const a = renderHook(() => useGitHubStatus(1));
    await waitFor(() => expect(a.result.current).toBeNull());

    vi.spyOn(api, "getProjectGitHub").mockRejectedValueOnce(new Error("x"));
    const b = renderHook(() => useGitHubStatus(2));
    await waitFor(() => expect(b.result.current).toBeNull());
  });

  it("paints from the cache immediately on a second mount", async () => {
    const spy = vi.spyOn(api, "getProjectGitHub").mockResolvedValue(STATUS);
    const first = renderHook(() => useGitHubStatus(1));
    await waitFor(() => expect(first.result.current).toEqual(STATUS));
    const second = renderHook(() => useGitHubStatus(1));
    expect(second.result.current).toEqual(STATUS);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refetches only for the project whose trigger moved", async () => {
    const spy = vi.spyOn(api, "getProjectGitHub").mockResolvedValue(STATUS);
    renderHook(() => useGitHubStatus(1));
    renderHook(() => useGitHubStatus(2));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    act(() => {
      useDashboardStore.setState((s) => ({
        githubCache: Object.fromEntries(
          Object.entries(s.githubCache).map(([k, v]) => [
            k,
            k.startsWith("1:") ? { ...v, fetchedAt: 0 } : v,
          ]),
        ),
        prsRefreshTriggerByProject: { 1: 1 },
      }));
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    expect(spy).toHaveBeenLastCalledWith(1);
  });
});

describe("usePrList", () => {
  it("prefers the store's live PRs over the fetch, with no loading state", () => {
    vi.spyOn(api, "getProjectGitHubPRs").mockReturnValue(new Promise(() => {}));
    useDashboardStore.setState({ prsByProject: { 1: PRS(7) } });
    const { result } = renderHook(() => usePrList(1));
    expect(result.current?.prs[0].number).toBe(7);
  });

  it("falls back to the fetched list", async () => {
    vi.spyOn(api, "getProjectGitHubPRs").mockResolvedValue(PRS(3));
    const { result } = renderHook(() => usePrList(1));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current?.prs[0].number).toBe(3));
  });
});

describe("usePrDetail", () => {
  it("returns the PR and the relay state, and refresh refetches both", async () => {
    const pr = vi.spyOn(api, "getProjectPr").mockResolvedValue({ number: 4 } as never);
    const review = vi
      .spyOn(api, "getProjectPrReview")
      .mockResolvedValue({ state: "none" } as never);
    const { result } = renderHook(() => usePrDetail(1, 4));
    await waitFor(() => expect(result.current.pr).toEqual({ number: 4 }));
    await waitFor(() => expect(result.current.review).toEqual({ state: "none" }));

    await act(() => result.current.refresh());
    expect(pr).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("treats a relay failure as no review, and surfaces a PR failure", async () => {
    vi.spyOn(api, "getProjectPr").mockRejectedValue(new Error("gone"));
    vi.spyOn(api, "getProjectPrReview").mockRejectedValue(new Error("relay"));
    const { result } = renderHook(() => usePrDetail(1, 4));
    await waitFor(() => expect(result.current.error).toBe("gone"));
    expect(result.current.review).toBeNull();
    expect(result.current.pr).toBeUndefined();
  });
});

describe("useRunJobs", () => {
  it("fetches only when enabled, and maps failures to null", async () => {
    const spy = vi
      .spyOn(api, "getGitHubRunJobs")
      .mockImplementation((_p, runId) =>
        runId === 2 ? Promise.reject(new Error("x")) : Promise.resolve([{ id: 1 } as never]),
      );
    const { result, rerender } = renderHook(({ on }) => useRunJobs(1, [1, 2], on), {
      initialProps: { on: false },
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.current[1]).toBeUndefined();

    rerender({ on: true });
    await waitFor(() => expect(result.current[1]).toEqual([{ id: 1 }]));
    await waitFor(() => expect(result.current[2]).toBeNull());

    // Collapse and re-expand: the loaded run is served from the cache (the
    // failed one is retried).
    rerender({ on: false });
    rerender({ on: true });
    expect(spy.mock.calls.filter(([, id]) => id === 1)).toHaveLength(1);
  });

  it("handles no runs", () => {
    const { result } = renderHook(() => useRunJobs(1, [], true));
    expect(result.current).toEqual({});
  });
});

describe("useIssue", () => {
  it("loads one issue through the cache", async () => {
    vi.spyOn(api, "getProjectIssue").mockResolvedValue({ number: 8 } as never);
    const { result } = renderHook(() => useIssue(1, 8));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ number: 8 }));
  });
});

describe("useIssues", () => {
  it("merges persisted pages, and keeps the old results while a new filter loads", async () => {
    const spy = vi
      .spyOn(api, "getProjectIssues")
      .mockImplementation((_p, q) =>
        Promise.resolve(
          q?.page === 2
            ? page(2, [3], false)
            : q?.sort === "created"
              ? page(1, [9], false)
              : page(1, [1, 2], true),
        ),
      );
    const { result } = renderHook(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.data?.issues.map((i) => i.number)).toEqual([1, 2]));
    expect(result.current.data?.hasMore).toBe(true);

    act(() => {
      useDashboardStore.getState().patchGithubIssueUi(1, {
        pageState: { key: result.current.filterKey, page: 2 },
      });
    });
    await waitFor(() =>
      expect(result.current.data?.issues.map((i) => i.number)).toEqual([1, 2, 3]),
    );
    expect(result.current.data?.hasMore).toBe(false);
    expect(result.current.loading).toBe(false);

    // A new filter resets to page 1, shows the previous results meanwhile.
    spy.mockImplementation(() => new Promise(() => {}));
    act(() => {
      useDashboardStore.getState().patchGithubIssueUi(1, { sort: "comments" });
    });
    expect(result.current.page).toBe(1);
    expect(result.current.loading).toBe(true);
    expect(result.current.data?.issues).toHaveLength(3);
  });

  it("reports an error and does not fetch while disabled", async () => {
    const spy = vi.spyOn(api, "getProjectIssues").mockRejectedValue(new Error("403"));
    const off = renderHook(() => useIssues(1, "", false));
    expect(spy).not.toHaveBeenCalled();
    expect(off.result.current.loading).toBe(false);

    const on = renderHook(() => useIssues(1, "", true));
    await waitFor(() => expect(on.result.current.error).toBe("403"));
    expect(on.result.current.loading).toBe(false);
  });
});
