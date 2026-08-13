// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppStreams } from "./useAppStreams.js";

// Mirrors useGlobalShortcuts.test.ts's own store-mock shape: a `storeState()`
// factory serving `useDashboardStore.getState()`, the only call form this
// hook uses. Each of the four stream-starter actions returns its own
// disposer (`() => void`) — mocked here as a fresh `vi.fn()` per action so
// each disposer's own invocation can be asserted independently on unmount.
const startLiveRefreshStop = vi.fn();
const startEventsStreamStop = vi.fn();
const startTasksStreamStop = vi.fn();
const connectGitHubWSStop = vi.fn();

const startLiveRefresh = vi.fn(() => startLiveRefreshStop);
const startEventsStream = vi.fn(() => startEventsStreamStop);
const startTasksStream = vi.fn(() => startTasksStreamStop);
const connectGitHubWS = vi.fn(() => connectGitHubWSStop);

function storeState() {
  return { startLiveRefresh, startEventsStream, startTasksStream, connectGitHubWS };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useAppStreams", () => {
  it("starts all four streams exactly once on mount", () => {
    // Explicitly unmounts (rather than relying on testSetup.ts's global
    // `afterEach(cleanup)`) so no hook instance is left dangling into a
    // later test — cleanup's own disposer calls would otherwise land after
    // this file's local `afterEach(vi.clearAllMocks)` has already reset the
    // mocks' call counts, leaking a stray call into whichever test runs
    // next (confirmed empirically while writing these tests).
    const { unmount } = renderHook(() => useAppStreams());

    expect(startLiveRefresh).toHaveBeenCalledTimes(1);
    expect(startEventsStream).toHaveBeenCalledTimes(1);
    expect(startTasksStream).toHaveBeenCalledTimes(1);
    expect(connectGitHubWS).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not re-start any stream on a re-render (mount-once, empty deps)", () => {
    const { rerender, unmount } = renderHook(() => useAppStreams());
    rerender();
    rerender();

    expect(startLiveRefresh).toHaveBeenCalledTimes(1);
    expect(startEventsStream).toHaveBeenCalledTimes(1);
    expect(startTasksStream).toHaveBeenCalledTimes(1);
    expect(connectGitHubWS).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("wires each stream's returned disposer up as that effect's own cleanup, invoked on unmount", () => {
    const { unmount } = renderHook(() => useAppStreams());

    expect(startLiveRefreshStop).not.toHaveBeenCalled();
    expect(startEventsStreamStop).not.toHaveBeenCalled();
    expect(startTasksStreamStop).not.toHaveBeenCalled();
    expect(connectGitHubWSStop).not.toHaveBeenCalled();

    unmount();

    expect(startLiveRefreshStop).toHaveBeenCalledTimes(1);
    expect(startEventsStreamStop).toHaveBeenCalledTimes(1);
    expect(startTasksStreamStop).toHaveBeenCalledTimes(1);
    expect(connectGitHubWSStop).toHaveBeenCalledTimes(1);
  });

  it("does not cross-call disposers (each stream's cleanup is independent of the others)", () => {
    const { unmount } = renderHook(() => useAppStreams());
    unmount();

    expect(startLiveRefreshStop).toHaveBeenCalledTimes(1);
    expect(startEventsStreamStop).toHaveBeenCalledTimes(1);
    expect(startTasksStreamStop).toHaveBeenCalledTimes(1);
    expect(connectGitHubWSStop).toHaveBeenCalledTimes(1);
    // Starters themselves are not re-invoked by unmount.
    expect(startLiveRefresh).toHaveBeenCalledTimes(1);
    expect(startEventsStream).toHaveBeenCalledTimes(1);
    expect(startTasksStream).toHaveBeenCalledTimes(1);
    expect(connectGitHubWS).toHaveBeenCalledTimes(1);
  });

  it("simulates React StrictMode's mount-cleanup-remount dance without double-connecting", () => {
    // StrictMode (dev only) synchronously unmounts and remounts every effect
    // once. This hook's four effects have empty dependency arrays, so a
    // second real mount calls the starters again — none of the four store
    // actions guards against being called twice on its own (verified by
    // reading each slice — see useAppStreams.ts's own "Connection-lifecycle
    // correctness" header comment), so what actually prevents a real
    // double-connect is this hook's own effect sequencing: the FIRST
    // mount's disposers must actually run before the second mount's calls
    // happen, which is exactly what this test asserts.
    const { unmount: unmountFirst } = renderHook(() => useAppStreams());
    unmountFirst();

    expect(startLiveRefreshStop).toHaveBeenCalledTimes(1);
    expect(startEventsStreamStop).toHaveBeenCalledTimes(1);
    expect(startTasksStreamStop).toHaveBeenCalledTimes(1);
    expect(connectGitHubWSStop).toHaveBeenCalledTimes(1);

    const { unmount: unmountSecond } = renderHook(() => useAppStreams());

    expect(startLiveRefresh).toHaveBeenCalledTimes(2);
    expect(startEventsStream).toHaveBeenCalledTimes(2);
    expect(startTasksStream).toHaveBeenCalledTimes(2);
    expect(connectGitHubWS).toHaveBeenCalledTimes(2);

    unmountSecond();

    expect(startLiveRefreshStop).toHaveBeenCalledTimes(2);
    expect(startEventsStreamStop).toHaveBeenCalledTimes(2);
    expect(startTasksStreamStop).toHaveBeenCalledTimes(2);
    expect(connectGitHubWSStop).toHaveBeenCalledTimes(2);
  });
});
