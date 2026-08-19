// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionDeepLink } from "./useSessionDeepLink.js";
import { useWorkspacePersistence } from "./useWorkspacePersistence.js";
import type { DockviewApi } from "dockview-react";
import { makeSession, makeWorkspace } from "../test/fixtures.js";

// Only the composed ordering test below (describe block at the bottom of
// this file) actually renders useWorkspacePersistence, and therefore needs
// this store mock — mirrors useWorkspacePersistence.test.ts's own
// `storeState()` shape verbatim. Declared at module scope (vi.mock is
// hoisted) but harmless for every other test in this file, none of which
// touch the store.
const saveWorkspaceLayout = vi.fn().mockResolvedValue(undefined);
let mockSessions: Array<{ id: number; status: string }> = [];

function storeState() {
  return { sessions: mockSessions, saveWorkspaceLayout };
}

vi.mock("../store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

// Copied from useWorkspacePersistence.test.ts's own makeMockApi — the
// minimal fake DockviewApi surface its restore/autosave effects touch. The
// composed ordering test below needs a real (mocked) useWorkspacePersistence
// run, not just a hand-set restoringRef, to actually prove the two hooks'
// setTimeout(0)s race in the right order.
function makeMockApi() {
  const panels = new Map<
    string,
    { id: string; params?: Record<string, unknown>; api: { close: ReturnType<typeof vi.fn> } }
  >();
  const api = {
    clear: vi.fn(),
    fromJSON: vi.fn(),
    toJSON: vi.fn(() => ({ panels: {} })),
    getPanel: vi.fn((id: string) => panels.get(id) ?? null),
    get panels() {
      return Array.from(panels.values());
    },
    groups: [],
    hasMaximizedGroup: vi.fn(() => false),
    exitMaximizedGroup: vi.fn(),
    maximizeGroup: vi.fn(),
    activePanel: undefined,
    onDidLayoutChange: vi.fn(() => ({ dispose: vi.fn() })),
  };
  return api as unknown as DockviewApi;
}

function setUrl(pathAndQuery: string) {
  window.history.pushState({}, "", pathAndQuery);
}

beforeEach(() => {
  mockSessions = [];
  saveWorkspaceLayout.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  // Reset the URL back to a clean slate so a leftover ?session= from one
  // test can't leak into the next.
  window.history.pushState({}, "", "/");
});

describe("useSessionDeepLink", () => {
  it("does nothing until dockviewApi, workspace-restore, and sessionsLoaded all gate open", () => {
    vi.useFakeTimers();
    setUrl("/?session=42");
    const onOpenSession = vi.fn();
    const restoringRef = { current: false };
    const restoredWorkspaceIdRef: { current: number | null } = { current: null };

    const { rerender } = renderHook(
      (props: { dockviewApi: DockviewApi | null; sessionsLoaded: boolean }) =>
        useSessionDeepLink({
          dockviewApi: props.dockviewApi,
          activeWorkspaceId: 1,
          sessionsLoaded: props.sessionsLoaded,
          sessions: [makeSession({ id: 42 })],
          workspaces: [makeWorkspace({ id: 1 })],
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
    // activeWorkspaceId yet (restore hasn't completed for workspace 1).
    rerender({ dockviewApi: {} as DockviewApi, sessionsLoaded: true });
    vi.advanceTimersByTime(1000);
    expect(onOpenSession).not.toHaveBeenCalled();

    // Restore completes for a DIFFERENT workspace — still must not fire.
    restoredWorkspaceIdRef.current = 2;
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
  });

  it("retries via the same-delay setTimeout(0) while restoringRef.current is true, and succeeds once it flips false — the macrotask-ordering guarantee this hook depends on from useWorkspacePersistence", () => {
    vi.useFakeTimers();
    setUrl("/?session=42");
    const onOpenSession = vi.fn();
    const restoringRef = { current: true };
    const restoredWorkspaceIdRef = { current: 1 };

    renderHook(() =>
      useSessionDeepLink({
        dockviewApi: {} as DockviewApi,
        activeWorkspaceId: 1,
        sessionsLoaded: true,
        sessions: [makeSession({ id: 42 })],
        workspaces: [makeWorkspace({ id: 1 })],
        onOpenSession,
        restoringRef,
        restoredWorkspaceIdRef,
      }),
    );

    // First pass: gates pass but restoringRef.current is still true, so the
    // effect must NOT consume the deep link yet — it only arms a retry
    // timer. The retry timer's own setDeepLinkRetryTick call triggers a
    // React state update (a real re-render, not a mocked setter), so
    // advancing timers here needs `act()` the same way a real component's
    // effect-driven re-render would.
    act(() => vi.advanceTimersByTime(0));
    expect(onOpenSession).not.toHaveBeenCalled();

    // Still restoring on the second tick too — must keep retrying rather
    // than giving up.
    act(() => vi.advanceTimersByTime(0));
    expect(onOpenSession).not.toHaveBeenCalled();

    // Simulate useWorkspacePersistence's own restore effect settling
    // (restoringRef.current flips false via a bare ref write, exactly as it
    // does in that hook's own setTimeout(0)) — this hook's retry timer, per
    // the module doc comment, is guaranteed to observe this because
    // useWorkspacePersistence's setTimeout(0) is scheduled first in the same
    // effect flush in the real App.tsx wiring.
    restoringRef.current = false;
    act(() => vi.advanceTimersByTime(0));
    // Consuming the link itself is deferred one more macrotask (the
    // onOpenSession setTimeout(0)).
    act(() => vi.advanceTimersByTime(0));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
  });

  it("opens the matching non-killed session and strips only the `session` query param, preserving other params/hash", () => {
    vi.useFakeTimers();
    setUrl("/app?session=7&foo=bar#frag");
    const onOpenSession = vi.fn();
    const session = makeSession({ id: 7, status: "active" });

    renderHook(() =>
      useSessionDeepLink({
        dockviewApi: {} as DockviewApi,
        activeWorkspaceId: 1,
        sessionsLoaded: true,
        sessions: [session],
        workspaces: [makeWorkspace({ id: 1 })],
        onOpenSession,
        restoringRef: { current: false },
        restoredWorkspaceIdRef: { current: 1 },
      }),
    );

    // The `session` param is cleared synchronously within the same effect
    // run that discovers the match, before the deferred onOpenSession call.
    expect(window.location.search).toBe("?foo=bar");
    expect(window.location.hash).toBe("#frag");
    expect(onOpenSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(session);
  });

  it("does not open a killed session, but still clears the query param and never retries", () => {
    vi.useFakeTimers();
    setUrl("/?session=9");
    const onOpenSession = vi.fn();

    const { rerender } = renderHook(
      (sessions: ReturnType<typeof makeSession>[]) =>
        useSessionDeepLink({
          dockviewApi: {} as DockviewApi,
          activeWorkspaceId: 1,
          sessionsLoaded: true,
          sessions,
          workspaces: [makeWorkspace({ id: 1 })],
          onOpenSession,
          restoringRef: { current: false },
          restoredWorkspaceIdRef: { current: 1 },
        }),
      { initialProps: [makeSession({ id: 9, status: "killed" })] },
    );
    vi.advanceTimersByTime(0);
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");

    // One-shot: even if the session later shows up alive (e.g. a `sessions`
    // refetch racing a rename), the handled flag is already latched and
    // must not retroactively open it.
    rerender([makeSession({ id: 9, status: "active" })]);
    vi.advanceTimersByTime(0);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("no-ops (and never touches the URL) when there is no `session` query param", () => {
    vi.useFakeTimers();
    setUrl("/?foo=bar");
    const onOpenSession = vi.fn();

    renderHook(() =>
      useSessionDeepLink({
        dockviewApi: {} as DockviewApi,
        activeWorkspaceId: 1,
        sessionsLoaded: true,
        sessions: [makeSession({ id: 1 })],
        workspaces: [makeWorkspace({ id: 1 })],
        onOpenSession,
        restoringRef: { current: false },
        restoredWorkspaceIdRef: { current: 1 },
      }),
    );
    vi.advanceTimersByTime(0);
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?foo=bar");
  });

  it("is one-shot: a second render after handling never re-parses the URL or re-fires, even if `sessions` gains a later match", () => {
    vi.useFakeTimers();
    setUrl("/?session=5");
    const onOpenSession = vi.fn();

    const { rerender } = renderHook(
      (sessions: ReturnType<typeof makeSession>[]) =>
        useSessionDeepLink({
          dockviewApi: {} as DockviewApi,
          activeWorkspaceId: 1,
          sessionsLoaded: true,
          sessions,
          workspaces: [makeWorkspace({ id: 1 })],
          onOpenSession,
          restoringRef: { current: false },
          restoredWorkspaceIdRef: { current: 1 },
        }),
      // No session with id 5 exists yet on the first pass.
      { initialProps: [] as ReturnType<typeof makeSession>[] },
    );
    vi.advanceTimersByTime(0);
    expect(onOpenSession).not.toHaveBeenCalled();
    // Still handled (deepLinkHandledRef latched) even though no match was
    // found — the query param is cleared unconditionally.
    expect(window.location.search).toBe("");

    rerender([makeSession({ id: 5, status: "active" })]);
    vi.advanceTimersByTime(0);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("cleans up a pending onOpenSession timer on unmount so a torn-down effect never fires late", () => {
    vi.useFakeTimers();
    setUrl("/?session=3");
    const onOpenSession = vi.fn();
    const session = makeSession({ id: 3, status: "active" });

    const { unmount } = renderHook(() =>
      useSessionDeepLink({
        dockviewApi: {} as DockviewApi,
        activeWorkspaceId: 1,
        sessionsLoaded: true,
        sessions: [session],
        workspaces: [makeWorkspace({ id: 1 })],
        onOpenSession,
        restoringRef: { current: false },
        restoredWorkspaceIdRef: { current: 1 },
      }),
    );

    unmount();
    vi.advanceTimersByTime(1000);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("cleans up a pending retry timer on unmount while still restoring", () => {
    vi.useFakeTimers();
    setUrl("/?session=3");
    const onOpenSession = vi.fn();
    const restoringRef = { current: true };

    const { unmount } = renderHook(() =>
      useSessionDeepLink({
        dockviewApi: {} as DockviewApi,
        activeWorkspaceId: 1,
        sessionsLoaded: true,
        sessions: [makeSession({ id: 3 })],
        workspaces: [makeWorkspace({ id: 1 })],
        onOpenSession,
        restoringRef,
        restoredWorkspaceIdRef: { current: 1 },
      }),
    );

    unmount();
    restoringRef.current = false;
    vi.advanceTimersByTime(1000);
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});

describe("useSessionDeepLink composed with useWorkspacePersistence (PR 34g's load-bearing ordering claim)", () => {
  // This is the actual regression guard for the ordering/coupling contract
  // documented in both hooks' header comments — every test above hand-sets
  // restoringRef/restoredWorkspaceIdRef, which proves the retry LOOP works
  // but assumes away the very scheduling order it's supposed to prove.
  // Nothing in those tests would catch someone reordering the two hook
  // calls in App.tsx. This test instead renders BOTH hooks for real, in
  // App.tsx's actual call order (useWorkspacePersistence first, then
  // useSessionDeepLink fed its returned refs), so the two hooks' same-delay
  // setTimeout(0)s actually race the way they do in the real app.
  it("resolves the deep link once real restore settles, when called AFTER useWorkspacePersistence (App.tsx's actual order)", () => {
    vi.useFakeTimers();
    setUrl("/?session=1");
    const onOpenSession = vi.fn();
    const api = makeMockApi();
    const workspace = makeWorkspace({ id: 1, layout: { some: "layout" } });
    const session = makeSession({ id: 1, status: "active" });
    mockSessions = [];
    const setPanelsVersion = vi.fn();

    renderHook(() => {
      const { restoringRef, restoredWorkspaceIdRef } = useWorkspacePersistence({
        dockviewApi: api,
        activeWorkspaceId: 1,
        workspaces: [workspace],
        layoutTier: "desktop",
        setPanelsVersion,
      });
      useSessionDeepLink({
        dockviewApi: api,
        activeWorkspaceId: 1,
        sessionsLoaded: true,
        sessions: [session],
        workspaces: [workspace],
        onOpenSession,
        restoringRef,
        restoredWorkspaceIdRef,
      });
    });

    // Both hooks scheduled a setTimeout(0) on mount: useWorkspacePersistence's
    // own re-arm timer (which flips restoringRef.current false) and
    // useSessionDeepLink's retry timer (which, on this first pass, saw
    // restoringRef.current still true and only bumped its retry tick).
    // Flushing macrotasks in scheduling order settles the restore FIRST,
    // then re-runs the deep-link effect, which now sees restoringRef.current
    // === false and arms its own onOpenSession timer.
    act(() => vi.advanceTimersByTime(0));
    // One more flush for that onOpenSession timer.
    act(() => vi.advanceTimersByTime(0));

    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(session);

    // Discriminating property, confirmed by hand while writing this test by
    // temporarily swapping the two hook calls above: if useSessionDeepLink
    // were called BEFORE useWorkspacePersistence, its effect would register
    // — and therefore run — first on mount, observing
    // `restoredWorkspaceIdRef.current` still `null`
    // (useWorkspacePersistence's restore effect hasn't run yet to set it),
    // so `workspaceRestored` is false and the deep-link effect bails out
    // entirely rather than even reaching the `restoringRef.current` retry
    // branch. Nothing then re-runs it once the restore completes (bare ref
    // writes don't trigger re-renders), so the deep link stalls forever —
    // `onOpenSession` above would never be called, and this assertion would
    // time out/fail. This test keeps App.tsx's real (correct) order, so it
    // serves as a standing regression guard: it fails the moment that call
    // order is inverted.
  });
});
