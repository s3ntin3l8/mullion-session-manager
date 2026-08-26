// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDashboardStore, eventKey } from "./store/index.js";
import { api } from "./api/index.js";
import type { Session, NotificationEvent } from "./api/index.js";

// P6 — `events`, `lastSeenSeq`, and `dismissedEventKeys` are keyed by
// session id and, before this fix, nothing ever removed a key: a long-lived
// dashboard accumulated one entry per session id it had EVER seen. This
// exercises refreshSessions()'s new pruning pass, and specifically its
// conservative boundary: a session id is only pruned once it's absent from
// the live GET /api/sessions response entirely — a session that's merely
// `status: "killed"` (the DB row's own soft-delete — see this repo's
// CLAUDE.md on the "intent, not process state" session model) still comes
// back from that endpoint and must NOT be pruned, since Sidebar's
// hideEndedSessions toggle can still be showing it.
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    projectId: 1,
    parentSessionId: null,
    name: "claude code",
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

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "attention",
    ts: 1_700_000_000_000,
    payload: { attention: true, signal: "bell" },
    ...overrides,
  };
}

describe("store per-session-id map pruning (P6)", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      sessions: [],
      sessionsLoaded: false,
      events: {},
      lastSeenSeq: {},
      dismissedEventKeys: {},
      backendReachable: true,
    });
    vi.restoreAllMocks();
  });

  it("prunes events/lastSeenSeq/dismissedEventKeys for a session id absent from the live list", async () => {
    useDashboardStore.setState({
      events: { 1: [makeEvent({ sessionId: 1 })], 2: [makeEvent({ sessionId: 2, seq: 5 })] },
      lastSeenSeq: { 1: 1, 2: 5 },
      dismissedEventKeys: { [eventKey(1, 1)]: true, [eventKey(2, 5)]: true },
    });
    // Session 2's project was deleted (FK cascade) — it no longer comes back
    // from GET /api/sessions at all.
    vi.spyOn(api, "listSessions").mockResolvedValue([makeSession({ id: 1 })]);

    await useDashboardStore.getState().refreshSessions();

    const state = useDashboardStore.getState();
    expect(state.events).toEqual({ 1: [makeEvent({ sessionId: 1 })] });
    expect(state.lastSeenSeq).toEqual({ 1: 1 });
    expect(state.dismissedEventKeys).toEqual({ [eventKey(1, 1)]: true });
  });

  it("does NOT prune a session that's merely killed — it still appears in the live list", async () => {
    useDashboardStore.setState({
      events: { 1: [makeEvent({ sessionId: 1 })] },
      lastSeenSeq: { 1: 1 },
      dismissedEventKeys: { [eventKey(1, 1)]: true },
    });
    // Killed, but the row still comes back from the endpoint (soft delete).
    vi.spyOn(api, "listSessions").mockResolvedValue([makeSession({ id: 1, status: "killed" })]);

    await useDashboardStore.getState().refreshSessions();

    const state = useDashboardStore.getState();
    expect(state.events[1]).toBeDefined();
    expect(state.lastSeenSeq[1]).toBe(1);
    expect(state.dismissedEventKeys[eventKey(1, 1)]).toBe(true);
  });

  it("preserves object identity for all three maps when nothing needs pruning", async () => {
    const events = { 1: [makeEvent({ sessionId: 1 })] };
    const lastSeenSeq = { 1: 1 };
    const dismissedEventKeys = { [eventKey(1, 1)]: true as const };
    useDashboardStore.setState({ events, lastSeenSeq, dismissedEventKeys });
    vi.spyOn(api, "listSessions").mockResolvedValue([makeSession({ id: 1 })]);

    await useDashboardStore.getState().refreshSessions();

    const state = useDashboardStore.getState();
    // Reference equality, not just deep equality — a fresh object every tick
    // would defeat any selector/memo keyed on these slices, the exact
    // anti-pattern this PR's P1 fix removes elsewhere.
    expect(state.events).toBe(events);
    expect(state.lastSeenSeq).toBe(lastSeenSeq);
    expect(state.dismissedEventKeys).toBe(dismissedEventKeys);
  });

  it("does not prune anything when refreshSessions() fails — a transient outage must not read as every session being gone", async () => {
    const events = { 1: [makeEvent({ sessionId: 1 })] };
    useDashboardStore.setState({ events, lastSeenSeq: { 1: 1 } });
    vi.spyOn(api, "listSessions").mockRejectedValue(new Error("network error"));

    await expect(useDashboardStore.getState().refreshSessions()).rejects.toThrow();

    const state = useDashboardStore.getState();
    expect(state.events).toBe(events);
    expect(state.lastSeenSeq).toEqual({ 1: 1 });
  });

  it("keeps a dismissedEventKeys entry whose prefix doesn't parse as a live session id, rather than silently dropping it", async () => {
    useDashboardStore.setState({
      dismissedEventKeys: { "not-a-valid-key": true },
    });
    vi.spyOn(api, "listSessions").mockResolvedValue([makeSession({ id: 1 })]);

    await useDashboardStore.getState().refreshSessions();

    expect(useDashboardStore.getState().dismissedEventKeys["not-a-valid-key"]).toBe(true);
  });
});
