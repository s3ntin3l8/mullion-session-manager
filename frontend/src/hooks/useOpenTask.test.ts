// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type * as layoutTier from "../lib/layoutTier.js";
import { useCanPopOutTask, useOpenTask } from "./useOpenTask.js";
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

// #3011 — the pop-out to a docked panel follows the band, not the tier: kept
// with the desktop structure from 1100px, dropped on the rails bands below it.
describe("useCanPopOutTask", () => {
  afterEach(() => vi.unstubAllGlobals());
  const atWidth = (width: number) =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => {
        const min = /min-width: ([\d.]+)px/.exec(query);
        const max = /max-width: ([\d.]+)px/.exec(query);
        return {
          matches:
            query.includes("width") &&
            (!min || width >= Number(min[1])) &&
            (!max || width <= Number(max[1])),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
      }),
    );

  it.each([
    [500, false],
    [851, false],
    [1099, false],
    [1100, true],
    [1500, true],
  ])("at %spx: %s", (width, expected) => {
    atWidth(width);
    const { result } = renderHook(() => useCanPopOutTask());
    expect(result.current).toBe(expected);
  });
});
