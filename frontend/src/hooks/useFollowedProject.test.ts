// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { FOLLOW_SENTINEL, useFollowedProject } from "./useFollowedProject.js";
import { useDashboardStore } from "../store/index.js";
import type { Project, Session } from "../api/index.js";

const project = (id: number, name: string) => ({ id, name }) as Project;
const session = (id: number, projectId: number) => ({ id, projectId }) as Session;

afterEach(() => {
  useDashboardStore.setState({
    projects: [],
    sessions: [],
    activePanelId: null,
    workspaces: [],
    activeWorkspaceId: null,
  });
});

describe("useFollowedProject", () => {
  it("falls back to the first project when nothing is focused", () => {
    useDashboardStore.setState({ projects: [project(1, "a"), project(2, "b")] });

    const { result } = renderHook(() => useFollowedProject());

    expect(result.current.effectiveProjectId).toBe(1);
    // The fallback is not a project a panel put there.
    expect(result.current.followSourceId).toBeNull();
    expect(result.current.dropdownValue).toBe(FOLLOW_SENTINEL);
    expect(result.current.dropdownOptions.map((o) => o.label)).toEqual([
      "Follow active panel",
      "a",
      "b",
    ]);
  });

  it("follows the focused session's project", () => {
    useDashboardStore.setState({
      projects: [project(1, "a"), project(2, "b")],
      sessions: [session(20, 2)],
      activePanelId: "session-20",
    });

    const { result } = renderHook(() => useFollowedProject());

    expect(result.current.effectiveProjectId).toBe(2);
    expect(result.current.followSourceId).toBe(2);
    expect(result.current.dropdownOptions[0].label).toBe("◎ b");
  });

  it("a pin wins over the focused panel until it is cleared via the sentinel", () => {
    useDashboardStore.setState({
      projects: [project(1, "a"), project(2, "b")],
      sessions: [session(20, 2)],
      activePanelId: "session-20",
    });
    const { result } = renderHook(() => useFollowedProject());

    act(() => result.current.onDropdownChange("1"));
    expect(result.current.effectiveProjectId).toBe(1);
    expect(result.current.dropdownValue).toBe("1");

    act(() => result.current.onDropdownChange(FOLLOW_SENTINEL));
    expect(result.current.effectiveProjectId).toBe(2);
  });

  it("releases a pinned project that is deleted", () => {
    useDashboardStore.setState({ projects: [project(1, "a"), project(2, "b")] });
    const { result } = renderHook(() => useFollowedProject());
    act(() => result.current.setPinnedProjectId(2));
    expect(result.current.effectiveProjectId).toBe(2);

    act(() => useDashboardStore.setState({ projects: [project(1, "a")] }));

    expect(result.current.pinnedProjectId).toBeNull();
    expect(result.current.effectiveProjectId).toBe(1);
  });

  // Issue #1136 — the derived id names a project `projects` doesn't hold yet.
  it("does not loop when the active panel derives to a project that has not loaded", () => {
    useDashboardStore.setState({
      projects: [],
      sessions: [session(999, 12345)],
      activePanelId: "session-999",
    });

    const { result } = renderHook(() => useFollowedProject());

    expect(result.current.effectiveProjectId).toBeNull();
  });

  describe("workspace scope (#1877)", () => {
    const three = () =>
      useDashboardStore.setState({
        projects: [project(1, "a"), project(2, "b"), project(3, "c")],
      });

    it("offers only the workspace's projects and falls back to the first of them", () => {
      three();
      const { result } = renderHook(() => useFollowedProject([2, 3]));
      expect(result.current.dropdownOptions.map((o) => o.label)).toEqual([
        "Follow active panel",
        "b",
        "c",
      ]);
      expect(result.current.effectiveProjectId).toBe(2);
    });

    it("keeps a pinned out-of-scope project selectable", () => {
      three();
      const { result } = renderHook(() => useFollowedProject([2]));
      act(() => result.current.setPinnedProjectId(1));
      expect(result.current.dropdownOptions.map((o) => o.value)).toEqual([
        FOLLOW_SENTINEL,
        "2",
        "1",
      ]);
      expect(result.current.dropdownValue).toBe("1");
    });

    it("follow → workspace switch → still following the new workspace", () => {
      three();
      useDashboardStore.setState({ sessions: [session(10, 1)], activePanelId: "session-10" });
      const { result, rerender } = renderHook(({ ids }) => useFollowedProject(ids), {
        initialProps: { ids: [1] as number[] },
      });
      act(() => result.current.onDropdownChange(FOLLOW_SENTINEL));
      expect(result.current.effectiveProjectId).toBe(1);

      // Switch workspace: the focused panel goes away, the scope changes.
      act(() => useDashboardStore.setState({ activePanelId: null }));
      rerender({ ids: [2, 3] });
      expect(result.current.pinnedProjectId).toBeNull();
      expect(result.current.dropdownValue).toBe(FOLLOW_SENTINEL);
      expect(result.current.effectiveProjectId).toBe(2);
      expect(result.current.dropdownOptions[0].label).toBe("Follow active panel");

      // Focusing a panel in the new workspace is followed again.
      act(() =>
        useDashboardStore.setState({ sessions: [session(30, 3)], activePanelId: "session-30" }),
      );
      expect(result.current.effectiveProjectId).toBe(3);
      expect(result.current.dropdownOptions[0].label).toBe("◎ c");
    });

    it("pin → workspace switch → still pinned", () => {
      three();
      const { result, rerender } = renderHook(({ ids }) => useFollowedProject(ids), {
        initialProps: { ids: [1, 2] as number[] },
      });
      act(() => result.current.onDropdownChange("1"));

      rerender({ ids: [2, 3] });

      expect(result.current.pinnedProjectId).toBe(1);
      expect(result.current.effectiveProjectId).toBe(1);
      expect(result.current.dropdownValue).toBe("1");
    });

    it("null means unscoped", () => {
      three();
      const { result } = renderHook(() => useFollowedProject(null));
      expect(result.current.dropdownOptions).toHaveLength(4);
    });
  });
});

describe("useFollowedProject — workspace pins (#3537)", () => {
  const ws = (id: number, pinnedProjectIds: number[]) =>
    ({
      id,
      name: `w${id}`,
      layout: null,
      groupId: null,
      position: 0,
      createdAt: "",
      pinnedProjectIds,
    }) as never;
  const labels = (r: { current: ReturnType<typeof useFollowedProject> }) =>
    r.current.dropdownOptions.slice(1).map((o) => o.label);

  it("offers the active workspace's pinned project with nothing tiled", () => {
    useDashboardStore.setState({
      projects: [project(1, "a"), project(2, "b"), project(3, "c")],
      workspaces: [ws(1, [3]), ws(2, [2])],
      activeWorkspaceId: 1,
    });

    const { result } = renderHook(() => useFollowedProject([]));

    expect(labels(result)).toEqual(["c"]);
    expect(result.current.effectiveProjectId).toBe(3);
  });

  it("follows a workspace switch to that workspace's pins", () => {
    useDashboardStore.setState({
      projects: [project(1, "a"), project(2, "b"), project(3, "c")],
      workspaces: [ws(1, [3]), ws(2, [2])],
      activeWorkspaceId: 1,
    });
    const { result } = renderHook(() => useFollowedProject([1]));
    expect(labels(result)).toEqual(["a", "c"]);

    act(() => useDashboardStore.setState({ activeWorkspaceId: 2 }));
    expect(labels(result)).toEqual(["a", "b"]);
  });

  it("ignores pins when unscoped (phone)", () => {
    useDashboardStore.setState({
      projects: [project(1, "a"), project(2, "b")],
      workspaces: [ws(1, [2])],
      activeWorkspaceId: 1,
    });
    const { result } = renderHook(() => useFollowedProject(null));
    expect(labels(result)).toEqual(["a", "b"]);
  });
});
