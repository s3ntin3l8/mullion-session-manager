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
    renderHook(() => useTaskNotificationOpen(false));
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
    renderHook(() => useTaskNotificationOpen(false));
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
    renderHook(() => useTaskNotificationOpen(false));
    const state = useDashboardStore.getState();
    expect(state.selectedTaskId).toBe(12);
    expect(state.rightSidebarView).toBe("tasks");
    expect(state.viewMode).toBe("kanban");
    expect(window.location.search).toBe("?x=1");
  });

  it("strips a malformed ?task= without opening anything", () => {
    window.history.replaceState({}, "", "/?task=abc");
    renderHook(() => useTaskNotificationOpen(false));
    expect(useDashboardStore.getState().selectedTaskId).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("removes its listener on unmount", () => {
    const { unmount } = renderHook(() => useTaskNotificationOpen(false));
    unmount();
    expect(listeners).toHaveLength(0);
  });
});

describe("useTaskNotificationOpen (phone and tablet)", () => {
  it("asks for the full-screen docked panel instead of selecting in a sidebar that is not there", () => {
    renderHook(() => useTaskNotificationOpen(true));
    post(7);
    const state = useDashboardStore.getState();
    expect(state.openTaskRequest?.taskId).toBe(7);
    expect(state.selectedTaskId).toBeNull();
    expect(state.rightSidebarOpen).toBe(false);
    // The docked-panel opener leaves the Tasks view itself; switching to it
    // first would only open the navigator over the panel.
    expect(state.viewMode).toBe("list");
  });

  it("opens a ?task=<id> cold start the same way", () => {
    window.history.replaceState({}, "", "/?task=12");
    renderHook(() => useTaskNotificationOpen(true));
    expect(useDashboardStore.getState().openTaskRequest?.taskId).toBe(12);
    expect(window.location.search).toBe("");
  });

  it("follows a tier change without re-reading the URL", () => {
    const { rerender } = renderHook(({ compact }) => useTaskNotificationOpen(compact), {
      initialProps: { compact: false },
    });
    rerender({ compact: true });
    post(3);
    expect(useDashboardStore.getState().openTaskRequest?.taskId).toBe(3);
    expect(useDashboardStore.getState().selectedTaskId).toBeNull();
  });
});
