// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOpenTaskRequest } from "./useOpenTaskRequest.js";
import { makeTask } from "../test/fixtures.js";
import type { Task } from "../api/index.js";
import type { DockviewApi } from "dockview-react";

// Same store-mock shape as useOpenSessionRequest.test.ts: the request is read
// through a selector, everything else through getState().
let openTaskRequest: { taskId: number; nonce: number } | null = null;
let tasks: Task[] = [];
const clearOpenTaskRequest = vi.fn((nonce: number) => {
  if (openTaskRequest?.nonce === nonce) openTaskRequest = null;
});
let refreshResult: Task[] = [];
const refreshTasks = vi.fn(async () => {
  tasks = refreshResult;
});

function storeState() {
  return { openTaskRequest, tasks, clearOpenTaskRequest, refreshTasks };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

const baseProps = {
  dockviewApi: {} as DockviewApi,
  activeWorkspaceId: 1,
  restoringRef: { current: false },
  restoredWorkspaceIdRef: { current: 1 } as { current: number | null },
};

beforeEach(() => {
  openTaskRequest = null;
  tasks = [];
  refreshResult = [];
  clearOpenTaskRequest.mockClear();
  refreshTasks.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useOpenTaskRequest", () => {
  it("does nothing with no request pending", () => {
    vi.useFakeTimers();
    const onOpenTask = vi.fn();
    renderHook(() => useOpenTaskRequest({ ...baseProps, onOpenTask }));
    vi.advanceTimersByTime(1000);
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("opens a task the store already holds, and clears that request", () => {
    vi.useFakeTimers();
    const task = makeTask({ id: 5 });
    tasks = [task];
    openTaskRequest = { taskId: 5, nonce: 1 };
    const onOpenTask = vi.fn();
    renderHook(() => useOpenTaskRequest({ ...baseProps, onOpenTask }));
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onOpenTask).toHaveBeenCalledWith(task);
    expect(clearOpenTaskRequest).toHaveBeenCalledWith(1);
    expect(refreshTasks).not.toHaveBeenCalled();
  });

  // The store's nonce restarts at 1 after a clear: a second click must not be
  // mistaken for the request just resolved.
  it("opens a second request that reuses the cleared nonce", () => {
    vi.useFakeTimers();
    tasks = [makeTask({ id: 5 }), makeTask({ id: 6 })];
    openTaskRequest = { taskId: 5, nonce: 1 };
    const onOpenTask = vi.fn();
    const { rerender } = renderHook(() => useOpenTaskRequest({ ...baseProps, onOpenTask }));
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(openTaskRequest).toBeNull();
    rerender();
    openTaskRequest = { taskId: 6, nonce: 1 };
    rerender();
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onOpenTask.mock.calls.map(([t]) => (t as Task).id)).toEqual([5, 6]);
  });

  it("waits for dockview and the workspace restore", () => {
    vi.useFakeTimers();
    tasks = [makeTask({ id: 5 })];
    openTaskRequest = { taskId: 5, nonce: 1 };
    const onOpenTask = vi.fn();
    const restoredWorkspaceIdRef: { current: number | null } = { current: null };
    const { rerender } = renderHook(
      (p: { dockviewApi: DockviewApi | null }) =>
        useOpenTaskRequest({
          ...baseProps,
          dockviewApi: p.dockviewApi,
          restoredWorkspaceIdRef,
          onOpenTask,
        }),
      { initialProps: { dockviewApi: null as DockviewApi | null } },
    );
    vi.advanceTimersByTime(10);
    expect(onOpenTask).not.toHaveBeenCalled();
    rerender({ dockviewApi: {} as DockviewApi });
    vi.advanceTimersByTime(10);
    expect(onOpenTask).not.toHaveBeenCalled();
    restoredWorkspaceIdRef.current = 1;
    rerender({ dockviewApi: {} as DockviewApi });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });

  it("retries while a workspace restore is still in flight", () => {
    vi.useFakeTimers();
    tasks = [makeTask({ id: 5 })];
    openTaskRequest = { taskId: 5, nonce: 1 };
    const onOpenTask = vi.fn();
    const restoringRef = { current: true };
    renderHook(() => useOpenTaskRequest({ ...baseProps, restoringRef, onOpenTask }));
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onOpenTask).not.toHaveBeenCalled();
    restoringRef.current = false;
    act(() => {
      vi.advanceTimersByTime(0);
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });

  it("fetches a task the store does not hold yet, then opens it", async () => {
    const task = makeTask({ id: 9 });
    let release!: () => void;
    refreshTasks.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            tasks = [task];
            resolve();
          };
        }),
    );
    openTaskRequest = { taskId: 9, nonce: 1 };
    const onOpenTask = vi.fn();
    const { rerender } = renderHook(
      (p: { onOpenTask: (t: Task) => void }) => useOpenTaskRequest({ ...baseProps, ...p }),
      { initialProps: { onOpenTask: vi.fn() } },
    );
    await vi.waitFor(() => expect(refreshTasks).toHaveBeenCalledTimes(1));
    // The clear re-runs the effect (and a new onOpenTask may arrive) while the
    // refresh is still in flight; neither may cancel the pending open, and it
    // goes through the latest opener.
    rerender({ onOpenTask });
    release();
    await vi.waitFor(() => expect(onOpenTask).toHaveBeenCalledWith(task));
    expect(clearOpenTaskRequest).toHaveBeenCalledWith(1);
  });

  it("drops a task that is still missing after the refresh", async () => {
    openTaskRequest = { taskId: 9, nonce: 1 };
    const onOpenTask = vi.fn();
    renderHook(() => useOpenTaskRequest({ ...baseProps, onOpenTask }));
    await vi.waitFor(() => expect(refreshTasks).toHaveBeenCalled());
    await Promise.resolve();
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("does not open a fetched task after unmount", async () => {
    let release!: () => void;
    refreshTasks.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            tasks = [makeTask({ id: 9 })];
            resolve();
          };
        }),
    );
    openTaskRequest = { taskId: 9, nonce: 1 };
    const onOpenTask = vi.fn();
    const { unmount } = renderHook(() => useOpenTaskRequest({ ...baseProps, onOpenTask }));
    await vi.waitFor(() => expect(refreshTasks).toHaveBeenCalled());
    unmount();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(onOpenTask).not.toHaveBeenCalled();
  });
});
