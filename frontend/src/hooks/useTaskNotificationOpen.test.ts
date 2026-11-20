// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTaskNotificationOpen } from "./useTaskNotificationOpen.js";
import { useDashboardStore } from "../store/index.js";

let listeners: Array<(e: MessageEvent) => void> = [];

beforeEach(() => {
  listeners = [];
  useDashboardStore.setState({
    selectedTaskId: null,
    taskSelectionSeq: 0,
    openTaskRequest: null,
    rightSidebarOpen: false,
    rightSidebarView: "git",
    viewMode: "list",
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: (e: MessageEvent) => void) => {
        listeners = listeners.filter((l) => l !== fn);
      },
    },
  });
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

function post(taskId: unknown): void {
  listeners.forEach((l) => l({ data: { type: "mullion-open-task", taskId } } as MessageEvent));
}

describe("useTaskNotificationOpen (desktop)", () => {
  it("opens the task in the sidebar's Tasks detail from a mullion-open-task message", () => {
    renderHook(() => useTaskNotificationOpen());
    post(7);
    const state = useDashboardStore.getState();
    expect(state.selectedTaskId).toBe(7);
    expect(state.rightSidebarView).toBe("tasks");
    expect(state.rightSidebarOpen).toBe(true);
    expect(state.viewMode).toBe("kanban");
    // Desktop never asks for the docked panel.
    expect(state.openTaskRequest).toBeNull();
  });

  it("ignores other messages and invalid task ids", () => {
    renderHook(() => useTaskNotificationOpen());
    listeners.forEach((l) =>
      l({ data: { type: "mullion-open-session", sessionId: 3 } } as MessageEvent),
    );
    post("x");
    const state = useDashboardStore.getState();
    expect(state.selectedTaskId).toBeNull();
    expect(state.rightSidebarOpen).toBe(false);
    expect(state.viewMode).toBe("list");
  });

  it("opens the task from ?task=<id> and strips the param", () => {
    window.history.replaceState({}, "", "/?task=12&x=1");
    renderHook(() => useTaskNotificationOpen());
    const state = useDashboardStore.getState();
    expect(state.selectedTaskId).toBe(12);
    expect(state.rightSidebarView).toBe("tasks");
    expect(state.viewMode).toBe("kanban");
    expect(window.location.search).toBe("?x=1");
  });

  it("strips a malformed ?task= without opening anything", () => {
    window.history.replaceState({}, "", "/?task=abc");
    renderHook(() => useTaskNotificationOpen());
    expect(useDashboardStore.getState().selectedTaskId).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("removes its listener on unmount", () => {
    const { unmount } = renderHook(() => useTaskNotificationOpen());
    unmount();
    expect(listeners).toHaveLength(0);
  });
});

// #3014 — the phone shows the sidebar's task detail full screen, so a
// notification opens the same detail a board card does, not a docked panel.
describe("useTaskNotificationOpen (phone)", () => {
  it("selects the task in the sidebar's Tasks view over the board, never the docked panel", () => {
    renderHook(() => useTaskNotificationOpen());
    post(7);
    const state = useDashboardStore.getState();
    expect(state.openTaskRequest).toBeNull();
    expect(state.selectedTaskId).toBe(7);
    expect(state.rightSidebarView).toBe("tasks");
    expect(state.rightSidebarOpen).toBe(true);
    expect(state.viewMode).toBe("kanban");
  });

  it("opens a ?task=<id> cold start the same way", () => {
    window.history.replaceState({}, "", "/?task=12");
    renderHook(() => useTaskNotificationOpen());
    expect(useDashboardStore.getState().selectedTaskId).toBe(12);
    expect(useDashboardStore.getState().openTaskRequest).toBeNull();
    expect(window.location.search).toBe("");
  });
});
