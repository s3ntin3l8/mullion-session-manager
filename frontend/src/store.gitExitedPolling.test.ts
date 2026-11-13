// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardStore } from "./store/index.js";
import type { GitDiffStats, GitStatus } from "./api/index.js";
import { makeSession } from "./test/fixtures.js";
import { jsonResponse } from "./test/jsonResponse.js";

// Issue #2991: exited sessions stayed in every 4 s git batch until killed, so a
// single exited session on a remote host kept costing the agent git calls. The
// fast tick now asks for active sessions only; exited ones ride the slow
// cadence, and their last value is kept in between.

const STATUS: GitStatus = {
  branch: "main",
  hash: "abc1234",
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  hasConflicts: false,
};
const STATS: GitDiffStats = { filesChanged: 1, insertions: 2, deletions: 3 } as GitDiffStats;

const ACTIVE = makeSession({ id: 1, status: "active" });
const EXITED = makeSession({ id: 2, status: "exited" });
const KILLED = makeSession({ id: 3, status: "killed" });

function ids(url: string): number[] {
  const raw = /sessionIds=([\d,]*)/.exec(url)?.[1] ?? "";
  return raw === "" ? [] : raw.split(",").map(Number);
}

describe("git refresh scope for exited sessions (#2991)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const urls = (path: string) =>
    fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith(path));

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/git-statuses")) {
        const body: Record<string, GitStatus> = {};
        for (const id of ids(url)) body[id] = STATUS;
        return jsonResponse(200, { projects: {}, sessions: body, problems: {} });
      }
      const body: Record<string, GitDiffStats> = {};
      for (const id of ids(url)) body[id] = STATS;
      return jsonResponse(200, body);
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({
      projects: [],
      sessions: [ACTIVE, EXITED, KILLED],
      sessionGitStatuses: {},
      gitDiffStats: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("the default request covers active sessions only", async () => {
    await useDashboardStore.getState().refreshGitStatuses();
    await useDashboardStore.getState().refreshGitDiffStats();
    expect(ids(urls("/api/projects/git-statuses")[0])).toEqual([1]);
    expect(ids(urls("/api/projects/git-diff-stats")[0])).toEqual([1]);
  });

  it("includeExited also requests exited sessions, never killed ones", async () => {
    await useDashboardStore.getState().refreshGitStatuses({ includeExited: true });
    await useDashboardStore.getState().refreshGitDiffStats({ includeExited: true });
    expect(ids(urls("/api/projects/git-statuses")[0])).toEqual([1, 2]);
    expect(ids(urls("/api/projects/git-diff-stats")[0])).toEqual([1, 2]);
  });

  it("keeps an exited session's last value across active-only refreshes", async () => {
    await useDashboardStore.getState().refreshGitStatuses({ includeExited: true });
    await useDashboardStore.getState().refreshGitDiffStats({ includeExited: true });
    await useDashboardStore.getState().refreshGitStatuses();
    await useDashboardStore.getState().refreshGitDiffStats();
    expect(useDashboardStore.getState().sessionGitStatuses[2]).toEqual(STATUS);
    expect(useDashboardStore.getState().gitDiffStats[2]).toEqual(STATS);
  });

  it("prunes a session that was killed", async () => {
    await useDashboardStore.getState().refreshGitStatuses({ includeExited: true });
    await useDashboardStore.getState().refreshGitDiffStats({ includeExited: true });
    useDashboardStore.setState({ sessions: [ACTIVE, { ...EXITED, status: "killed" }] });
    await useDashboardStore.getState().refreshGitStatuses();
    await useDashboardStore.getState().refreshGitDiffStats();
    expect(useDashboardStore.getState().sessionGitStatuses[2]).toBeUndefined();
    expect(useDashboardStore.getState().gitDiffStats[2]).toBeUndefined();
  });

  it("prunes a killed session even when only exited sessions remain listed", async () => {
    await useDashboardStore.getState().refreshGitStatuses({ includeExited: true });
    await useDashboardStore.getState().refreshGitDiffStats({ includeExited: true });
    // 1 was active, and is now killed; only exited 2 remains.
    useDashboardStore.setState({ sessions: [{ ...ACTIVE, status: "killed" }, EXITED] });
    fetchMock.mockClear();
    await useDashboardStore.getState().refreshGitStatuses();
    await useDashboardStore.getState().refreshGitDiffStats();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useDashboardStore.getState().sessionGitStatuses[1]).toBeUndefined();
    expect(useDashboardStore.getState().sessionGitStatuses[2]).toEqual(STATUS);
    expect(useDashboardStore.getState().gitDiffStats[1]).toBeUndefined();
    expect(useDashboardStore.getState().gitDiffStats[2]).toEqual(STATS);
  });

  it("makes no status request when there are no projects and only exited sessions", async () => {
    useDashboardStore.setState({ sessions: [EXITED] });
    await useDashboardStore.getState().refreshGitStatuses();
    expect(urls("/api/projects/git-statuses")).toHaveLength(0);
  });

  it("makes no diff request when only exited sessions are listed", async () => {
    useDashboardStore.setState({ sessions: [EXITED] });
    await useDashboardStore.getState().refreshGitDiffStats();
    expect(urls("/api/projects/git-diff-stats")).toHaveLength(0);
  });

  it("an includeExited call during an active-only batch is not swallowed by it", async () => {
    const first = useDashboardStore.getState().refreshGitStatuses();
    const second = useDashboardStore.getState().refreshGitStatuses({ includeExited: true });
    await Promise.all([first, second]);
    const calls = urls("/api/projects/git-statuses");
    expect(calls).toHaveLength(2);
    expect(ids(calls[0])).toEqual([1]);
    expect(ids(calls[1])).toEqual([1, 2]);
  });

  it("startLiveRefresh asks for exited sessions on the first tick and every 15th", async () => {
    vi.useFakeTimers();
    const refreshGitStatuses = vi.fn(async () => {});
    const refreshGitDiffStats = vi.fn(async () => {});
    useDashboardStore.setState({
      refreshGitStatuses,
      refreshGitDiffStats,
      refreshSessions: async () => {},
      refreshProjects: async () => {},
      refreshGitRefs: async () => {},
      refreshTasks: async () => {},
      sessionExpired: false,
    });
    const stop = useDashboardStore.getState().startLiveRefresh();
    await vi.advanceTimersByTimeAsync(4_000 * 15);
    const flags = refreshGitStatuses.mock.calls.map(
      (c) => (c as unknown as [{ includeExited: boolean }])[0].includeExited,
    );
    expect(flags).toHaveLength(16);
    expect(flags.filter(Boolean)).toHaveLength(2);
    expect(flags[0]).toBe(true);
    expect(flags[15]).toBe(true);
    expect(refreshGitDiffStats).toHaveBeenCalledTimes(16);
    stop();
  });
});
