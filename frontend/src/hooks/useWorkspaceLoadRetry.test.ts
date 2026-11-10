// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWorkspaceLoadRetry } from "./useWorkspaceLoadRetry.js";

const refreshWorkspaces = vi.fn();
const setWorkspacesLoaded = vi.fn();
const setWorkspaceLoadFailed = vi.fn();

function storeState() {
  return { refreshWorkspaces };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderRetry(workspaceLoadNonce = 0) {
  return renderHook(
    ({ nonce }: { nonce: number }) =>
      useWorkspaceLoadRetry({
        workspaceLoadNonce: nonce,
        setWorkspacesLoaded,
        setWorkspaceLoadFailed,
      }),
    { initialProps: { nonce: workspaceLoadNonce } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  refreshWorkspaces.mockReset();
  setWorkspacesLoaded.mockReset();
  setWorkspaceLoadFailed.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useWorkspaceLoadRetry", () => {
  it("marks the list loaded on the first successful fetch", async () => {
    refreshWorkspaces.mockResolvedValue(undefined);
    renderRetry();
    await flush();
    expect(refreshWorkspaces).toHaveBeenCalledTimes(1);
    expect(setWorkspacesLoaded).toHaveBeenCalledWith(true);
    expect(setWorkspaceLoadFailed).toHaveBeenCalledWith(false);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("backs off 500ms, 1s, 2s and 4s, then gives up", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    refreshWorkspaces.mockRejectedValue(new Error("offline"));
    renderRetry();

    await flush();
    expect(refreshWorkspaces).toHaveBeenCalledTimes(1);
    await flush(499);
    expect(refreshWorkspaces).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(refreshWorkspaces).toHaveBeenCalledTimes(2);
    await flush(1000);
    expect(refreshWorkspaces).toHaveBeenCalledTimes(3);
    await flush(2000);
    expect(refreshWorkspaces).toHaveBeenCalledTimes(4);
    await flush(4000);
    expect(refreshWorkspaces).toHaveBeenCalledTimes(5);
    expect(setWorkspacesLoaded).not.toHaveBeenCalled();
    expect(setWorkspaceLoadFailed).toHaveBeenCalledWith(true);
    expect(consoleError).toHaveBeenCalledWith(
      "[workspace] failed to load workspaces, giving up",
      expect.any(Error),
    );

    await flush(8000);
    expect(refreshWorkspaces).toHaveBeenCalledTimes(5);
  });

  it("starts a fresh round on online, and on visibility once the tab is actually visible", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refreshWorkspaces.mockRejectedValue(new Error("offline"));
    renderRetry();
    await flush(60_000);
    expect(refreshWorkspaces).toHaveBeenCalledTimes(5);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(5);

    visibility.mockReturnValue("visible");
    refreshWorkspaces.mockResolvedValue(undefined);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(6);
    expect(setWorkspacesLoaded).toHaveBeenCalledWith(true);
    expect(setWorkspaceLoadFailed).toHaveBeenCalledWith(false);

    // Rearming disarms: a second online/visibility pair does not load again.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(6);
  });

  it("drops a pending retry and the rearm listeners when unmounted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refreshWorkspaces.mockRejectedValue(new Error("offline"));
    const pending = renderRetry();
    await flush();
    expect(refreshWorkspaces).toHaveBeenCalledTimes(1);
    pending.unmount();
    await flush(60_000);
    expect(refreshWorkspaces).toHaveBeenCalledTimes(1);

    const givenUp = renderRetry();
    await flush(60_000);
    expect(refreshWorkspaces).toHaveBeenCalledTimes(6);
    givenUp.unmount();
    refreshWorkspaces.mockResolvedValue(undefined);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshWorkspaces).toHaveBeenCalledTimes(6);
    expect(setWorkspacesLoaded).not.toHaveBeenCalled();
  });

  it("ignores a fetch that settles after cancel, and starts over when the nonce changes", async () => {
    let rejectLoad: (err: Error) => void = () => {};
    let resolveLoad: () => void = () => {};
    refreshWorkspaces.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLoad = reject;
        }),
    );
    const first = renderRetry();
    first.unmount();
    await act(async () => {
      rejectLoad(new Error("late"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(setWorkspaceLoadFailed).not.toHaveBeenCalled();

    refreshWorkspaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = () => resolve(undefined);
        }),
    );
    const second = renderRetry(1);
    second.unmount();
    await act(async () => {
      resolveLoad();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(setWorkspacesLoaded).not.toHaveBeenCalled();

    refreshWorkspaces.mockResolvedValue(undefined);
    const third = renderRetry(2);
    await flush();
    expect(setWorkspacesLoaded).toHaveBeenCalledTimes(1);
    third.rerender({ nonce: 3 });
    await flush();
    expect(refreshWorkspaces).toHaveBeenCalledTimes(4);
    expect(setWorkspacesLoaded).toHaveBeenCalledTimes(2);
  });
});
