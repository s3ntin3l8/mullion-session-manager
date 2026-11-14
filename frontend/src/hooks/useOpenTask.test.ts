// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type * as layoutTier from "../lib/layoutTier.js";
import { useOpenTask } from "./useOpenTask.js";
import { useDashboardStore } from "../store/index.js";

let tier: "desktop" | "tablet" | "phone" = "desktop";
vi.mock("../lib/layoutTier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof layoutTier>()),
  useLayoutContext: () => ({ tier, tabletPaneCap: 2 }),
}));

beforeEach(() => {
  tier = "desktop";
  useDashboardStore.setState({
    selectedTaskId: null,
    taskSelectionSeq: 0,
    openTaskRequest: null,
    rightSidebarOpen: false,
    rightSidebarView: "git",
  });
});

describe("useOpenTask", () => {
  it("desktop: selects the task in the sidebar's Tasks view and opens the sidebar", () => {
    const { result } = renderHook(() => useOpenTask());
    result.current(5);
    const state = useDashboardStore.getState();
    expect(state.selectedTaskId).toBe(5);
    expect(state.rightSidebarView).toBe("tasks");
    expect(state.rightSidebarOpen).toBe(true);
    expect(state.openTaskRequest).toBeNull();
  });

  it("desktop: records where Back returns when the caller is itself a sidebar detail", () => {
    const { result } = renderHook(() => useOpenTask());
    result.current(5, { kind: "issue", projectId: 4, number: 9 });
    const state = useDashboardStore.getState();
    expect(state.selectedTaskId).toBe(5);
    expect(state.takeSidebarBack({ kind: "task", taskId: 5 })).toEqual({
      kind: "issue",
      projectId: 4,
      number: 9,
    });
  });

  // #3011 — the right sidebar is the one task detail from 700px: the tablet
  // tier (the 851px fold included) never asks for the docked panel.
  it("tablet: selects the task in the sidebar, never the docked panel", () => {
    tier = "tablet";
    const { result } = renderHook(() => useOpenTask());
    result.current(5, { kind: "pr", projectId: 1, number: 2 });
    const state = useDashboardStore.getState();
    expect(state.openTaskRequest).toBeNull();
    expect(state.selectedTaskId).toBe(5);
    expect(state.rightSidebarView).toBe("tasks");
    expect(state.rightSidebarOpen).toBe(true);
  });

  it("phone: asks for the docked panel", () => {
    tier = "phone";
    const { result } = renderHook(() => useOpenTask());
    result.current(5);
    const state = useDashboardStore.getState();
    expect(state.openTaskRequest?.taskId).toBe(5);
    expect(state.selectedTaskId).toBeNull();
    expect(state.rightSidebarOpen).toBe(false);
  });
});
