// @vitest-environment jsdom
//
// The bell on the REAL store (unlike NotificationBell.test.tsx's
// selector-independent mock): its real markSessionRead/markEventSeen cursor,
// the one PaneTab.tsx's tab badges read, and the memo split between the
// every-tick badge and the open-only feed build.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";
import * as eventDescriptions from "./eventDescriptions.js";
import { NotificationBell } from "./NotificationBell.js";
import { useDashboardStore } from "./store/index.js";
import { api } from "./api/index.js";
import type { Session, NotificationEvent, Project, Task } from "./api/index.js";

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
    // Issue #1727 — the session's host: the raw column (null = inherits
    // its project's) and the resolved one the host badge shows.
    hostId: null,
    resolvedHostId: "local",
    // Issue #1852 — the placement decision's own words; null when
    // nothing was decided here (a test session's default).
    placementReason: null,
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
    currentTodo: null,
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

function ev(sessionId: number, seq: number, payload: Record<string, unknown>): NotificationEvent {
  return { seq, sessionId, kind: "attention", ts: 1_700_000_000_000 + seq, payload };
}
const ask = { attention: true, signal: "hookNotification", title: "Heads up", body: "push?" };
const finished = { attention: true, signal: "agentIdle" };

describe("NotificationBell on the real store (#3458, #3460)", () => {
  beforeEach(() => {
    vi.spyOn(api, "ackAttention").mockResolvedValue(undefined as never);
    useDashboardStore.setState({
      sessions: [
        makeSession({ id: 1, name: "asking", attention: true, attentionKind: "hookNotification" }),
        makeSession({ id: 2, name: "done", attention: true, attentionKind: "agentIdle" }),
      ],
      projects: [{ id: 1, name: "proj" } as Project],
      events: {
        1: [ev(1, 1, finished), ev(1, 2, ask)],
        2: [ev(2, 1, finished), ev(2, 2, finished)],
      },
      lastSeenSeq: {},
      dismissedEventKeys: {},
      mutedSessionIds: [],
      tasks: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts open decisions only: the grouped rows add nothing to the badge", async () => {
    render(<NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Notifications, 1 needs you" })).toBeVisible();
  });

  it("does not build the feed while closed, and builds it once opened", async () => {
    const spy = vi.spyOn(eventDescriptions, "describeEvent");
    render(<NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} />);
    await act(async () => {});
    // A live-refresh tick: fresh `sessions` identity, same content.
    act(() => {
      useDashboardStore.setState({ sessions: [...useDashboardStore.getState().sessions] });
    });
    expect(spy).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    });
    expect(spy).toHaveBeenCalled();
  });

  it("opening marks only the decision-free session read; Read all leaves the open decision and its tab badge alone", async () => {
    // The sheet: it renders every row (the popover virtualizes them, and
    // jsdom has no layout).
    render(<NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} sheet />);
    await act(async () => {});
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    });
    // Opening the panel read the grouped lines of session 2, not session 1's.
    expect(useDashboardStore.getState().lastSeenSeq[2]).toBe(2);
    expect(useDashboardStore.getState().lastSeenSeq[1]).toBeUndefined();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "All" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Read all" }));
    });
    expect(api.ackAttention).toHaveBeenCalledWith(2);
    expect(api.ackAttention).not.toHaveBeenCalledWith(1);
    const state = useDashboardStore.getState();
    expect(state.lastSeenSeq[1]).toBeUndefined();
    // PaneTab.tsx's own badge for session 1 still counts its pending ask.
    const tab = eventDescriptions.unreadEventSummary(
      1,
      state.events[1],
      state.lastSeenSeq[1] ?? 0,
      state.dismissedEventKeys,
    );
    expect(tab.kind).toBe("attention");
    expect(tab.count).toBe(2);
    // The decision is still listed and counted.
    expect(screen.getByText("Heads up — push?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notifications, 1 needs you" })).toBeVisible();
  });

  it("Read all leaves a muted session with an open decision alone too", async () => {
    // Muted: it counts nowhere, but its decision is still listed, so its
    // cursor must not move past it.
    useDashboardStore.setState({ mutedSessionIds: [1] });
    render(<NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} sheet />);
    await act(async () => {});
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "All" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Read all" }));
    });
    expect(useDashboardStore.getState().lastSeenSeq[1]).toBeUndefined();
    expect(api.ackAttention).not.toHaveBeenCalledWith(1);
    expect(api.ackAttention).toHaveBeenCalledWith(2);
    useDashboardStore.setState({ mutedSessionIds: [] });
  });

  it("excludes a muted session from the badge (#719)", async () => {
    useDashboardStore.setState({ mutedSessionIds: [1] });
    render(<NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Notifications, nothing needs you" })).toBeVisible();
    useDashboardStore.setState({ mutedSessionIds: [] });
  });

  it("a dismissed decision also leaves the pane tab badge (the store's key, #1427)", async () => {
    render(<NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} sheet />);
    await act(async () => {});
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    const state = useDashboardStore.getState();
    const tab = eventDescriptions.unreadEventSummary(
      1,
      state.events[1],
      0,
      state.dismissedEventKeys,
    );
    // Only the unread "Finished" is left on the tab, not the dismissed ask.
    expect(tab.count).toBe(1);
    expect(screen.getByRole("button", { name: "Notifications, nothing needs you" })).toBeVisible();
  });
});

// The classification's behaviour through the bell and the real store. The
// sheet presentation renders every row (the popover virtualizes them, and
// jsdom has no layout); the logic behind both is the same.
describe("the bell lists open decisions only (#3458)", () => {
  const S = (overrides: Partial<Session>) => makeSession(overrides);
  const asking = (overrides: Partial<Session> = {}) =>
    S({ attention: true, attentionKind: "hookNotification", ...overrides });
  const at = (
    sessionId: number,
    seq: number,
    kind: NotificationEvent["kind"],
    payload: Record<string, unknown> = {},
  ): NotificationEvent => ({ seq, sessionId, kind, ts: 1_700_000_000_000 + seq, payload });
  const permission = (seq: number, summary = "git push") =>
    at(1, seq, "permission_request", { tool: "Bash", summary });
  const bellName = () => screen.getByRole("button", { name: /^Notifications,/ });
  const openSheet = (onOpenSession = vi.fn()) => {
    const view = render(
      <NotificationBell onOpenSession={onOpenSession} onOpenBrowser={() => {}} sheet />,
    );
    act(() => {
      fireEvent.click(bellName());
    });
    return { ...view, onOpenSession };
  };
  const decisionRows = () => document.querySelectorAll(".notif-event-row:not(.notif-grouped-line)");
  const set = (state: Partial<ReturnType<typeof useDashboardStore.getState>>) =>
    act(() => {
      useDashboardStore.setState(state);
    });

  beforeEach(() => {
    vi.spyOn(api, "ackAttention").mockResolvedValue(undefined as never);
    useDashboardStore.setState({
      sessions: [],
      projects: [{ id: 1, name: "proj" } as Project],
      events: {},
      lastSeenSeq: {},
      dismissedEventKeys: {},
      mutedSessionIds: [],
      tasks: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts each session with an open decision once, however many events it has", () => {
    useDashboardStore.setState({
      sessions: [asking({ id: 1 }), asking({ id: 2, name: "two" })],
      events: {
        1: [at(1, 1, "attention", ask), at(1, 2, "attention", ask)],
        2: [at(2, 1, "attention", ask)],
      },
    });
    render(<NotificationBell onOpenSession={() => {}} onOpenBrowser={() => {}} />);
    expect(bellName()).toHaveAccessibleName("Notifications, 2 need you");
    expect(bellName().querySelector(".attention-badge")).toHaveTextContent("2");
  });

  it("never counts byte-parsed guesses, tool failures or answered dev-server offers", () => {
    useDashboardStore.setState({
      sessions: [S({ id: 1, attention: true, attentionKind: "silence" })],
      events: {
        1: [
          at(1, 1, "attention", { attention: true, signal: "bell" }),
          at(1, 2, "attention", { attention: true, signal: "silence" }),
          at(1, 3, "tool_failure", { tool: "Bash", error: "exit 2" }),
          at(1, 4, "dev_server_detected", { port: "5173", state: "dismissed" }),
          at(1, 5, "title_change", { title: "zsh" }),
        ],
      },
    });
    openSheet();
    expect(bellName()).toHaveAccessibleName("Notifications, nothing needs you");
    expect(decisionRows()).toHaveLength(0);
  });

  it("lists a permission while its latch is pending, and drops it when answered", () => {
    useDashboardStore.setState({
      sessions: [
        S({
          id: 1,
          permissionState: "pending",
          attention: true,
          attentionKind: "permissionRequest",
        }),
      ],
      events: {
        1: [
          permission(1),
          // The paired attention twin every raise site emits: never a row.
          at(1, 2, "attention", {
            attention: true,
            signal: "permissionRequest",
            summary: "git push",
          }),
        ],
      },
    });
    openSheet();
    expect(bellName()).toHaveAccessibleName("Notifications, 1 needs you");
    expect(decisionRows()).toHaveLength(1);

    // Answered in the terminal: the next sessions refresh clears the latch.
    set({ sessions: [S({ id: 1, permissionState: "idle" })] });
    expect(decisionRows()).toHaveLength(0);
    expect(bellName()).toHaveAccessibleName("Notifications, nothing needs you");
  });

  // The case #3458 asked to pin: a decision can leave without an answer. The
  // backend's stale-latch sweep (#320, staleErrorSeconds, 30 minutes by
  // default) clears a blocked latch the agent has made no output since, and
  // says so with a stale_blocked_cleared status change. The bell follows the
  // latch, as the session's own status does.
  it("drops a decision whose latch the stale-latch sweep cleared, unanswered", () => {
    useDashboardStore.setState({
      sessions: [S({ id: 1, permissionState: "pending" })],
      events: { 1: [permission(1)] },
    });
    openSheet();
    expect(decisionRows()).toHaveLength(1);
    set({
      sessions: [S({ id: 1, permissionState: "idle" })],
      events: {
        1: [
          permission(1),
          at(1, 2, "status_change", { reason: "stale_blocked_cleared", state: "permissionState" }),
        ],
      },
    });
    expect(decisionRows()).toHaveLength(0);
  });

  it("lists only the newest permission, and does not resurrect answered asks when a later turn finishes", () => {
    useDashboardStore.setState({
      sessions: [S({ id: 1, permissionState: "pending" })],
      events: {
        1: [permission(1, "npm ci"), permission(2, "git push"), permission(3, "rm -rf dist")],
      },
    });
    openSheet();
    expect(decisionRows()).toHaveLength(1);
    expect(screen.getByText(/rm -rf dist/)).toBeInTheDocument();

    set({
      sessions: [S({ id: 1, attention: true, attentionKind: "agentIdle" })],
      events: {
        1: [...useDashboardStore.getState().events[1], at(1, 4, "attention", finished)],
      },
    });
    expect(decisionRows()).toHaveLength(0);
  });

  it("closes a question on its resolution, and a stop failure once progress clears errorState", () => {
    useDashboardStore.setState({
      sessions: [S({ id: 1, attention: true, attentionKind: "question", errorState: "api_error" })],
      events: {
        1: [
          at(1, 1, "question", { state: "started", header: "Pick" }),
          at(1, 2, "stop_failure", { error: "overloaded" }),
        ],
      },
    });
    openSheet();
    expect(decisionRows()).toHaveLength(2);
    set({
      sessions: [S({ id: 1, errorState: "idle" })],
      events: {
        1: [...useDashboardStore.getState().events[1], at(1, 3, "question", { state: "finished" })],
      },
    });
    expect(decisionRows()).toHaveLength(0);
  });

  it("does not let a generic notification stand in for the answered ask it came with", () => {
    useDashboardStore.setState({
      sessions: [asking({ id: 1 })],
      events: { 1: [permission(1), at(1, 2, "attention", ask)] },
    });
    openSheet();
    expect(decisionRows()).toHaveLength(0);
  });

  it("lists a non-zero exit as Failed while the process is down, with no grouped 'exited' beside it", () => {
    useDashboardStore.setState({
      sessions: [S({ id: 1, alive: false, exitCode: 1 })],
      events: {
        1: [
          at(1, 1, "session_end", { reason: "other", exitCode: 1 }),
          at(1, 2, "status_change", { reason: "exited" }),
        ],
      },
    });
    openSheet();
    expect(screen.getByText("Exit", { selector: ".notif-event-kind-pill" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.queryByText("Earlier, no decision needed")).toBeNull();
  });

  it("lists a manual session's red PR until it goes green, and never a task's", () => {
    const red = (sessionId: number) =>
      at(sessionId, 1, "pr_ci_failed", { number: 42, title: "Fix" });
    useDashboardStore.setState({
      sessions: [S({ id: 1 }), S({ id: 2, name: "worker" })],
      tasks: [{ id: 9, sessionId: 2, reviewSessionId: null } as Task],
      events: { 1: [red(1)], 2: [red(2)] },
    });
    openSheet();
    expect(bellName()).toHaveAccessibleName("Notifications, 1 needs you");
    expect(screen.getAllByText("#42: CI failed")).toHaveLength(1);
    set({
      events: {
        ...useDashboardStore.getState().events,
        1: [red(1), at(1, 2, "pr_ci_passed", { number: 42 })],
      },
    });
    expect(screen.queryByText("#42: CI failed")).toBeNull();
  });

  it("still lists a muted session's decision, without counting it", () => {
    useDashboardStore.setState({
      sessions: [asking({ id: 1 })],
      events: { 1: [at(1, 1, "attention", ask)] },
      mutedSessionIds: [1],
    });
    openSheet();
    expect(bellName()).toHaveAccessibleName("Notifications, nothing needs you");
    expect(decisionRows()).toHaveLength(1);
  });

  describe("Earlier, no decision needed (#3460)", () => {
    it("puts informative events in one collapsed group, one line per session, never counted", () => {
      useDashboardStore.setState({
        sessions: [S({ id: 1, name: "alpha" }), S({ id: 2, name: "beta", alive: false })],
        events: {
          1: [at(1, 1, "attention", finished), at(1, 2, "attention", finished)],
          2: [at(2, 3, "attention", finished), at(2, 4, "status_change", { reason: "exited" })],
        },
      });
      openSheet();
      expect(bellName()).toHaveAccessibleName("Notifications, nothing needs you");
      expect(screen.getByText("Nothing needs you right now")).toBeInTheDocument();
      const toggle = screen.getByRole("button", { name: /Earlier, no decision needed/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      const lines = document.querySelectorAll(".notif-grouped-line");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toHaveTextContent("beta finished, exited");
      expect(lines[1]).toHaveTextContent("alpha finished");
    });

    it("dismisses a grouped line's every event, and opens the session from it", () => {
      useDashboardStore.setState({
        sessions: [S({ id: 2, name: "done" })],
        events: { 2: [at(2, 1, "attention", finished), at(2, 2, "attention", finished)] },
      });
      const { onOpenSession } = openSheet();
      fireEvent.click(screen.getByRole("button", { name: /Earlier, no decision needed/ }));
      fireEvent.click(screen.getByRole("button", { name: /^done finished/ }));
      expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));

      // Reopened, the group is still expanded.
      act(() => {
        fireEvent.click(bellName());
      });
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      const keys = Object.keys(useDashboardStore.getState().dismissedEventKeys);
      expect(keys).toEqual(
        expect.arrayContaining([`2:1:${1_700_000_000_001}`, `2:2:${1_700_000_000_002}`]),
      );
      expect(document.querySelector(".notif-grouped-line")).toBeNull();
    });

    it("keeps a line it just marked read marked new until the panel closes, and offers no Read all once nothing is left", () => {
      useDashboardStore.setState({
        sessions: [S({ id: 2, name: "done" })],
        events: { 2: [at(2, 1, "attention", finished)] },
      });
      openSheet();
      expect(useDashboardStore.getState().lastSeenSeq[2]).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: /Earlier, no decision needed/ }));
      expect(screen.getByRole("button", { name: /^done finished/ })).toHaveAccessibleName(
        expect.stringContaining(", new"),
      );
      // Read, and nothing raised on the session: nothing for Read all to do.
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
      });
      act(() => {
        fireEvent.click(bellName());
      });
      expect(screen.queryByRole("button", { name: "Read all" })).toBeNull();
    });
  });
});
