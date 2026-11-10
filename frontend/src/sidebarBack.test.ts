import { afterEach, describe, expect, it, vi } from "vitest";
import { useDashboardStore } from "./store/index.js";
import { goSidebarBack } from "./sidebarBack.js";

describe("goSidebarBack", () => {
  afterEach(() => useDashboardStore.setState({ sidebarBack: null }));

  it("runs the view's own Back when nothing was recorded", () => {
    const fallback = vi.fn();
    goSidebarBack({ kind: "pr", projectId: 3, number: 12 }, fallback);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("returns a PR opened from a task to that task, not the list", () => {
    const openRightSidebarTask = vi.fn();
    useDashboardStore.setState({ openRightSidebarTask });
    useDashboardStore.setState({
      sidebarBack: {
        to: { kind: "pr", projectId: 3, number: 12 },
        back: { kind: "task", taskId: 5 },
      },
    });
    const fallback = vi.fn();
    goSidebarBack({ kind: "pr", projectId: 3, number: 12 }, fallback);
    expect(openRightSidebarTask).toHaveBeenCalledWith(5);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("returns a task opened from a PR or an issue to it", () => {
    const openRightSidebarPr = vi.fn();
    const openRightSidebarIssue = vi.fn();
    useDashboardStore.setState({ openRightSidebarPr, openRightSidebarIssue });
    useDashboardStore.setState({
      sidebarBack: {
        to: { kind: "task", taskId: 5 },
        back: { kind: "pr", projectId: 3, number: 12 },
      },
    });
    goSidebarBack({ kind: "task", taskId: 5 }, vi.fn());
    expect(openRightSidebarPr).toHaveBeenCalledWith(3, 12);
    useDashboardStore.setState({
      sidebarBack: {
        to: { kind: "task", taskId: 5 },
        back: { kind: "issue", projectId: 3, number: 7 },
      },
    });
    goSidebarBack({ kind: "task", taskId: 5 }, vi.fn());
    expect(openRightSidebarIssue).toHaveBeenCalledWith(3, 7);
  });
});
