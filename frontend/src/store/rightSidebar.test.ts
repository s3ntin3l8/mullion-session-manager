// @vitest-environment jsdom
// Right sidebar state: open/close/width actions must write through to
// localStorage (persistedState.ts) and clamp the width, and the always-docked
// panel must come back after a reload the way it was left (#3006).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDashboardStore } from "./index.js";
import { RIGHT_SIDEBAR_MAX_WIDTH, RIGHT_SIDEBAR_MIN_WIDTH } from "./constants.js";

beforeEach(() => {
  localStorage.clear();
  useDashboardStore.setState({
    rightSidebarView: "git",
    rightSidebarOpen: false,
    rightSidebarWidth: 340,
  });
});

describe("right sidebar actions", () => {
  it("toggleRightSidebarView opens a closed drawer on that view and persists it", () => {
    useDashboardStore.getState().toggleRightSidebarView("github");

    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarView).toBe("github");
    expect(localStorage.getItem("crs.rightSidebarView")).toBe("github");
    expect(localStorage.getItem("crs.rightSidebarOpen")).toBe("1");
  });

  it("openRightSidebarView opens on that view and never toggles it closed", () => {
    useDashboardStore.getState().openRightSidebarView("files");
    useDashboardStore.getState().openRightSidebarView("files");

    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarView).toBe("files");
    expect(localStorage.getItem("crs.rightSidebarView")).toBe("files");
    expect(localStorage.getItem("crs.rightSidebarOpen")).toBe("1");
  });

  it("openRightSidebarTask selects the task and opens the Tasks view, persisted", () => {
    useDashboardStore.setState({ selectedTaskId: null });
    useDashboardStore.getState().openRightSidebarTask(42);

    const s = useDashboardStore.getState();
    expect(s.selectedTaskId).toBe(42);
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarView).toBe("tasks");
    expect(localStorage.getItem("crs.rightSidebarView")).toBe("tasks");
    expect(localStorage.getItem("crs.rightSidebarOpen")).toBe("1");
    useDashboardStore.getState().selectTask(null);
    expect(useDashboardStore.getState().selectedTaskId).toBeNull();
  });

  describe("sidebarBack (Tasks ↔ GitHub cross-links, epic #2847)", () => {
    const task5 = { kind: "task", taskId: 5 } as const;
    const pr12 = { kind: "pr", projectId: 3, number: 12 } as const;
    it("records where a cross-linked destination's Back returns, and consumes it once", () => {
      useDashboardStore.getState().openRightSidebarPr(3, 12, task5);
      expect(useDashboardStore.getState().takeSidebarBack(pr12)).toEqual(task5);
      expect(useDashboardStore.getState().takeSidebarBack(pr12)).toBeNull();
    });
    it("ignores an entry meant for another destination", () => {
      useDashboardStore.getState().openRightSidebarTask(5, pr12);
      expect(useDashboardStore.getState().takeSidebarBack({ kind: "task", taskId: 6 })).toBeNull();
      expect(useDashboardStore.getState().takeSidebarBack(task5)).toEqual(pr12);
    });
    it("matches on kind and ids, not on the shape of the target", () => {
      useDashboardStore.getState().openRightSidebarPr(3, 12, task5);
      // Same number, other project; and the same ids under another kind.
      expect(
        useDashboardStore.getState().takeSidebarBack({ kind: "pr", projectId: 4, number: 12 }),
      ).toBeNull();
      expect(
        useDashboardStore.getState().takeSidebarBack({ kind: "issue", projectId: 3, number: 12 }),
      ).toBeNull();
      expect(useDashboardStore.getState().takeSidebarBack(pr12)).toEqual(task5);
    });
    it("returns an issue opened from a task to that task", () => {
      useDashboardStore.getState().openRightSidebarIssue(3, 7, task5);
      expect(
        useDashboardStore.getState().takeSidebarBack({ kind: "issue", projectId: 3, number: 7 }),
      ).toEqual(task5);
    });
    it("records the detail the sidebar is showing as the origin when none is named", () => {
      useDashboardStore.getState().openRightSidebarTask(5, null);
      useDashboardStore.getState().openRightSidebarPr(3, 12);
      expect(useDashboardStore.getState().takeSidebarBack(pr12)).toEqual(task5);
    });
    it("records nothing for an explicit null origin, or when no detail is showing", () => {
      useDashboardStore.getState().selectTask(null);
      useDashboardStore.getState().openRightSidebarPr(3, 12);
      expect(useDashboardStore.getState().sidebarHistory).toEqual([]);
      useDashboardStore.getState().openRightSidebarTask(5, null);
      useDashboardStore.getState().openRightSidebarPr(3, 13, null);
      expect(useDashboardStore.getState().sidebarHistory).toEqual([]);
    });
    it("keeps a stack, pops the latest first and caps its length", () => {
      const s = () => useDashboardStore.getState();
      s().openRightSidebarPr(3, 12, task5);
      s().openRightSidebarTask(6, pr12);
      expect(s().sidebarHistory).toHaveLength(2);
      expect(s().takeSidebarBack({ kind: "task", taskId: 6 })).toEqual(pr12);
      expect(s().takeSidebarBack(pr12)).toEqual(task5);
      for (let n = 0; n < 30; n++) s().openRightSidebarPr(3, 100 + n, task5);
      expect(s().sidebarHistory).toHaveLength(20);
    });
    it("takes the origin from the project the sidebar follows, not another host's drill-in", () => {
      const s = () => useDashboardStore.getState();
      s().openRightSidebarView("github", 3);
      useDashboardStore.setState({
        followedProjectId: 3,
        githubOpenPrByProject: { 1: 30, 3: 12 },
      });
      s().openRightSidebarIssue(3, 7);
      expect(s().takeSidebarBack({ kind: "issue", projectId: 3, number: 7 })).toEqual(pr12);
      useDashboardStore.setState({ followedProjectId: null });
    });
    it("leaves only one of PR / issue open for a project", () => {
      const s = () => useDashboardStore.getState();
      s().openRightSidebarPr(3, 12, null);
      s().openRightSidebarIssue(3, 7, null);
      expect(s().githubOpenPrByProject[3]).toBeNull();
      expect(s().githubOpenIssueByProject[3]).toBe(7);
      s().openRightSidebarPr(3, 12, null);
      expect(s().githubOpenIssueByProject[3]).toBeNull();
    });
    it("drops a stale entry when the sidebar was navigated elsewhere in the meantime", () => {
      const s = () => useDashboardStore.getState();
      s().openRightSidebarPr(3, 12, task5);
      // The panel's own list → detail click: no history call.
      s().setGithubOpenPr(3, null);
      s().setGithubOpenPr(3, 99);
      s().openRightSidebarPr(3, 12);
      // Back returns to the PR it was actually reached from, not the stale task entry.
      expect(s().sidebarHistory).toHaveLength(1);
      expect(s().takeSidebarBack(pr12)).toEqual({ kind: "pr", projectId: 3, number: 99 });
    });
    it("prunes when the panel's own drill-in moves without a history call", () => {
      const s = () => useDashboardStore.getState();
      s().openRightSidebarPr(3, 12, task5);
      expect(s().sidebarHistory).toHaveLength(1);
      s().setGithubOpenPr(3, null);
      expect(s().sidebarHistory).toEqual([]);
      s().openRightSidebarPr(3, 12, task5);
      s().setGithubOpenPr(3, null);
      s().setGithubOpenIssue(3, 7);
      expect(s().sidebarHistory).toEqual([]);
    });
    it("is cleared by any other navigation", () => {
      const nav = [
        () => useDashboardStore.getState().selectTask(null),
        () => useDashboardStore.getState().openRightSidebarView("files"),
        () => useDashboardStore.getState().toggleRightSidebarView("git"),
        () => useDashboardStore.getState().closeRightSidebar(),
      ];
      for (const go of nav) {
        useDashboardStore.getState().openRightSidebarPr(3, 12, task5);
        go();
        expect(useDashboardStore.getState().takeSidebarBack(pr12)).toBeNull();
      }
    });
  });

  it("openRightSidebarView with a project bumps a nonce so repeats still fire", () => {
    useDashboardStore.getState().openRightSidebarView("files", 5);
    const first = useDashboardStore.getState().rightSidebarProjectRequest;
    useDashboardStore.getState().openRightSidebarView("files", 5);
    const second = useDashboardStore.getState().rightSidebarProjectRequest;
    expect(first?.projectId).toBe(5);
    expect(second!.nonce).toBe(first!.nonce + 1);
  });

  it("toggleRightSidebarView on the open view closes it but remembers the view", () => {
    useDashboardStore.getState().toggleRightSidebarView("git");
    useDashboardStore.getState().toggleRightSidebarView("git");

    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(false);
    expect(s.rightSidebarView).toBe("git");
    expect(localStorage.getItem("crs.rightSidebarOpen")).toBe("0");
  });

  it("toggleRightSidebarView on a different view switches without closing", () => {
    useDashboardStore.getState().toggleRightSidebarView("git");
    useDashboardStore.getState().toggleRightSidebarView("github");

    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarView).toBe("github");
  });

  it("toggleRightSidebar reopens the last view", () => {
    useDashboardStore.setState({ rightSidebarView: "github" });

    useDashboardStore.getState().toggleRightSidebar();
    expect(useDashboardStore.getState()).toMatchObject({
      rightSidebarOpen: true,
      rightSidebarView: "github",
    });

    useDashboardStore.getState().toggleRightSidebar();
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("closeRightSidebar closes an open drawer and is a no-op when already closed", () => {
    useDashboardStore.getState().closeRightSidebar();
    expect(localStorage.getItem("crs.rightSidebarOpen")).toBeNull();

    useDashboardStore.setState({ rightSidebarOpen: true });
    useDashboardStore.getState().closeRightSidebar();
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
    expect(localStorage.getItem("crs.rightSidebarOpen")).toBe("0");
  });

  it("setRightSidebarWidth clamps to the min/max and persists the clamped value", () => {
    useDashboardStore.getState().setRightSidebarWidth(10);
    expect(useDashboardStore.getState().rightSidebarWidth).toBe(RIGHT_SIDEBAR_MIN_WIDTH);

    useDashboardStore.getState().setRightSidebarWidth(99999);
    expect(useDashboardStore.getState().rightSidebarWidth).toBe(RIGHT_SIDEBAR_MAX_WIDTH);
    expect(localStorage.getItem("crs.rightSidebarWidth")).toBe(String(RIGHT_SIDEBAR_MAX_WIDTH));
  });
});

describe("right sidebar hydration", () => {
  async function freshStore() {
    vi.resetModules();
    return (await import("./index.js")).useDashboardStore;
  }

  it("reopens a panel that was open, whatever the old pin flag says (#3006)", async () => {
    localStorage.setItem("crs.rightSidebarOpen", "1");
    localStorage.setItem("crs.rightSidebarView", "github");
    localStorage.setItem("crs.rightSidebarWidth", "400");

    const s = (await freshStore()).getState();

    expect(s).toMatchObject({
      rightSidebarOpen: true,
      rightSidebarView: "github",
      rightSidebarWidth: 400,
    });
    expect("rightSidebarPinned" in s).toBe(false);
  });

  it("stays closed when it was closed, even with a stale pin flag stored", async () => {
    localStorage.setItem("crs.rightSidebarPinned", "1");
    localStorage.setItem("crs.rightSidebarOpen", "0");

    const s = (await freshStore()).getState();

    expect(s.rightSidebarOpen).toBe(false);
  });

  it("falls back to the git view at the default width", async () => {
    const s = (await freshStore()).getState();

    expect(s.rightSidebarView).toBe("git");
    expect(s.rightSidebarWidth).toBe(340);
  });

  it("openRightSidebarPr records the PR for its project and opens the GitHub view there", () => {
    useDashboardStore.getState().openRightSidebarPr(3, 42);

    const s = useDashboardStore.getState();
    expect(s.githubOpenPrByProject[3]).toBe(42);
    expect(s.rightSidebarView).toBe("github");
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarProjectRequest?.projectId).toBe(3);

    useDashboardStore.getState().setGithubOpenPr(3, null);
    expect(useDashboardStore.getState().githubOpenPrByProject[3]).toBeNull();
  });
});

describe("git deep-link requests", () => {
  it("openRightSidebarBranch opens the Git view and queues a one-shot branch request", () => {
    useDashboardStore.getState().openRightSidebarView("files");
    useDashboardStore.getState().openRightSidebarBranch(5, "feat/x");

    const s = useDashboardStore.getState();
    expect(s.rightSidebarView).toBe("git");
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarBranchRequest).toMatchObject({ projectId: 5, branch: "feat/x" });
    expect(s.rightSidebarProjectRequest?.projectId).toBe(5);

    useDashboardStore.getState().clearRightSidebarBranchRequest();
    expect(useDashboardStore.getState().rightSidebarBranchRequest).toBeNull();
  });

  it("openRightSidebarPrune queues a prune request with a fresh nonce each time", () => {
    useDashboardStore.getState().openRightSidebarPrune(5);
    const first = useDashboardStore.getState().rightSidebarPruneRequest;
    useDashboardStore.getState().openRightSidebarPrune(5);
    const second = useDashboardStore.getState().rightSidebarPruneRequest;
    expect(useDashboardStore.getState().rightSidebarView).toBe("git");
    expect(second!.nonce).toBeGreaterThan(first!.nonce);

    useDashboardStore.getState().clearRightSidebarPruneRequest();
    expect(useDashboardStore.getState().rightSidebarPruneRequest).toBeNull();
  });

  it("openRightSidebarPr opens the PR drill-in on the GitHub view", () => {
    useDashboardStore.getState().openRightSidebarPr(5, 42);
    const s = useDashboardStore.getState();
    expect(s.rightSidebarView).toBe("github");
    expect(s.githubOpenPrByProject[5]).toBe(42);
  });

  it("openRightSidebarIssue switches to GitHub first, so the drill-in reset doesn't erase the issue", () => {
    useDashboardStore.getState().openRightSidebarView("git", 5);
    useDashboardStore.getState().openRightSidebarIssue(5, 17);
    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarView).toBe("github");
    expect(s.githubOpenIssueByProject[5]).toBe(17);
  });

  describe("task detail reset (#2973)", () => {
    const openDetail = () => useDashboardStore.getState().openRightSidebarTask(7);
    const selected = () => useDashboardStore.getState().selectedTaskId;

    it("open a task, close, reopen via the rail icon lands on the list", () => {
      openDetail();
      useDashboardStore.getState().closeRightSidebar();
      expect(selected()).toBeNull();
      useDashboardStore.getState().toggleRightSidebarView("tasks");
      expect(selected()).toBeNull();
    });

    it("toggling the active Tasks view closed drops the detail", () => {
      openDetail();
      useDashboardStore.getState().toggleRightSidebarView("tasks");
      expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
      // Asserted before reopening, so the close-side clear is pinned on its
      // own and not masked by the reset on the way back in.
      expect(selected()).toBeNull();
      useDashboardStore.getState().toggleRightSidebar();
      expect(selected()).toBeNull();
    });

    it("leaving Tasks for another view drops the detail", () => {
      openDetail();
      useDashboardStore.getState().toggleRightSidebarView("git");
      expect(useDashboardStore.getState().rightSidebarView).toBe("git");
      expect(selected()).toBeNull();
    });

    it("open a task, switch to Git, switch back lands on the list", () => {
      openDetail();
      useDashboardStore.getState().toggleRightSidebarView("git");
      useDashboardStore.getState().toggleRightSidebarView("tasks");
      expect(selected()).toBeNull();
      openDetail();
      useDashboardStore.getState().openRightSidebarView("git");
      useDashboardStore.getState().openRightSidebarView("tasks");
      expect(selected()).toBeNull();
    });

    it("a task selected while the sidebar is closed is cleared on reopen", () => {
      useDashboardStore.setState({ rightSidebarView: "tasks", selectedTaskId: 7 });
      useDashboardStore.getState().toggleRightSidebar();
      expect(selected()).toBeNull();
    });

    it("re-showing the Tasks view that is already open keeps the detail", () => {
      openDetail();
      useDashboardStore.getState().openRightSidebarView("tasks");
      expect(selected()).toBe(7);
    });

    it("openRightSidebarTask lands on the task from closed and from another view", () => {
      openDetail();
      useDashboardStore.getState().closeRightSidebar();
      useDashboardStore.getState().openRightSidebarTask(8);
      expect(selected()).toBe(8);
      useDashboardStore.getState().openRightSidebarView("git");
      useDashboardStore.getState().openRightSidebarTask(9);
      expect(selected()).toBe(9);
    });
  });

  describe("GitHub drill-in reset", () => {
    const drill = () => {
      const st = useDashboardStore.getState();
      st.openRightSidebarView("github", 5);
      st.setGithubOpenPr(5, 42);
    };

    it("open PR, close, reopen lands on the list", () => {
      drill();
      useDashboardStore.getState().closeRightSidebar();
      useDashboardStore.getState().toggleRightSidebar();
      expect(useDashboardStore.getState().githubOpenPrByProject).toEqual({});
    });

    it("open PR, switch to Git, close, reopen via toggleRightSidebarView lists", () => {
      drill();
      useDashboardStore.getState().openRightSidebarView("git");
      useDashboardStore.getState().closeRightSidebar();
      useDashboardStore.getState().toggleRightSidebarView("github");
      expect(useDashboardStore.getState().githubOpenPrByProject).toEqual({});
    });

    it("open PR, switch to Git, switch back lists (PR and issue)", () => {
      drill();
      useDashboardStore.setState({ githubOpenIssueByProject: { 5: 7 } });
      useDashboardStore.getState().openRightSidebarView("git");
      useDashboardStore.getState().openRightSidebarView("github");
      const s = useDashboardStore.getState();
      expect(s.githubOpenPrByProject).toEqual({});
      expect(s.githubOpenIssueByProject).toEqual({});
    });

    it("a PR opened elsewhere while the sidebar is closed on github is cleared on reopen", () => {
      drill();
      useDashboardStore.getState().closeRightSidebar();
      useDashboardStore.getState().setGithubOpenPr(5, 9);
      useDashboardStore.getState().toggleRightSidebar();
      expect(useDashboardStore.getState().githubOpenPrByProject).toEqual({});
    });

    it("openRightSidebarPr lands on the PR, also from git and when already on github", () => {
      useDashboardStore.getState().openRightSidebarView("git");
      useDashboardStore.getState().openRightSidebarPr(5, 11);
      expect(useDashboardStore.getState().githubOpenPrByProject[5]).toBe(11);
      useDashboardStore.getState().openRightSidebarPr(5, 12);
      expect(useDashboardStore.getState().githubOpenPrByProject[5]).toBe(12);
    });

    it("the in-PR back button (setGithubOpenPr null) returns to the list", () => {
      drill();
      useDashboardStore.getState().setGithubOpenPr(5, null);
      expect(useDashboardStore.getState().githubOpenPrByProject[5]).toBeNull();
    });
  });
});
