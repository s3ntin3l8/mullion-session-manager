import { afterEach, describe, expect, it, vi } from "vitest";
import { useDashboardStore } from "./store/index.js";
import { goSidebarBack } from "./sidebarBack.js";

const real = (() => {
  const s = useDashboardStore.getState();
  return {
    openRightSidebarTask: s.openRightSidebarTask,
    openRightSidebarPr: s.openRightSidebarPr,
    openRightSidebarIssue: s.openRightSidebarIssue,
  };
})();

describe("goSidebarBack", () => {
  afterEach(() => useDashboardStore.setState({ ...real, sidebarHistory: [] }));

  it("runs the view's own Back when nothing was recorded", () => {
    const fallback = vi.fn();
    goSidebarBack({ kind: "pr", projectId: 3, number: 12 }, fallback);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("returns a PR opened from a task to that task, not the list", () => {
    const openRightSidebarTask = vi.fn();
    useDashboardStore.setState({ openRightSidebarTask });
    useDashboardStore.setState({
      sidebarHistory: [
        { to: { kind: "pr", projectId: 3, number: 12 }, back: { kind: "task", taskId: 5 } },
      ],
    });
    const fallback = vi.fn();
    goSidebarBack({ kind: "pr", projectId: 3, number: 12 }, fallback);
    expect(openRightSidebarTask).toHaveBeenCalledWith(5, null);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("returns a task opened from a PR or an issue to it", () => {
    const openRightSidebarPr = vi.fn();
    const openRightSidebarIssue = vi.fn();
    useDashboardStore.setState({ openRightSidebarPr, openRightSidebarIssue });
    useDashboardStore.setState({
      sidebarHistory: [
        { to: { kind: "task", taskId: 5 }, back: { kind: "pr", projectId: 3, number: 12 } },
      ],
    });
    goSidebarBack({ kind: "task", taskId: 5 }, vi.fn());
    expect(openRightSidebarPr).toHaveBeenCalledWith(3, 12, null);
    useDashboardStore.setState({
      sidebarHistory: [
        { to: { kind: "task", taskId: 5 }, back: { kind: "issue", projectId: 3, number: 7 } },
      ],
    });
    goSidebarBack({ kind: "task", taskId: 5 }, vi.fn());
    expect(openRightSidebarIssue).toHaveBeenCalledWith(3, 7, null);
  });

  it("unwinds a task → PR → task chain one step at a time", () => {
    const store = useDashboardStore.getState();
    store.selectTask(5);
    store.openRightSidebarPr(3, 12, { kind: "task", taskId: 5 });
    store.openRightSidebarTask(6, { kind: "pr", projectId: 3, number: 12 });
    const fallback = vi.fn();
    goSidebarBack({ kind: "task", taskId: 6 }, fallback);
    expect(useDashboardStore.getState().rightSidebarView).toBe("github");
    goSidebarBack({ kind: "pr", projectId: 3, number: 12 }, fallback);
    expect(useDashboardStore.getState().rightSidebarView).toBe("tasks");
    expect(useDashboardStore.getState().selectedTaskId).toBe(5);
    expect(useDashboardStore.getState().sidebarHistory).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
    goSidebarBack({ kind: "task", taskId: 5 }, fallback);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
