// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import type { Session } from "../api/index.js";
import { makeSession } from "../test/fixtures.js";
import { usePushSessionOpen } from "./usePushSessionOpen.js";
import type { UsePushSessionOpenParams } from "./usePushSessionOpen.js";

const markSessionRead = vi.fn();
const ackAttention = vi.fn();

function storeState() {
  return { markSessionRead, ackAttention };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

let listeners: Array<(event: MessageEvent) => void> = [];

function installServiceWorker() {
  listeners = [];
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: (_type: string, fn: (event: MessageEvent) => void) => {
        listeners.push(fn);
      },
      removeEventListener: (_type: string, fn: (event: MessageEvent) => void) => {
        listeners = listeners.filter((listener) => listener !== fn);
      },
    },
  });
}

function post(data: unknown) {
  for (const listener of [...listeners]) listener({ data } as MessageEvent);
}

const onOpenSession = vi.fn();
const sessionsRef = { current: [] as Session[] };
const onOpenSessionRef = { current: onOpenSession };
const restoringRef = { current: false };
const restoredWorkspaceIdRef = { current: 1 as number | null };
const pendingPushSessionIdRef = { current: null as number | null };
const pushRetryTimerRef = { current: null as ReturnType<typeof setTimeout> | null };

function props(overrides: Partial<UsePushSessionOpenParams> = {}): UsePushSessionOpenParams {
  return {
    dockviewApi: {} as DockviewApi,
    activeWorkspaceId: 1,
    sessionsLoaded: true,
    sessionsRef,
    onOpenSessionRef,
    restoringRef,
    restoredWorkspaceIdRef,
    pendingPushSessionIdRef,
    pushRetryTimerRef,
    ...overrides,
  };
}

beforeEach(() => {
  installServiceWorker();
  markSessionRead.mockClear();
  ackAttention.mockClear();
  onOpenSession.mockClear();
  sessionsRef.current = [];
  onOpenSessionRef.current = onOpenSession;
  restoringRef.current = false;
  restoredWorkspaceIdRef.current = 1;
  pendingPushSessionIdRef.current = null;
  pushRetryTimerRef.current = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePushSessionOpen", () => {
  it("does nothing when the browser has no service worker", () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    expect("serviceWorker" in navigator).toBe(false);
    pendingPushSessionIdRef.current = 7;
    sessionsRef.current = [makeSession({ id: 7 })];
    renderHook(() => usePushSessionOpen(props()));
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
    expect(pendingPushSessionIdRef.current).toBe(7);
  });

  it("ignores unrelated messages and a mount with nothing pending", () => {
    renderHook(() => usePushSessionOpen(props()));
    post(null);
    post({ type: "mullion-open-task", sessionId: 7 });
    expect(pendingPushSessionIdRef.current).toBeNull();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(markSessionRead).not.toHaveBeenCalled();
  });

  it("holds a push until dockview, the restored workspace, and sessions are all ready", () => {
    const session = makeSession({ id: 7 });
    sessionsRef.current = [session];
    const initial = props({
      dockviewApi: null,
      activeWorkspaceId: null,
      sessionsLoaded: false,
    });
    const { rerender } = renderHook((p: UsePushSessionOpenParams) => usePushSessionOpen(p), {
      initialProps: initial,
    });
    post({ type: "mullion-open-session", sessionId: 7 });
    expect(pendingPushSessionIdRef.current).toBe(7);
    expect(onOpenSession).not.toHaveBeenCalled();

    // Workspace id is set, but it is not the one restore finished.
    restoredWorkspaceIdRef.current = 2;
    rerender(props({ activeWorkspaceId: 1, sessionsLoaded: true }));
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(pendingPushSessionIdRef.current).toBe(7);

    restoredWorkspaceIdRef.current = 1;
    rerender(props({ activeWorkspaceId: 1, sessionsLoaded: true }));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(session);
    expect(markSessionRead).toHaveBeenCalledWith(7);
    expect(ackAttention).toHaveBeenCalledWith(7);
    expect(pendingPushSessionIdRef.current).toBeNull();
  });

  it("opens a pending id that was already queued before the effect mounted", () => {
    const session = makeSession({ id: 4, status: "exited" });
    sessionsRef.current = [session];
    pendingPushSessionIdRef.current = 4;
    renderHook(() => usePushSessionOpen(props()));
    expect(onOpenSession).toHaveBeenCalledWith(session);
    expect(markSessionRead).toHaveBeenCalledWith(4);
    expect(ackAttention).toHaveBeenCalledWith(4);
  });

  it("drops an unknown id, and a killed session, instead of leaving them pending", () => {
    const { rerender } = renderHook((p: UsePushSessionOpenParams) => usePushSessionOpen(p), {
      initialProps: props(),
    });
    post({ type: "mullion-open-session", sessionId: 99 });
    expect(pendingPushSessionIdRef.current).toBeNull();
    expect(onOpenSession).not.toHaveBeenCalled();

    // Arriving later does not revive an id that was already dropped.
    sessionsRef.current = [makeSession({ id: 99 })];
    rerender(props({ sessionsLoaded: true, activeWorkspaceId: 2 }));
    restoredWorkspaceIdRef.current = 2;
    rerender(props({ sessionsLoaded: true, activeWorkspaceId: 2 }));
    expect(onOpenSession).not.toHaveBeenCalled();

    sessionsRef.current = [makeSession({ id: 5, status: "killed" })];
    post({ type: "mullion-open-session", sessionId: 5 });
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(markSessionRead).not.toHaveBeenCalled();
    expect(ackAttention).not.toHaveBeenCalled();
    expect(pendingPushSessionIdRef.current).toBeNull();
  });

  it("retries once on the next macrotask while a restore is in progress, and not twice", () => {
    vi.useFakeTimers();
    const session = makeSession({ id: 7 });
    sessionsRef.current = [session];
    restoringRef.current = true;
    renderHook(() => usePushSessionOpen(props()));
    post({ type: "mullion-open-session", sessionId: 7 });
    expect(onOpenSession).not.toHaveBeenCalled();
    const armed = pushRetryTimerRef.current;
    expect(armed).not.toBeNull();

    // A second message while the timer is already armed must not replace it.
    post({ type: "mullion-open-session", sessionId: 7 });
    expect(pushRetryTimerRef.current).toBe(armed);

    restoringRef.current = false;
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(session);
    expect(markSessionRead).toHaveBeenCalledWith(7);
    expect(ackAttention).toHaveBeenCalledWith(7);
    expect(pendingPushSessionIdRef.current).toBeNull();
    expect(pushRetryTimerRef.current).toBeNull();
  });

  it("clears a pending retry and its listener when the effect is torn down", () => {
    vi.useFakeTimers();
    sessionsRef.current = [makeSession({ id: 7 })];
    restoringRef.current = true;
    const { unmount } = renderHook(() => usePushSessionOpen(props()));
    post({ type: "mullion-open-session", sessionId: 7 });
    expect(pushRetryTimerRef.current).not.toBeNull();
    expect(listeners).toHaveLength(1);

    unmount();
    expect(listeners).toHaveLength(0);
    expect(pushRetryTimerRef.current).toBeNull();
    restoringRef.current = false;
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});
