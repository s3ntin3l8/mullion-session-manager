// @vitest-environment jsdom
//
// P3 regression test — uses the REAL store (unlike NotificationBell.test.tsx's
// selector-independent mock, which can't observe re-render/memo behavior)
// so this can actually exercise the useMemo split between the cheap unread
// count and the expensive buildFeedItems construction. eventDescriptions.js's
// notifyKind is called by both — spied on here as an indirect but real signal
// of which one ran: countUnread only calls it for events past the read
// cursor (the unread ones), while buildFeedItems calls it for every
// feed-eligible-or-not event in the session (the filter predicate runs
// against the whole list). A session with mostly-read events makes the two
// counts diverge enough to tell them apart.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import * as eventDescriptions from "./eventDescriptions.js";
import { NotificationBell } from "./NotificationBell.js";
import { useDashboardStore } from "./store/index.js";
import type { Session, NotificationEvent, Project } from "./api/index.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    projectId: 1,
    parentSessionId: null,
    name: "claude code",
    nameLocked: true,
    command: "claude code",
    cwd: null,
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

// 8 already-read events (seq 1-8, cursor at 8) + 2 unread ones (seq 9-10),
// all feed-eligible ("attention" kind).
function makeEvent(seq: number): NotificationEvent {
  return {
    seq,
    sessionId: 1,
    kind: "attention",
    ts: 1_700_000_000_000 + seq,
    payload: { attention: true, signal: "bell" },
  };
}

const sessionEvents = Array.from({ length: 10 }, (_, i) => makeEvent(i + 1));

describe("NotificationBell unread/feed split (P3)", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      sessions: [makeSession()],
      projects: [{ id: 1, name: "proj" } as Project],
      events: { 1: sessionEvents },
      lastSeenSeq: { 1: 8 },
      dismissedEventKeys: {},
      notificationsPanelOpenRequest: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("only scans unread events (not the whole session history) while the panel is closed", async () => {
    const spy = vi.spyOn(eventDescriptions, "notifyKind");
    render(<NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} />);
    await act(async () => {});
    spy.mockClear();

    // Simulates a live-refresh poll tick: `sessions` gets a fresh array
    // identity, same event/cursor content.
    act(() => {
      useDashboardStore.setState({ sessions: [makeSession()] });
    });

    // Only the 2 unread events (seq 9, 10) should have been scanned —
    // buildFeedItems (which would scan all 10) must not have run while
    // closed.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("runs the full feed build once the panel opens", async () => {
    const spy = vi.spyOn(eventDescriptions, "notifyKind");
    const { getByRole } = render(
      <NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} />,
    );
    await act(async () => {});
    spy.mockClear();

    act(() => {
      fireEvent.click(getByRole("button", { name: /notifications/i }));
    });

    // Opening triggers buildFeedItems (10 events scanned) — the unreadCount
    // memo's own deps didn't change, so its 2 calls aren't repeated here.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it("still reports the correct unread badge count while closed", async () => {
    const { getByRole } = render(
      <NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} />,
    );
    await act(async () => {});
    const button = getByRole("button", { name: /2 unread/i });
    expect(button).toBeInTheDocument();
  });

  it("excludes a muted session from the unread badge (#719)", async () => {
    // Counts toward the toolbar badge by default (the test above asserts
    // "2 unread"); muting session 1 must drop it to zero so the button reads
    // plain "Notifications" with no unread count.
    useDashboardStore.setState({ mutedSessionIds: [1] });
    const { getByRole } = render(
      <NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} />,
    );
    await act(async () => {});
    // Muting drops the count to zero, so the bell reads "none unread" rather
    // than "N unread" — assert it no longer carries an unread count.
    const button = getByRole("button", { name: /none unread/i });
    expect(button).toBeInTheDocument();
    useDashboardStore.setState({ mutedSessionIds: [] });
  });
});
