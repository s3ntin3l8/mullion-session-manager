// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useGitBranches } from "./useGitBranches.js";
import { mockFetch } from "../test/mockFetch.js";
import { jsonResponse } from "../test/jsonResponse.js";
import type { GitBranchesResult } from "../api.js";

const BRANCHES_RESULT: GitBranchesResult = {
  branches: [
    { name: "main", isCurrent: true },
    { name: "feature/x", isCurrent: false },
  ],
  worktrees: [],
  remoteBranches: ["origin/main", "origin/feature/x"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useGitBranches", () => {
  it("fetches, splits local+remote branches, and reports the current branch", async () => {
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/git-branches": () => jsonResponse(200, BRANCHES_RESULT),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGitBranches(1));

    await waitFor(() =>
      expect(result.current.branches).toEqual([
        "main",
        "feature/x",
        "origin/main",
        "origin/feature/x",
      ]),
    );
    expect(result.current.currentBranch).toBe("main");
    expect(result.current.error).toBeNull();
  });

  it("does not fetch at all when enabled: false, and leaves branches empty", async () => {
    const { fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/projects/:id/git-branches": () => jsonResponse(200, BRANCHES_RESULT),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGitBranches(1, { enabled: false }));
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current.branches).toEqual([]);
    expect(result.current.currentBranch).toBeNull();
    expect(unexpectedCalls).toEqual([]);
  });

  it("treats the 204 'not applicable' response as a silent no-op", async () => {
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/git-branches": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGitBranches(1));
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current.branches).toEqual([]);
    expect(result.current.currentBranch).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("sets a user-facing error message on a rejected fetch", async () => {
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/git-branches": () => {
        throw new Error("network down");
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "debug").mockImplementation(() => {});

    const { result } = renderHook(() => useGitBranches(1));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.branches).toEqual([]);
  });

  it("calls onLoaded once per successful load with the freshly computed branches/currentBranch", async () => {
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/git-branches": () => jsonResponse(200, BRANCHES_RESULT),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onLoaded = vi.fn();

    renderHook(() => useGitBranches(1, { onLoaded }));

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    expect(onLoaded).toHaveBeenCalledWith({
      branches: ["main", "feature/x", "origin/main", "origin/feature/x"],
      currentBranch: "main",
    });
  });

  it("does not fetch when projectId is null", async () => {
    const { fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/projects/:id/git-branches": () => jsonResponse(200, BRANCHES_RESULT),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useGitBranches(null));
    await new Promise((r) => setTimeout(r, 0));

    expect(unexpectedCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
