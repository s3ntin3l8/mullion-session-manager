// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTaskNotificationOpen } from "./useTaskNotificationOpen.js";
import { useDashboardStore } from "../store/index.js";

let listeners: Array<(e: MessageEvent) => void> = [];

beforeEach(() => {
  listeners = [];
  useDashboardStore.setState({ pendingOpenTaskId: null, viewMode: "list" });
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

describe("useTaskNotificationOpen", () => {
  it("opens the task from a mullion-open-task message", () => {
    renderHook(() => useTaskNotificationOpen());
    listeners.forEach((l) => l({ data: { type: "mullion-open-task", taskId: 7 } } as MessageEvent));
    expect(useDashboardStore.getState().pendingOpenTaskId).toBe(7);
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
  });

  it("ignores other messages and invalid task ids", () => {
    renderHook(() => useTaskNotificationOpen());
    listeners.forEach((l) =>
      l({ data: { type: "mullion-open-session", sessionId: 3 } } as MessageEvent),
    );
    listeners.forEach((l) =>
      l({ data: { type: "mullion-open-task", taskId: "x" } } as MessageEvent),
    );
    expect(useDashboardStore.getState().pendingOpenTaskId).toBeNull();
    expect(useDashboardStore.getState().viewMode).toBe("list");
  });

  it("opens the task from ?task=<id> and strips the param", () => {
    window.history.replaceState({}, "", "/?task=12&x=1");
    renderHook(() => useTaskNotificationOpen());
    expect(useDashboardStore.getState().pendingOpenTaskId).toBe(12);
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
    expect(window.location.search).toBe("?x=1");
  });

  it("strips a malformed ?task= without opening anything", () => {
    window.history.replaceState({}, "", "/?task=abc");
    renderHook(() => useTaskNotificationOpen());
    expect(useDashboardStore.getState().pendingOpenTaskId).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("removes its listener on unmount", () => {
    const { unmount } = renderHook(() => useTaskNotificationOpen());
    unmount();
    expect(listeners).toHaveLength(0);
  });
});
