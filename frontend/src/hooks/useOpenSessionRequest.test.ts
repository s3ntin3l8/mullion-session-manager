// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOpenSessionRequest } from "./useOpenSessionRequest.js";
import { makeSession } from "../test/fixtures.js";
import type { DockviewApi } from "dockview-react";

// Mirrors useSessionDeepLink.test.ts's own store-mock shape — this hook
// reads `openSessionRequest` via a selector (so a test can change it between
// renders and see the hook react, the same way the real store does) and
// calls `markSessionRead` via `.getState()`.
let openSessionRequest: { sessionId: number; nonce: number } | null = null;
const markSessionRead = vi.fn();

function storeState() {
  return { openSessionRequest, markSessionRead };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

beforeEach(() => {
  openSessionRequest = null;
  markSessionRead.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useOpenSessionRequest", () => {
  it("does nothing with no request pending", () => {
    vi.useFakeTimers();
    const onOpenSession = vi.fn();
    renderHook(() =>
      useOpenSessionRequest({
        dockviewApi: {} as DockviewApi,
        activeWorkspaceId: 1,
        sessionsLoaded: true,
        sessions: [makeSession({ id: 7 })],
        onOpenSession,
        restoringRef: { current: false },
        restoredWorkspaceIdRef: { current: 1 },
      }),
    );
    vi.advanceTimersByTime(1000);
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(markSessionRead).not.toHaveBeenCalled();
  });

  it("does nothing until dockviewApi, workspace-restore, and sessionsLoaded all gate open", () => {
    vi.useFakeTimers();
    openSessionRequest = { sessionId: 7, nonce: 1 };
    const onOpenSession = vi.fn();
    const restoringRef = { current: false };
    const restoredWorkspaceIdRef: { current: number | null } = { current: null };

    const { rerender } = renderHook(
      (props: { dockviewApi: DockviewApi | null; sessionsLoaded: boolean }) =>
        useOpenSessionRequest({
          dockviewApi: props.dockviewApi,
          activeWorkspaceId: 1,
          sessionsLoaded: props.sessionsLoaded,
          sessions: [makeSession({ id: 7 })],
          onOpenSession,
          restoringRef,
          restoredWorkspaceIdRef,
        }),
      {
        initialProps: { dockviewApi: null, sessionsLoaded: true } as {
          dockviewApi: DockviewApi | null;
          sessionsLoaded: boolean;
        },
      },
    );
    vi.advanceTimersByTime(1000);
    expect(onOpenSession).not.toHaveBeenCalled();

    // dockviewApi now present, but restoredWorkspaceIdRef doesn't match
    // activeWorkspaceId yet.
    rerender({ dockviewApi: {} as DockviewApi, sessionsLoaded: true });
    vi.advanceTimersByTime(1000);
    expect(onOpenSession).not.toHaveBeenCalled();

    // sessionsLoaded false even once workspace/dockviewApi gates pass.
    restoredWorkspaceIdRef.current = 1;
    rerender({ dockviewApi: {} as DockviewApi, sessionsLoaded: false });
    vi.advanceTimersByTime(1000);
    expect(onOpenSession).not.toHaveBeenCalled();

    // All gates finally satisfied.
    rerender({ dockviewApi: {} as DockviewApi, sessionsLoaded: true });
    vi.advanceTimersByTime(0);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(markSessionRead).toHaveBeenCalledWith(7);
  });

  it("retries via setTimeout(0) while restoringRef.current is true, and succeeds once it flips false", () => {
    vi.useFakeTimers();
    openSessionRequest = { sessionId: 7, nonce: 1 };
    const onOpenSession = vi.fn();
    const restoringRef = { current: true };
    const restoredWorkspaceIdRef = { current: 1 };

    renderHook(() =>
      useOpenSessionRequest({
        dockviewApi: {} as DockviewApi,
        activeWorkspaceId: 1,
        sessionsLoaded: true,
        sessions: [makeSession({ id: 7 })],
        onOpenSession,
        restoringRef,
        restoredWorkspaceIdRef,
      }),
    );

    act(() => vi.advanceTimersByTime(0));
    expect(onOpenSession).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(0));
    expect(onOpenSession).not.toHaveBeenCalled();

    restoringRef.current = false;
    act(() => vi.advanceTimersByTime(0));
    // Consuming the request itself is deferred one more macrotask (the
    // onOpenSession setTimeout(0)).
    act(() => vi.advanceTimersByTime(0));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
  });

  // Self-review — resolvedNonceRef used to be set synchronously, before the
  // deferred onOpenSession call actually ran; an effect re-run (sessions
  // gets a fresh identity on every live-refresh poll tick, in this hook's
  // own dependency array) landing in that gap cleared the pending timer via
  // cleanup and then silently gave up, having already marked the nonce
  // resolved — permanently dropping the request. This proves that gap no
  // longer drops it: the request is only considered resolved once the
  // deferred call actually fires.
  it("still resolves a request even if the effect re-runs (a fresh `sessions` identity) before its deferred call fires", () => {
    vi.useFakeTimers();
    openSessionRequest = { sessionId: 7, nonce: 1 };
    const onOpenSession = vi.fn();

    const { rerender } = renderHook(
      (props: { sessions: ReturnType<typeof makeSession>[] }) =>
        useOpenSessionRequest({
          dockviewApi: {} as DockviewApi,
          activeWorkspaceId: 1,
          sessionsLoaded: true,
          sessions: props.sessions,
          onOpenSession,
          restoringRef: { current: false },
          restoredWorkspaceIdRef: { current: 1 },
        }),
      { initialProps: { sessions: [makeSession({ id: 7 })] } },
    );

    // A poll tick lands before the setTimeout(0) below has fired, with a
    // brand-new `sessions` array reference (same content) — exactly the
    // "identity churns every tick regardless of content" shape a real
    // live-refresh produces.
    rerender({ sessions: [makeSession({ id: 7 })] });

    vi.advanceTimersByTime(0);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
  });

  it("drops a request for a session that's since been killed, without opening or marking it read", () => {
    vi.useFakeTimers();
    openSessionRequest = { sessionId: 7, nonce: 1 };
    const onOpenSession = vi.fn();

    renderHook(() =>
      useOpenSessionRequest({
        dockviewApi: {} as DockviewApi,
        activeWorkspaceId: 1,
        sessionsLoaded: true,
        sessions: [makeSession({ id: 7, status: "killed" })],
        onOpenSession,
        restoringRef: { current: false },
        restoredWorkspaceIdRef: { current: 1 },
      }),
    );
    vi.advanceTimersByTime(0);

    expect(onOpenSession).not.toHaveBeenCalled();
    expect(markSessionRead).not.toHaveBeenCalled();
  });

  it("resolves a SECOND request (a fresh nonce) for a different session, without re-firing the first", () => {
    vi.useFakeTimers();
    openSessionRequest = { sessionId: 7, nonce: 1 };
    const onOpenSession = vi.fn();
    const restoringRef = { current: false };
    const restoredWorkspaceIdRef = { current: 1 };

    const { rerender } = renderHook(
      (props: { sessions: ReturnType<typeof makeSession>[] }) =>
        useOpenSessionRequest({
          dockviewApi: {} as DockviewApi,
          activeWorkspaceId: 1,
          sessionsLoaded: true,
          sessions: props.sessions,
          onOpenSession,
          restoringRef,
          restoredWorkspaceIdRef,
        }),
      { initialProps: { sessions: [makeSession({ id: 7 }), makeSession({ id: 8 })] } },
    );
    vi.advanceTimersByTime(0);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));

    // A re-render with the SAME (already-resolved) nonce must not re-fire.
    rerender({ sessions: [makeSession({ id: 7 }), makeSession({ id: 8 })] });
    vi.advanceTimersByTime(0);
    expect(onOpenSession).toHaveBeenCalledTimes(1);

    // A fresh request (new nonce) for a different session fires again.
    openSessionRequest = { sessionId: 8, nonce: 2 };
    rerender({ sessions: [makeSession({ id: 7 }), makeSession({ id: 8 })] });
    vi.advanceTimersByTime(0);
    expect(onOpenSession).toHaveBeenCalledTimes(2);
    expect(onOpenSession).toHaveBeenLastCalledWith(expect.objectContaining({ id: 8 }));
  });
});
