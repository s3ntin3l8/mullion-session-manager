// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { FOLLOW_SENTINEL, useFollowedProject } from "./useFollowedProject.js";
import { useDashboardStore } from "../store/index.js";
import type { Project, Session } from "../api/index.js";

const project = (id: number, name: string) => ({ id, name }) as Project;
const session = (id: number, projectId: number) => ({ id, projectId }) as Session;

afterEach(() => {
  useDashboardStore.setState({ projects: [], sessions: [], activePanelId: null });
});

describe("useFollowedProject", () => {
  it("falls back to the first project when nothing is focused", () => {
    useDashboardStore.setState({ projects: [project(1, "a"), project(2, "b")] });

    const { result } = renderHook(() => useFollowedProject());

    expect(result.current.effectiveProjectId).toBe(1);
    expect(result.current.dropdownValue).toBe(FOLLOW_SENTINEL);
    expect(result.current.dropdownOptions.map((o) => o.label)).toEqual(["Following: a", "a", "b"]);
  });

  it("follows the focused session's project", () => {
    useDashboardStore.setState({
      projects: [project(1, "a"), project(2, "b")],
      sessions: [session(20, 2)],
      activePanelId: "session-20",
    });

    const { result } = renderHook(() => useFollowedProject());

    expect(result.current.effectiveProjectId).toBe(2);
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
});
