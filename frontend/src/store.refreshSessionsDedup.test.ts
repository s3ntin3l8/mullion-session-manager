// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDashboardStore } from "./store/index.js";
import { api } from "./api/index.js";
import type { Session } from "./api/index.js";
import { __resetRefreshSessionsInFlightForTests } from "./store/slices/sessions.js";

// Issue #1008 — refreshSessions had no in-flight dedupe at all, unlike its
// sibling refreshGitStatuses' gitStatusesRefreshInFlight (slices/git.ts):
// Sidebar.tsx's own mount fetch and startLiveRefresh's immediate first tick
// both call it independently, firing 3 near-simultaneous GET /api/sessions
// in the 0.3.8 incident. These tests lock in the coalescing behavior AND
// the specific reason it isn't a bare "share the current promise" dedup
// like refreshGitStatuses' — createSession/renameSession/etc. all await
// refreshSessions() expecting to see their own just-completed mutation
// reflected, so a concurrent caller must never be handed back a fetch that
// started before its own mutation resolved.

// Same full fixture shape as store.pruneSessionMaps.test.ts's makeSession —
// Session has ~40 fields, so `id` + a few identifying ones plus
// `...overrides` is the only realistic way to build one in a test.
function session(id: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectId: 1,
    parentSessionId: null,
    name: `session-${id}`,
    nameLocked: true,
    command: "claude code",
    cwd: null,
    env: null,
    liveCwd: null,
    previewBranch: null,
    kind: "terminal",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: "2026-01-01T00:00:00.000Z",
    alive: true,
    subscriberCount: 1,
    activity: "idle",
    lastActivityAt: Date.now(),
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gates: [],
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    permissionState: "idle",
    planState: "idle",
    errorState: "idle",
    endedReason: null,
    liveBranch: null,
    exitCode: null,
    attentionKind: null,
    errorDetail: null,
    lastAssistantMessage: null,
    compactState: "idle",
    subagentCount: 0,
    subagents: [],
    elicitationState: "idle",
    elicitationServer: null,
    lastTurnEndedAt: null,
    stateRestored: true,
    staleHooks: false,
    restoredVersion: null,
    sessionStatus: "idle",
    sessionStatusSeverity: "dormant",
    sessionStatusDetail: null,
    sessionStatusAttentionRequired: false,
    hookEmits: [],
    pendingDevServerPort: null,
    outstandingBackgroundTasks: [],
    ...overrides,
  };
}

describe("store.refreshSessions in-flight coalescing (issue #1008)", () => {
  beforeEach(() => {
    __resetRefreshSessionsInFlightForTests();
    useDashboardStore.setState({ sessions: [], sessionsLoaded: false, backendReachable: true });
    vi.restoreAllMocks();
  });

  it("two concurrent calls collapse into at most 2 network requests, not one per caller", async () => {
    let resolveFirst: ((sessions: Session[]) => void) | undefined;
    const firstGate = new Promise<Session[]>((resolve) => {
      resolveFirst = resolve;
    });
    const listSessions = vi
      .spyOn(api, "listSessions")
      .mockImplementationOnce(() => firstGate)
      .mockResolvedValueOnce([session(1)]);

    // Three near-simultaneous callers — models Sidebar's mount fetch +
    // startLiveRefresh's immediate tick + a third caller landing in the
    // same window.
    const callA = useDashboardStore.getState().refreshSessions();
    const callB = useDashboardStore.getState().refreshSessions();
    const callC = useDashboardStore.getState().refreshSessions();

    // B and C must NOT each fire their own fetch — only the run already in
    // flight (A) plus one queued run behind it.
    expect(listSessions).toHaveBeenCalledTimes(1);

    resolveFirst!([]);
    await Promise.all([callA, callB, callC]);

    // The queued run's own fetch fires once A settles — total 2 network
    // calls for 3 callers, not 3.
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("a call queued behind an in-flight one reflects state fetched AFTER it was invoked, not before", async () => {
    // Models createSession: POST already resolved (the caller's mutation
    // is durable) before refreshSessions() is invoked — but a concurrent,
    // already-in-flight refreshSessions() (e.g. the live-poll tick) started
    // its own GET BEFORE that mutation happened. The queuing caller must
    // still end up seeing the new session, not the stale in-flight fetch's
    // result.
    let resolveInFlight: ((sessions: Session[]) => void) | undefined;
    const inFlightGate = new Promise<Session[]>((resolve) => {
      resolveInFlight = resolve;
    });
    const listSessions = vi
      .spyOn(api, "listSessions")
      // The live-poll tick's fetch — started before the mutation, so it
      // must NOT include the new session.
      .mockImplementationOnce(() => inFlightGate)
      // The queued run's fetch — starts only after the in-flight one
      // settles, so it's the one that must reflect the new session.
      .mockResolvedValueOnce([session(1)]);

    // The "live poll" fetch starts first, in flight.
    const livePollCall = useDashboardStore.getState().refreshSessions();
    // The mutation's own call arrives while that's still pending.
    const mutationCall = useDashboardStore.getState().refreshSessions();

    // Only one fetch has started so far — the mutation's call must not
    // share whatever the live-poll fetch resolves to; it's queued instead.
    expect(listSessions).toHaveBeenCalledTimes(1);

    // The stale in-flight fetch resolves with the OLD list (no session 1) —
    // if the mutation's call were sharing this promise (a bare dedup), it
    // would incorrectly resolve here too, before session 1 ever appears.
    resolveInFlight!([]);
    await livePollCall;

    // The queued run's own fetch now fires and resolves with the fresh
    // state that includes the new session.
    await mutationCall;
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(useDashboardStore.getState().sessions).toEqual([session(1)]);
  });

  it("a call arriving after everything has settled starts a fresh fetch immediately (no permanent queuing)", async () => {
    const listSessions = vi.spyOn(api, "listSessions").mockResolvedValue([]);

    await useDashboardStore.getState().refreshSessions();
    expect(listSessions).toHaveBeenCalledTimes(1);

    // Steady state: nothing in flight, nothing queued — this must hit the
    // fast path (start immediately), not get funneled through a stale
    // queued-run chain left over from the first call.
    await useDashboardStore.getState().refreshSessions();
    expect(listSessions).toHaveBeenCalledTimes(2);
  });
});
