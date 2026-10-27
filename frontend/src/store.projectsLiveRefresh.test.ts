// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDashboardStore } from "./store/index.js";

// detectedDevServerPort (and currentBranch/ruleFiles) ride GET /api/projects,
// which used to be fetched only on mount and after project mutations. The
// live-refresh tick now re-polls it on the slow (~60s) cadence.
describe("store / startLiveRefresh re-polls projects", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls refreshProjects every 15th tick, not on every tick", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
    const refreshProjects = vi.fn(async () => {});
    useDashboardStore.setState({
      refreshProjects,
      refreshSessions: async () => {},
      refreshGitStatuses: async () => {},
      refreshGitDiffStats: async () => {},
      refreshGitRefs: async () => {},
      refreshTasks: async () => {},
      sessionExpired: false,
    });

    const stop = useDashboardStore.getState().startLiveRefresh();
    // 15 ticks have run after the immediate one plus 14 intervals.
    await vi.advanceTimersByTimeAsync(4_000 * 13);
    expect(refreshProjects).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(refreshProjects).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000 * 15);
    expect(refreshProjects).toHaveBeenCalledTimes(2);

    stop();
    vi.unstubAllGlobals();
  });
});
