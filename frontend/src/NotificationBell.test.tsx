// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectNameHasVisibleText, expectNoNestedInteractive } from "./test/a11y.js";
import { resetPhoneBackStackForTests } from "./hooks/usePhoneBackStack.js";
import { NotificationBell } from "./NotificationBell.js";
import terminalCss from "./styles/terminal.css?raw";
import type { NotificationEvent, Project, Session, Task } from "./api/index.js";
import {
  flushRaf,
  installFakeVisualViewport,
  uninstallFakeVisualViewport,
} from "./test/fakeVisualViewport.js";

// Mirrors PaneTab.test.tsx's minimal selector-based store mock (only the
// fields NotificationBell.tsx actually reads), plus store.ts's real
// `eventKey` (a plain named export alongside useDashboardStore, not part of
// the store's own state) and mutable mock implementations of
// markEventSeen/dismissEvent so tests can assert on their effects the same
// way PaneTab.test.tsx's mock markEventSeen does.
let sessions: Session[];
let projects: Project[];
let events: Record<number, NotificationEvent[]>;
let lastSeenSeq: Record<number, number>;
let dismissedEventKeys: Record<string, true>;
let tasks: Task[] = [];
let mutedSessionIds: number[] = [];
let bellReturn: { section: "sessions" | "tasks"; filter: string } | null = null;
const setBellReturn = vi.fn((v: typeof bellReturn) => {
  bellReturn = v;
});

// Issue #1427 — gained a third `ts` segment (see store/helpers.ts's real
// eventKey doc comment for why: seq alone is no longer unique across a
// backend restart).
function eventKey(sessionId: number, seq: number, ts: number): string {
  return `${sessionId}:${seq}:${ts}`;
}

const markEventSeen = vi.fn((sessionId: number, seq: number) => {
  const current = lastSeenSeq[sessionId] ?? 0;
  if (seq > current) lastSeenSeq = { ...lastSeenSeq, [sessionId]: seq };
});

// Issue #1429 — mirrors the real store's own markSessionRead (advances to
// events[sessionId]'s own true max seq), routed through the mock
// markEventSeen above so tests can assert on lastSeenSeq the same way they
// already do for a direct markEventSeen call.
const markSessionRead = vi.fn((sessionId: number) => {
  const sessionEvents = events[sessionId] ?? [];
  if (sessionEvents.length === 0) return;
  const maxSeq = sessionEvents.reduce((max, e) => Math.max(max, e.seq), 0);
  markEventSeen(sessionId, maxSeq);
});

const dismissEvents = vi.fn((sessionId: number, seqs: number[]) => {
  // Mirrors the real store action's own ts lookup (slices/events.ts) —
  // find each seq's ts from the currently-buffered event, same source of
  // truth production dismisses against.
  const bySeq = new Map((events[sessionId] ?? []).map((e) => [e.seq, e.ts]));
  const next = { ...dismissedEventKeys };
  for (const seq of seqs) next[eventKey(sessionId, seq, bySeq.get(seq) ?? Date.now())] = true;
  dismissedEventKeys = next;
});

// Issue #1430 — a bare spy (no assumed effect on any local mock state,
// unlike markEventSeen/dismissEvents above): tests only assert on whether
// and with what sessionId it was called, mirroring the real store action's
// own fire-and-forget-to-the-server posture.
const ackAttention = vi.fn();

const openRightSidebarPr = vi.fn();

function storeState() {
  return {
    openRightSidebarPr,
    theme: "dark",
    sessions,
    projects,
    events,
    lastSeenSeq,
    dismissedEventKeys,
    markEventSeen,
    markSessionRead,
    dismissEvents,
    ackAttention,
    mutedSessionIds,
    toggleSessionMute: vi.fn(),
    bellReturn,
    bellReopenSeq: 0,
    setBellReturn,
    tasks,
  };
}

vi.mock("./store/index.js", () => {
  const useDashboardStore = (selector: (s: unknown) => unknown) => selector(storeState());
  return { useDashboardStore, eventKey };
});

// Minimal review gate (issue #178) — GateActions calls api.resolveReviewGate
// directly (not through the store), so it's mocked the same
// selector-independent way. `gateId` (issue: correlate concurrent
// permission gates) is threaded through as a 2nd positional arg.
const resolveReviewGate = vi.fn(
  (_id: number, _gateId: string | undefined, _decision: "approved" | "denied", _reason?: string) =>
    Promise.resolve(),
);
// Issue #404 — DevServerActions calls api.acceptDevServerPort/
// dismissDevServerPort directly (not through the store), same
// selector-independent mocking as resolveReviewGate above.
const acceptDevServerPort = vi.fn((_id: number, _port: string) =>
  Promise.resolve({ devServerUrl: _port, preview: null }),
);
const dismissDevServerPort = vi.fn((_id: number, _port: string) => Promise.resolve());
// A lazy wrapper, not `{ resolveReviewGate }` directly: vi.mock's factory
// runs at module-resolution time (hoisted above this file's own `const`
// declarations), before `resolveReviewGate` above has actually initialized
// — referencing it directly here would hit the same TDZ vi.mock footgun
// store.js's mock below avoids via storeState() being a lazily-invoked
// function declaration instead.
vi.mock("./api/index.js", () => ({
  api: {
    resolveReviewGate: (...args: [number, string | undefined, "approved" | "denied", string?]) =>
      resolveReviewGate(...args),
    acceptDevServerPort: (...args: [number, string]) => acceptDevServerPort(...args),
    dismissDevServerPort: (...args: [number, string]) => dismissDevServerPort(...args),
  },
}));

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
    gatePrompt: null,
    gates: [],
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    permissionState: "idle",
    planState: "idle",
    errorState: "idle",
    endedReason: null,
    liveBranch: null,
    // Rich statuses (issue: extend surfaced session statuses).
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

// Defaults to an open decision the simplest way there is one: Claude Code's
// generic notification, on a session (`asking()`) whose live attention is
// that notification. Its row reads ROW_TEXT.
const ROW_TEXT = "Heads up — approve the push";
function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "attention",
    ts: Date.now(),
    payload: {
      attention: true,
      signal: "hookNotification",
      title: "Heads up",
      body: "approve the push",
    },
    ...overrides,
  };
}

// A session waiting on its generic notification (the default makeEvent).
function asking(overrides: Partial<Session> = {}): Session {
  return makeSession({ attention: true, attentionKind: "hookNotification", ...overrides });
}

// Issue #1229 — header vs. event rows must report DIFFERENT heights for a
// sticky-header scroll-position test's math to be predictable; every other
// test in this file only needs SOME nonzero height, so this is additive, not
// a behavior change for them (`this` is the `ref={rowVirtualizer.
// measureElement}` wrapper, which carries no class of its own — see
// NotificationBell.tsx's row loop — so headers are distinguished by their
// rendered child instead). Matches HEADER_ROW_HEIGHT/EVENT_ROW_ESTIMATE_
// HEIGHT in NotificationBell.tsx, though nothing here requires that beyond
// realism.
const STUB_HEADER_ROW_HEIGHT = 34;
const STUB_EVENT_ROW_HEIGHT = 60;

// The virtual list's scroll container and row wrappers need non-zero
// dimensions in jsdom (which never lays out CSS, so every element reports 0
// by default). @tanstack/virtual-core reads two DIFFERENT properties for the
// two things it measures (see node_modules/@tanstack/virtual-core):
//
//   - the scroll container's own visible height (the viewport): `getRect()`
//     reads `clientWidth`/`clientHeight`. That changed in virtual-core 3.19.6
//     — upstream TanStack/virtual#1326 ("measure the visible scroll
//     viewport"), which stopped borders and scrollbars from inflating the
//     viewport and so obscuring end-aligned items. It is a deliberate
//     correctness fix, not a regression, and 3.19.7 does not revert it.
//   - each row's measured size: `measureElement()` still reads
//     `offsetHeight` when the ResizeObserver hands it no `borderBoxSize`
//     (which it never does here — the observer below is a no-op stub).
//
// Without this, the container's computed viewport height is 0 and
// getVirtualItems() never returns anything, so every "renders a row"
// assertion would fail for a reason that has nothing to do with this
// component's own logic. The scroll container is distinguished by its class;
// every other measured element is a row (header or event).
function stubVirtualizerLayout() {
  const stubHeight = function (this: HTMLElement) {
    if (this.classList.contains("notif-feed-scroll")) return 400;
    return this.querySelector(".notif-group-header")
      ? STUB_HEADER_ROW_HEIGHT
      : STUB_EVENT_ROW_HEIGHT;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: stubHeight,
  });
  // The viewport (see the comment above) — same per-element heights.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: stubHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 400,
  });
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
}

// jsdom fires no real scroll from a layout/resize change — @tanstack/
// virtual-core's default observeElementOffset just reads `element.scrollTop`
// off a native "scroll" event (node_modules/@tanstack/virtual-core), so
// driving it here means setting the property (jsdom allows any value, real
// overflow or not) and dispatching the event ourselves.
function scrollFeedTo(px: number) {
  const el = document.querySelector(".notif-feed-scroll");
  if (!(el instanceof HTMLElement)) throw new Error("`.notif-feed-scroll` not found");
  el.scrollTop = px;
  el.dispatchEvent(new Event("scroll"));
}

// Renders the bell and opens its dropdown, returning the onOpenSession spy
// (a fresh one per call unless the caller supplies its own) so tests that
// only care about the panel's contents don't each need their own
// render+click boilerplate.
async function openPanel(onOpenSession = vi.fn()) {
  render(<NotificationBell onOpenSession={onOpenSession} onOpenBrowser={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
  return onOpenSession;
}

beforeEach(() => {
  sessions = [asking()];
  tasks = [];
  mutedSessionIds = [];
  bellReturn = null;
  setBellReturn.mockClear();
  projects = [{ id: 1, name: "mullion", cwd: "/x", hostId: "local" } as Project];
  events = {};
  lastSeenSeq = {};
  dismissedEventKeys = {};
  markEventSeen.mockClear();
  markSessionRead.mockClear();
  dismissEvents.mockClear();
  ackAttention.mockClear();
  resolveReviewGate.mockClear();
  resolveReviewGate.mockResolvedValue(undefined);
  acceptDevServerPort.mockClear();
  acceptDevServerPort.mockResolvedValue({ devServerUrl: "5173", preview: null });
  dismissDevServerPort.mockClear();
  dismissDevServerPort.mockResolvedValue(undefined);
  stubVirtualizerLayout();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotificationBell", () => {
  it("shows the empty state when there are no notification-worthy events", async () => {
    await openPanel();
    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
  });

  it("shows no badge on the trigger button when there are no events", () => {
    render(<NotificationBell onOpenSession={vi.fn()} onOpenBrowser={vi.fn()} />);
    expect(document.querySelector(".attention-badge")).not.toBeInTheDocument();
  });

  it("renders an open decision as a row, grouped under a session header", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPanel();
    expect(screen.getByText("claude code")).toBeInTheDocument(); // group header title
    expect(screen.getByText("mullion")).toBeInTheDocument(); // group header subtitle
    expect(screen.getByText(ROW_TEXT)).toBeInTheDocument();
    expect(screen.getByText("Notification", { selector: ".notif-event-kind-pill" })).toBeVisible();
  });

  it("issue #1229 — the group header shows the session's current status, and tracks it live", async () => {
    sessions = [asking({ sessionStatus: "working", sessionStatusSeverity: "busy" })];
    events = { 1: [makeEvent({ seq: 1 })] };
    const { rerender } = render(
      <NotificationBell onOpenSession={vi.fn()} onOpenBrowser={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    expect(screen.getByText("Working")).toBeInTheDocument();

    // A poll tick gives `sessions` a fresh array identity (per this file's
    // own store mock — the panel just reads whatever storeState() returns
    // on the next render) — no extra plumbing should be needed for the
    // header to pick up the change.
    sessions = [asking({ sessionStatus: "awaiting_permission", sessionStatusSeverity: "blocked" })];
    rerender(<NotificationBell onOpenSession={vi.fn()} onOpenBrowser={vi.fn()} />);
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    expect(screen.getByText("Needs permission")).toBeInTheDocument();
  });

  // Issue #1293 — the group header calls formatStatusLabel(..., "compact"):
  // a long detail must not turn it into the verbose "label: detail" form.
  it("issue #1293 — the group header status stays in compact mode (bare label, no detail) even with a long sessionStatusDetail", async () => {
    sessions = [
      asking({
        sessionStatus: "awaiting_review_gate",
        sessionStatusSeverity: "blocked",
        sessionStatusDetail: "x".repeat(180),
      }),
    ];
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPanel();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.queryByText(/Needs review:/)).not.toBeInTheDocument();
  });

  // Hermes review, PR #1284 — there is no `.session-dot-exited` CSS class;
  // an "exited" status renders a CloseIcon instead of an unstyled dot.
  it("issue #1229 — renders a CloseIcon instead of an unstyled dot for an exited session", async () => {
    sessions = [
      makeSession({ sessionStatus: "exited", sessionStatusSeverity: "gone", alive: false }),
    ];
    events = { 1: [makeEvent({ seq: 1, kind: "session_end", payload: { exitCode: 2 } })] };
    await openPanel();
    expect(screen.getByText("exited")).toBeInTheDocument();
    const statusEl = screen.getByText("exited").closest(".notif-group-header-status");
    expect(statusEl?.querySelector("svg")).toBeInTheDocument();
    expect(statusEl?.querySelector(".session-dot-exited")).not.toBeInTheDocument();
  });

  it("issue #903 — a content-free notification row shows the session's last file change; a question row keeps its own text", async () => {
    sessions = [
      asking({ attentionKind: "question" }),
      asking({ id: 2, name: "other", attentionKind: "hookNotification" }),
    ];
    events = {
      1: [
        makeEvent({
          seq: 1,
          kind: "question",
          payload: { state: "started", header: "Stack menu" },
        }),
      ],
      2: [
        makeEvent({
          sessionId: 2,
          seq: 1,
          kind: "file_change",
          payload: { path: "src/hooks/forwarder-core.mjs", action: "modify" },
        }),
        makeEvent({
          sessionId: 2,
          seq: 2,
          payload: { attention: true, signal: "hookNotification", title: "", body: "" },
        }),
      ],
    };
    await openPanel();
    expect(screen.getByText("edited src/hooks/forwarder-core.mjs")).toBeInTheDocument();
    expect(screen.getByText("Needs answer: Stack menu")).toBeInTheDocument();
  });

  it("excludes routine and informative kinds (title_change, alt-screen, bell, silence, tool failures) from the decision rows", async () => {
    sessions = [makeSession({ attention: true, attentionKind: "silence" })];
    events = {
      1: [
        makeEvent({ seq: 1, kind: "title_change", payload: { title: "zsh" } }),
        makeEvent({ seq: 2, kind: "status_change", payload: { screen: "alt" } }),
        makeEvent({ seq: 3, payload: { attention: true, signal: "bell" } }),
        makeEvent({ seq: 4, payload: { attention: true, signal: "silence" } }),
        makeEvent({ seq: 5, kind: "tool_failure", payload: { tool: "Bash", error: "exit 2" } }),
        makeEvent({
          seq: 6,
          kind: "dev_server_detected",
          payload: { port: "5173", state: "dismissed" },
        }),
      ],
    };
    await openPanel();
    expect(document.querySelector(".notif-event-row")).not.toBeInTheDocument();
    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
    expect(document.querySelector(".attention-badge")).not.toBeInTheDocument();
  });

  it("sorts sessions by recency — the session with the newest open decision leads", async () => {
    sessions = [asking({ id: 1, name: "older" }), asking({ id: 2, name: "newer" })];
    events = {
      1: [makeEvent({ sessionId: 1, seq: 1, ts: 1000 })],
      2: [makeEvent({ sessionId: 2, seq: 1, ts: 5000 })],
    };
    await openPanel();
    const headers = screen.getAllByText(/older|newer/);
    expect(headers[0]).toHaveTextContent("newer");
    expect(headers[1]).toHaveTextContent("older");
  });

  it("dismiss removes the event from the feed and it does not resurface on a later render", async () => {
    // A fixed ts: a genuine redelivery of the same event below must carry
    // the exact same ts, the way the server's ring buffer replays it.
    events = { 1: [makeEvent({ seq: 1, ts: 1000 })] };
    const first = render(<NotificationBell onOpenSession={vi.fn()} onOpenBrowser={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    expect(screen.getByText(ROW_TEXT)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissEvents).toHaveBeenCalledWith(1, [1]);
    // Issue #1430 — "Dismiss" is an explicit read action.
    expect(ackAttention).toHaveBeenCalledWith(1);
    first.unmount();

    // A reconnect's replay re-delivers the same event (same seq AND ts): it
    // stays filtered, dismissal is keyed on (sessionId, seq, ts).
    events = { 1: [makeEvent({ seq: 1, ts: 1000 })] };
    render(<NotificationBell onOpenSession={vi.fn()} onOpenBrowser={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    expect(screen.queryByText(ROW_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
  });

  it("folds identical open decisions (two gates with the same prompt) and dismisses every folded seq at once", async () => {
    sessions = [
      makeSession({
        gates: [
          { gateId: "g1", prompt: "Deploy?", at: 1 },
          { gateId: "g2", prompt: "Deploy?", at: 2 },
          { gateId: "g3", prompt: "Deploy?", at: 3 },
        ],
      }),
    ];
    const gate = (seq: number) =>
      makeEvent({
        seq,
        kind: "review_gate",
        payload: { state: "waiting", prompt: "Deploy?", gateId: `g${seq}` },
      });
    events = { 1: [gate(1), gate(2), gate(3)] };
    await openPanel();
    expect(screen.getByText("×3")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissEvents).toHaveBeenCalledWith(1, [3, 2, 1]);
  });

  it("has no per-row Mark read on a decision: it stays until answered or dismissed", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPanel();
    expect(screen.queryByRole("button", { name: "Mark read" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  // Issue #1429 — one click destination everywhere (the phone sheet, push,
  // the ?session= deep link): the terminal, marked read.
  it("clicking an event row opens the session, marks it read, and closes the panel", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    const onOpenSession = await openPanel();
    await userEvent.click(screen.getByText(ROW_TEXT));
    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
    expect(markSessionRead).toHaveBeenCalledWith(1);
    // Issue #1430 — opening the row is an explicit read action.
    expect(ackAttention).toHaveBeenCalledWith(1);
    expect(screen.queryByText(ROW_TEXT)).not.toBeInTheDocument();
  });

  // Issue #1429 — Timeline is a secondary action alongside the row's own
  // open-the-session behavior.
  it("offers a secondary Timeline button that opens the timeline without also opening the session", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    const onOpenSession = vi.fn();
    const onOpenTimeline = vi.fn();
    render(
      <NotificationBell
        onOpenSession={onOpenSession}
        onOpenTimeline={onOpenTimeline}
        onOpenBrowser={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    await userEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(onOpenTimeline).toHaveBeenCalledWith(sessions[0]);
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(screen.queryByText(ROW_TEXT)).not.toBeInTheDocument();
  });

  it("opens a pr_* event's PR in the right sidebar; the Session button still opens the terminal", async () => {
    sessions = [makeSession()];
    events = {
      1: [makeEvent({ seq: 1, kind: "pr_ci_failed", payload: { number: 42, title: "Fix" } })],
    };
    const onOpenSession = await openPanel();
    await userEvent.click(screen.getByText("#42: CI failed"));
    expect(openRightSidebarPr).toHaveBeenCalledWith(sessions[0].projectId, 42);
    expect(markSessionRead).toHaveBeenCalledWith(1);
    expect(onOpenSession).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    await userEvent.click(screen.getByRole("button", { name: "Session" }));
    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
  });

  it("does not render a Timeline button when onOpenTimeline isn't provided", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPanel();
    expect(screen.queryByRole("button", { name: "Timeline" })).not.toBeInTheDocument();
  });

  // #3106 — the row was a role="button" holding its own buttons (axe's
  // nested-interactive) and named with text it did not show. It is a plain
  // container now with ONE real open button, first in tab order.
  describe("row keyboard and accessibility structure (#3106)", () => {
    const renderWithTimeline = async () => {
      events = { 1: [makeEvent({ seq: 1 })] };
      const onOpenSession = vi.fn();
      const onOpenTimeline = vi.fn();
      render(
        <NotificationBell
          onOpenSession={onOpenSession}
          onOpenTimeline={onOpenTimeline}
          onOpenBrowser={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
      const row = document.querySelector<HTMLElement>(".notif-event-row")!;
      const open = row.querySelector<HTMLElement>("button.notif-event-open")!;
      return { onOpenSession, onOpenTimeline, row, open };
    };

    it("has no interactive element inside another, and names the open button by what the row shows", async () => {
      const { row, open } = await renderWithTimeline();
      expect(row).not.toHaveAttribute("role");
      expect(row).not.toHaveAttribute("tabindex");
      expect(within(row).getAllByRole("button").length).toBeGreaterThanOrEqual(3);
      expectNoNestedInteractive(row);
      // The row's own words, without its other controls' labels. Its parts
      // are separate boxes on screen; textContent alone would glue them.
      const shown = row.cloneNode(true) as HTMLElement;
      shown.querySelectorAll("button").forEach((b) => b.remove());
      shown.querySelectorAll("span").forEach((part) => part.append(" "));
      expectNameHasVisibleText(open, shown);
    });

    it("puts the open button first among the row's tab stops, and Tab reaches it", async () => {
      const { row, open } = await renderWithTimeline();
      for (let i = 0; i < 20 && document.activeElement !== open; i += 1) await userEvent.tab();
      expect(open).toHaveFocus();
      const stops = within(row).getAllByRole("button");
      expect(stops[0]).toBe(open);
      expect(stops.slice(1).map((b) => b.textContent || b.getAttribute("aria-label"))).toEqual([
        "Timeline",
        "Dismiss",
      ]);
    });

    it("opens the session once on Enter on the open button", async () => {
      const { onOpenSession, open } = await renderWithTimeline();
      open.focus();
      await userEvent.keyboard("{Enter}");
      expect(onOpenSession).toHaveBeenCalledTimes(1);
      expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
    });

    it("opens the session once on Space on the open button", async () => {
      const { onOpenSession, open } = await renderWithTimeline();
      open.focus();
      await userEvent.keyboard(" ");
      expect(onOpenSession).toHaveBeenCalledTimes(1);
    });

    it("does not open the session when Enter activates the row's Timeline button", async () => {
      const { onOpenSession, onOpenTimeline } = await renderWithTimeline();
      screen.getByRole("button", { name: "Timeline" }).focus();
      await userEvent.keyboard("{Enter}");
      expect(onOpenTimeline).toHaveBeenCalledTimes(1);
      expect(onOpenSession).not.toHaveBeenCalled();
    });
  });
});

describe("NotificationBell — the trigger's popup semantics (issue #1894)", () => {
  // The trigger used to declare `aria-haspopup="true"`, the generic "this
  // opens something" value, which the ARIA spec maps to `menu`. What it
  // opens is the notifications panel — `role="dialog"` on the desktop, a
  // `ui/BottomSheet.tsx` on the phone — so the token now says so.
  const trigger = () => screen.getByRole("button", { name: /^Notifications,/ });

  it('names what it opens: aria-haspopup="dialog", not the generic "true"', () => {
    render(<NotificationBell onOpenSession={vi.fn()} onOpenBrowser={vi.fn()} />);
    expect(trigger()).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger()).not.toHaveAttribute("aria-haspopup", "true");
  });

  it("keeps aria-expanded tracking the panel's open state", async () => {
    const user = userEvent.setup();
    render(<NotificationBell onOpenSession={vi.fn()} onOpenBrowser={vi.fn()} />);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a dialog on the phone too, where the panel is a bottom sheet", async () => {
    // The phone renders the same trigger and the same `sheet` panel — a
    // `ui/BottomSheet.tsx`, which is itself `role="dialog"`. That is what
    // the trigger's token describes, so it is what the test pins.
    const user = userEvent.setup();
    render(<NotificationBell onOpenSession={vi.fn()} onOpenBrowser={vi.fn()} sheet />);

    await user.click(trigger());

    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(sheet).toHaveAttribute("aria-label", "Notifications");
  });
});

describe("review gate Approve/Deny (issue #178)", () => {
  function makeGateEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
    return {
      seq: 1,
      sessionId: 1,
      kind: "review_gate",
      ts: Date.now(),
      payload: { state: "waiting", prompt: "Run rm -rf /tmp/build?" },
      ...overrides,
    };
  }

  it("shows Approve/Deny for a waiting review_gate row when the session's own gateState is waiting", async () => {
    sessions = [
      makeSession({
        gateState: "waiting",
        gatePrompt: "Run rm -rf /tmp/build?",
        gates: [{ gateId: "g-1", prompt: "Run rm -rf /tmp/build?", at: Date.now() }],
      }),
    ];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  // Issue: correlate concurrent permission gates — two waiting gates on the
  // SAME session, each with its own event row and its own gateId. Each row
  // must show its OWN Approve/Deny, correlated by gateId (not just
  // `gateState === "waiting"`, which is now true for the whole session
  // regardless of which specific gate a row belongs to), and clicking one
  // row's Approve must resolve only that gate's id.
  it("shows independent Approve/Deny for two concurrent gates, each resolving its own gateId", async () => {
    sessions = [
      makeSession({
        gateState: "waiting",
        gatePrompt: "first command",
        gates: [
          { gateId: "g-first", prompt: "first command", at: 1000 },
          { gateId: "g-second", prompt: "second command", at: 2000 },
        ],
      }),
    ];
    events = {
      1: [
        makeGateEvent({
          seq: 1,
          payload: { state: "waiting", prompt: "first command", gateId: "g-first" },
        }),
        makeGateEvent({
          seq: 2,
          payload: { state: "waiting", prompt: "second command", gateId: "g-second" },
        }),
      ],
    };
    await openPanel();

    const approveButtons = screen.getAllByRole("button", { name: "Approve" });
    expect(approveButtons).toHaveLength(2);

    // Rows render newest-first — the first Approve button belongs to seq 2
    // ("second command" / g-second).
    await userEvent.click(approveButtons[0]);
    expect(resolveReviewGate).toHaveBeenCalledWith(1, "g-second", "approved");
    expect(resolveReviewGate).not.toHaveBeenCalledWith(1, "g-first", "approved");
  });

  // #3458 — an answered gate is no longer a decision: its row leaves the list,
  // even though the waiting event is still buffered.
  it("drops the row once the session's gate is no longer waiting, even though the waiting event is still buffered", async () => {
    sessions = [makeSession({ gateState: "approved" })];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    expect(screen.queryByText(/Waiting for review/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
  });

  // Issue #840/#844 — "lapsed" (nobody ever answered: a timeout, a dropped
  // connection, or a restart while a gate was pending) must render the same
  // as "denied"/"approved" here — no live-looking Approve/Deny for a gate
  // nothing is listening on. This is the case that used to zombie: before
  // issue #844, a restart persisted "waiting" instead, and this exact row
  // would have rendered Approve/Deny that always 409'd silently. (The
  // resolution event's own "No answer — agent decided at its own prompt"
  // label — eventDescriptions.ts's describeEvent — is covered by
  // eventDescriptions.test.ts instead: notifyKind() deliberately excludes a
  // resolved review_gate from this panel's feed at all, same as "approved"/
  // "denied" above, so it never has a row here to assert text against.)
  it("does not show Approve/Deny for a lapsed gate", async () => {
    sessions = [makeSession({ gateState: "lapsed" })];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    expect(screen.queryByText(/Waiting for review/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
  });

  it("Approve calls api.resolveReviewGate with the session id and 'approved', without opening the session", async () => {
    sessions = [
      makeSession({
        gateState: "waiting",
        gatePrompt: "x",
        gates: [{ gateId: "g-1", prompt: "x", at: Date.now() }],
      }),
    ];
    events = { 1: [makeGateEvent()] };
    const onOpenSession = await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(resolveReviewGate).toHaveBeenCalledWith(1, "g-1", "approved");
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("Deny opens an inline reason field instead of submitting immediately", async () => {
    sessions = [
      makeSession({
        gateState: "waiting",
        gatePrompt: "x",
        gates: [{ gateId: "g-1", prompt: "x", at: Date.now() }],
      }),
    ];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));

    expect(resolveReviewGate).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Reason (optional)")).toBeInTheDocument();
  });

  it("confirming Deny with a typed reason submits it, trimmed", async () => {
    sessions = [
      makeSession({
        gateState: "waiting",
        gatePrompt: "x",
        gates: [{ gateId: "g-1", prompt: "x", at: Date.now() }],
      }),
    ];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.type(screen.getByPlaceholderText("Reason (optional)"), "  looks unsafe  ");
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));

    expect(resolveReviewGate).toHaveBeenCalledWith(1, "g-1", "denied", "looks unsafe");
  });

  it("confirming Deny with no reason typed submits undefined, not an empty string", async () => {
    sessions = [
      makeSession({
        gateState: "waiting",
        gatePrompt: "x",
        gates: [{ gateId: "g-1", prompt: "x", at: Date.now() }],
      }),
    ];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));

    expect(resolveReviewGate).toHaveBeenCalledWith(1, "g-1", "denied", undefined);
  });

  it("Cancel returns to the Approve/Deny buttons without submitting", async () => {
    sessions = [
      makeSession({
        gateState: "waiting",
        gatePrompt: "x",
        gates: [{ gateId: "g-1", prompt: "x", at: Date.now() }],
      }),
    ];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(resolveReviewGate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("clicking Approve/Deny does not bubble into the row's own onOpen click handler", async () => {
    sessions = [
      makeSession({
        gateState: "waiting",
        gatePrompt: "x",
        gates: [{ gateId: "g-1", prompt: "x", at: Date.now() }],
      }),
    ];
    events = { 1: [makeGateEvent()] };
    const onOpenSession = await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});

// Issue #404 — the dev-server-detection accept/dismiss row, following the
// review-gate suite above's own structure.
describe("dev server detection Use/Dismiss (issue #404)", () => {
  function makeDevServerEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
    return {
      seq: 1,
      sessionId: 1,
      kind: "dev_server_detected",
      ts: Date.now(),
      payload: { port: "5173", projectId: 1 },
      ...overrides,
    };
  }

  it("shows Use this port/Ignore port for a pending row when the session's own pendingDevServerPort matches", async () => {
    sessions = [makeSession({ pendingDevServerPort: "5173" })];
    events = { 1: [makeDevServerEvent()] };
    await openPanel();

    expect(screen.getByText("Detected dev server on port 5173")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this port" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ignore port" })).toBeInTheDocument();
  });

  it("drops the offer once the session's pendingDevServerPort has moved past it, even though the event is still buffered", async () => {
    sessions = [makeSession({ pendingDevServerPort: null })];
    events = { 1: [makeDevServerEvent()] };
    await openPanel();

    expect(screen.queryByText("Detected dev server on port 5173")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use this port" })).not.toBeInTheDocument();
  });

  it("does not show Use this port for a stale/different pending port", async () => {
    sessions = [makeSession({ pendingDevServerPort: "5174" })];
    events = { 1: [makeDevServerEvent({ payload: { port: "5173", projectId: 1 } })] };
    await openPanel();

    expect(screen.queryByRole("button", { name: "Use this port" })).not.toBeInTheDocument();
  });

  it("excludes an already-resolved (accepted/dismissed) event from the feed entirely, same as review_gate's approved/denied", async () => {
    sessions = [makeSession({ pendingDevServerPort: null })];
    events = {
      1: [makeDevServerEvent({ payload: { port: "5173", projectId: 1, state: "accepted" } })],
    };
    await openPanel();

    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use this port" })).not.toBeInTheDocument();
  });

  it("Use this port calls api.acceptDevServerPort and opens the project's browser pane, without opening the session", async () => {
    sessions = [makeSession({ pendingDevServerPort: "5173" })];
    events = { 1: [makeDevServerEvent()] };
    const onOpenSession = vi.fn();
    const onOpenBrowser = vi.fn();
    render(<NotificationBell onOpenSession={onOpenSession} onOpenBrowser={onOpenBrowser} />);
    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));

    await userEvent.click(screen.getByRole("button", { name: "Use this port" }));

    expect(acceptDevServerPort).toHaveBeenCalledWith(1, "5173");
    expect(onOpenBrowser).toHaveBeenCalledWith(1);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("Ignore port calls api.dismissDevServerPort without opening the session or the browser pane", async () => {
    sessions = [makeSession({ pendingDevServerPort: "5173" })];
    events = { 1: [makeDevServerEvent()] };
    const onOpenSession = vi.fn();
    const onOpenBrowser = vi.fn();
    render(<NotificationBell onOpenSession={onOpenSession} onOpenBrowser={onOpenBrowser} />);
    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));

    await userEvent.click(screen.getByRole("button", { name: "Ignore port" }));

    expect(dismissDevServerPort).toHaveBeenCalledWith(1, "5173");
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onOpenBrowser).not.toHaveBeenCalled();
  });

  it("clicking Use this port/Ignore port does not bubble into the row's own onOpen click handler", async () => {
    sessions = [makeSession({ pendingDevServerPort: "5173" })];
    events = { 1: [makeDevServerEvent()] };
    const onOpenSession = await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Use this port" }));
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});

// Sanity-check for the jsdom stub itself — if this ever starts failing, the
// other structural assertions above (grouping/sorting/dismiss) would likely
// be silently passing for the wrong reason (an empty virtualized list).
describe("NotificationBell virtualization smoke test", () => {
  it("actually renders at least one row through the virtualizer, not zero", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPanel();
    const panel = document.querySelector(".notif-feed-scroll");
    expect(panel).not.toBeNull();
    expect(within(panel as HTMLElement).getByText(ROW_TEXT)).toBeInTheDocument();
  });
});

// N open review gates on one session, prompts distinct so none fold: the one
// decision kind that can hold many open rows at once.
function manyOpenGates(sessionId: number, n: number, tsBase: number, tag: string) {
  const gates = Array.from({ length: n }, (_, i) => ({
    gateId: `${tag}${i}`,
    prompt: `${tag}-Q${i}`,
    at: i,
  }));
  const gateEvents = gates.map((g, i) => ({
    seq: i + 1,
    sessionId,
    kind: "review_gate" as const,
    ts: tsBase + i,
    payload: { state: "waiting", prompt: g.prompt, gateId: g.gateId },
  }));
  return { gates, events: gateEvents };
}

function headerStyleFor(title: string): CSSStyleDeclaration | null {
  const titleEl = screen.queryByText(title);
  // The measured/positioned element is the `ref={rowVirtualizer.
  // measureElement}` wrapper — walk up to the nearest ancestor carrying
  // `data-index` (that wrapper's own attribute, set in NotificationBell.tsx's
  // row loop) rather than a fixed parent-hop count, since FeedHeader's own
  // internal nesting (title -> .notif-group-header-top -> .notif-group-header
  // -> wrapper) isn't this test's concern and has already changed once.
  const wrapper = titleEl?.closest("[data-index]");
  return wrapper instanceof HTMLElement ? wrapper.style : null;
}

// Issue #1229 — sticky group headers. Plain `position: sticky` can't work on
// these rows (each is absolutely positioned with its own `translateY`, which
// removes it from the sticky containing block) — these tests exercise the
// active-sticky-index + custom rangeExtractor workaround instead, using the
// height-differentiated stub above and manually driven scrollTop (see
// scrollFeedTo's own comment for why jsdom needs both).
describe("NotificationBell sticky group headers (issue #1229)", () => {
  it("keeps a header rendered and pinned (position: sticky) even once scrolled far outside the normal overscan window", async () => {
    // One session, 20 distinct events (varying `header` so none fold
    // together — see foldConsecutiveRows) — 21 rows total (1 header + 20
    // events), comfortably past `overscan: 8` once scrolled deep.
    const one = manyOpenGates(1, 20, Date.now(), "g");
    sessions = [makeSession({ gates: one.gates })];
    events = { 1: one.events };
    await openPanel();

    // Rows sort newest-seq-first (buildFeedItems' own within-group sort),
    // so scrolling to 900px lands well past the session's own header (which
    // ends at 34px) — comfortably outside `overscan: 8`'s reach on its own.
    // Asserted via the sticky style itself (not a specific event's text),
    // since which exact row is "at the top" isn't this test's own claim.
    scrollFeedTo(900);
    await waitFor(() => {
      expect(headerStyleFor("claude code")?.position).toBe("sticky");
    });
    expect(headerStyleFor("claude code")?.top).toBe("0px");
  });

  it("switches the active sticky header once scrolled past that group, and leaves the other absolutely positioned", async () => {
    const one = manyOpenGates(1, 30, 2_000_000, "a");
    const two = manyOpenGates(2, 30, 1_000_000, "b");
    sessions = [
      makeSession({ id: 1, name: "session one", gates: one.gates }),
      makeSession({ id: 2, name: "session two", gates: two.gates }),
    ];
    // Session 1 sorts first (newer ts) with enough events (30) that
    // scrolling partway into its own group keeps session two's header more
    // than `overscan: 8` rows away — otherwise, on a short enough list, it
    // would already be in the rendered window regardless of scroll, and
    // "not visible yet" would prove nothing.
    events = { 1: one.events, 2: two.events };
    await openPanel();

    // Deep inside session one's own events, comfortably short of session
    // two's group (which starts at 34 + 30*60 = 1834px) — session one's
    // header should be the active sticky one, and session two's header
    // shouldn't have rendered at all yet.
    scrollFeedTo(500);
    await waitFor(() => {
      expect(headerStyleFor("session one")?.position).toBe("sticky");
    });
    expect(screen.queryByText("session two")).not.toBeInTheDocument();

    // Scroll into session two's own group (it starts at 1834px and has enough
    // events to scroll inside) — session one's header, if still rendered nearby,
    // must NOT still claim sticky. Stay inside the content: virtual-core
    // >= 3.19.10 keeps a full viewport of rows when the offset is past the
    // end of the list, which would leave the range starting in session one.
    // Boundary first: session two's header exactly at the top of the viewport
    // must already hand the sticky slot over, not only a mid-group offset.
    scrollFeedTo(1834);
    await waitFor(() => {
      expect(headerStyleFor("session two")?.position).toBe("sticky");
    });
    expect(headerStyleFor("session one")?.position ?? "absolute").not.toBe("sticky");
    scrollFeedTo(2000);
    await waitFor(() => {
      expect(headerStyleFor("session two")?.position).toBe("sticky");
    });
    const sessionOneStyle = headerStyleFor("session one");
    if (sessionOneStyle) expect(sessionOneStyle.position).not.toBe("sticky");
  });
});

// P11 — the popover previously had no focus management: no role, no
// focus-in on open, no Tab trap, no focus-restore on close, and (unlike
// Settings/CommandPalette, which both close on Escape via App.tsx's global
// handler) no Escape support at all — only mousedown outside-click could
// close it. Uses the shared useFocusTrap.ts hook.
describe("NotificationBell popover — focus management (P11)", () => {
  it("has dialog semantics, no aria-modal (no backdrop — same rule as PaneTab's menu/UnifiedBoard's drawer)", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPanel();

    const dialog = screen.getByRole("dialog", { name: "Notifications" });
    expect(dialog).not.toHaveAttribute("aria-modal");
  });

  it("moves focus into the panel when it opens, and Tab reaches the close button, the section switch, the chips, then the first row", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPanel();

    // The dialog itself: its rows are virtualized and mount after it opens,
    // and Tab moves on into them from here.
    expect(screen.getByRole("dialog", { name: "Notifications" })).toHaveFocus();
    // Tab moves on: the close button, the section switch, the chips, then
    // the rows.
    const stops: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await userEvent.tab();
      const el = document.activeElement as HTMLElement;
      if (el.classList.contains("notif-event-open")) break;
      stops.push(el.getAttribute("aria-label") ?? el.textContent ?? "");
    }
    expect(stops).toEqual([
      "Close notifications",
      "Sessions 1",
      "Tasks",
      "Needs you 1",
      "All",
      "Question 1",
    ]);
    expect(document.activeElement).toHaveClass("notif-event-open");
  });

  it("restores focus to the bell button on close", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPanel();

    const bell = screen.getByRole("button", { name: /^Notifications,/ });
    await userEvent.click(document.body);

    expect(bell).toHaveFocus();
  });

  it("closes on Escape, unlike before this fix (previously only mousedown outside-click worked)", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPanel();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Notifications,/ })).toHaveFocus();
  });

  it("traps Tab within the panel", async () => {
    events = { 1: [makeEvent({ seq: 1 }), makeEvent({ seq: 2 })] };
    await openPanel();

    const dialog = screen.getByRole("dialog", { name: "Notifications" });
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled])"));
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();

    first.focus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("does not restore focus to the bell button when closing by opening a session", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    const onOpenSession = await openPanel();
    const bell = screen.getByRole("button", { name: /^Notifications,/ });

    await userEvent.click(screen.getByText(ROW_TEXT));

    expect(onOpenSession).toHaveBeenCalled();
    expect(bell).not.toHaveFocus();
  });
});

// Issue #1399 — since #1398 the toolbar (and the bell in it) moves with the
// iOS visual viewport when it pans with the keyboard open, with no window
// `resize` to trigger the existing reposition.
// #3462 — tablet and desktop get one full-height side panel, anchored to the
// right edge of the rail that holds the bell, in place of the popover and the
// tablet's bottom sheet.
describe("NotificationBell side panel (#3462)", () => {
  function renderInRail(props: Partial<Parameters<typeof NotificationBell>[0]> = {}) {
    const rail = document.createElement("nav");
    rail.className = "left-rail";
    document.body.appendChild(rail);
    let railRight = 56;
    vi.spyOn(rail, "getBoundingClientRect").mockImplementation(
      () => ({ right: railRight }) as DOMRect,
    );
    render(
      <NotificationBell
        onOpenSession={vi.fn()}
        onOpenBrowser={vi.fn()}
        triggerClassName="left-rail-btn"
        {...props}
      />,
      { container: rail },
    );
    return { rail, setRailRight: (v: number) => (railRight = v) };
  }

  afterEach(() => {
    uninstallFakeVisualViewport();
    resetPhoneBackStackForTests();
    vi.restoreAllMocks();
    document.querySelectorAll("nav.left-rail").forEach((n) => n.remove());
  });

  it("opens beside the rail, from its right edge, with no scrim and not modal", async () => {
    renderInRail();
    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    expect(panel).toHaveClass("notif-panel");
    expect(panel).not.toHaveClass("notif-panel--touch");
    expect(panel.style.left).toBe("56px");
    expect(panel).toHaveAttribute("data-placement", "side");
    expect(panel).not.toHaveAttribute("aria-modal");
    expect(document.querySelector(".notif-scrim")).toBeNull();
  });

  it("follows the rail when the visual viewport moves it (#1399)", async () => {
    const vv = installFakeVisualViewport();
    const { setRailRight } = renderInRail();
    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    setRailRight(64);
    await act(async () => {
      vv.panTo(40);
      await flushRaf();
    });
    expect(panel.style.left).toBe("64px");
  });

  it("closes on Esc, on an outside click and from its close button, returning focus to the bell", async () => {
    renderInRail();
    const bell = screen.getByRole("button", { name: /^Notifications,/ });
    await userEvent.click(bell);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bell).toHaveFocus();

    await userEvent.click(bell);
    await userEvent.click(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(bell);
    await userEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bell).toHaveFocus();
  });

  describe("on a touch tablet", () => {
    let pushState: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      resetPhoneBackStackForTests();
      pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
      vi.spyOn(window.history, "back").mockImplementation(() => {});
    });

    it("is the wider, modal variant over a scrim that closes it", async () => {
      renderInRail({ touch: true });
      await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
      const panel = screen.getByRole("dialog", { name: "Notifications" });
      expect(panel).toHaveClass("notif-panel", "notif-panel--touch");
      expect(panel).toHaveAttribute("aria-modal", "true");
      const scrim = document.querySelector<HTMLElement>(".notif-scrim");
      expect(scrim).not.toBeNull();
      expect(scrim!.style.left).toBe("56px");
      await userEvent.click(scrim!);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("closes on the back gesture, as the sheet it replaces did", async () => {
      renderInRail({ touch: true });
      await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
      expect(pushState).toHaveBeenCalledTimes(1);
      act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
      expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    });
  });

  it("is 420px wide, 480px on a touch tablet, and runs the full height", () => {
    const rule = (selector: string) => {
      const start = terminalCss.indexOf(`${selector} {`);
      return terminalCss.slice(start, terminalCss.indexOf("}", start));
    };
    expect(rule(".notif-panel")).toMatch(/width:\s*420px/);
    expect(rule(".notif-panel")).toMatch(/top:\s*var\(--shell-top, 0px\)/);
    expect(rule(".notif-panel")).toMatch(/bottom:\s*var\(--kb-inset, 0px\)/);
    expect(rule(".notif-panel.notif-panel--touch")).toMatch(/width:\s*480px/);
  });
});

describe("NotificationBell phone sheet", () => {
  async function openPhoneSheet(
    props: Partial<Parameters<typeof NotificationBell>[0]> = {},
  ): Promise<ReturnType<typeof vi.fn>> {
    const onOpenSession = vi.fn();
    render(
      <NotificationBell onOpenSession={onOpenSession} onOpenBrowser={vi.fn()} sheet {...props} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    return onOpenSession;
  }

  const gateEvent = (seq: number): NotificationEvent => ({
    seq,
    sessionId: 1,
    kind: "review_gate",
    ts: Date.now(),
    payload: { state: "waiting", prompt: "Run rm -rf /tmp/build?" },
  });

  it("renders a modal bottom sheet, not the desktop popover", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPhoneSheet();
    const dialog = screen.getByRole("dialog", { name: "Notifications" });
    expect(dialog).toHaveClass("mobile-notif-sheet");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.querySelector(".notif-panel")).toBeNull();
  });

  it("keeps the desktop popover when `sheet` is not set", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPanel();
    expect(document.querySelector(".notif-panel")).not.toBeNull();
    expect(document.querySelector(".mobile-notif-sheet")).toBeNull();
  });

  it("opens on 'Needs you' when a session needs you, and 'All' shows the rest", async () => {
    sessions = [asking({ id: 1, name: "needy" }), makeSession({ id: 2, name: "calm" })];
    events = {
      1: [makeEvent({ seq: 1, sessionId: 1 })],
      2: [
        makeEvent({ seq: 1, sessionId: 2, kind: "status_change", payload: { reason: "exited" } }),
      ],
    };
    await openPhoneSheet();
    expect(screen.getByRole("button", { name: "Needs you 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("needy")).toBeInTheDocument();
    expect(screen.queryByText("Earlier, no decision needed")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await userEvent.click(screen.getByRole("button", { name: /Earlier, no decision needed/ }));
    expect(screen.getByRole("button", { name: /^calm exited/ })).toBeInTheDocument();
  });

  it("opens on 'All' when nothing needs you", async () => {
    sessions = [makeSession()];
    events = { 1: [makeEvent({ seq: 1, kind: "status_change", payload: { reason: "exited" } })] };
    await openPhoneSheet();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Nothing needs you right now")).toBeInTheDocument();
    expect(screen.getByText("Earlier, no decision needed")).toBeInTheDocument();
  });

  it("says nothing needs you (not 'no notifications') on an empty Needs you filter", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPhoneSheet();
    // Answered: the session's attention clears; the filter is empty.
    sessions = [makeSession({ attention: false })];
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await userEvent.click(screen.getByRole("button", { name: /Needs you/ }));
    expect(screen.getByText("Nothing needs you right now")).toBeInTheDocument();
  });

  it("tap opens the session's TERMINAL, marks it read, and closes the sheet", async () => {
    events = {
      1: [makeEvent({ seq: 3 }), makeEvent({ seq: 7, kind: "title_change", payload: {} })],
    };
    const onOpenTimeline = vi.fn();
    const onOpenSession = await openPhoneSheet({ onOpenTimeline });
    await userEvent.click(screen.getByRole("button", { name: /Heads up/ }));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(onOpenTimeline).not.toHaveBeenCalled();
    // Cursor advances to the session's true latest seq (not just this row's).
    expect(markEventSeen).toHaveBeenCalledWith(1, 7);
    // Issue #1430 — tapping the row is an explicit read action.
    expect(ackAttention).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers the timeline as its own action", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    const onOpenTimeline = vi.fn();
    const onOpenSession = await openPhoneSheet({ onOpenTimeline });
    await userEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(onOpenTimeline).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows no Timeline action when the caller has no timeline", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPhoneSheet();
    expect(screen.queryByRole("button", { name: "Timeline" })).toBeNull();
  });

  it("dismisses a row without opening it; a decision has no Mark read", async () => {
    events = { 1: [makeEvent({ seq: 4 })] };
    const onOpenSession = await openPhoneSheet();
    expect(screen.queryByRole("button", { name: "Mark read" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissEvents).toHaveBeenCalledWith(1, [4]);
    expect(onOpenSession).not.toHaveBeenCalled();
    // Issue #1430 — "Dismiss" is an explicit read action.
    expect(ackAttention).toHaveBeenCalledWith(1);
  });

  it("Read all sits with the grouped rows: under All, never touching a session with an open decision", async () => {
    sessions = [
      asking({ id: 1, name: "needy" }),
      makeSession({ id: 2, name: "calm", attention: true, attentionKind: "agentIdle" }),
    ];
    events = {
      1: [makeEvent({ seq: 5, sessionId: 1 })],
      2: [makeEvent({ seq: 9, sessionId: 2, payload: { attention: true, signal: "agentIdle" } })],
    };
    await openPhoneSheet();
    // "Needs you" lists decisions only: nothing there to read.
    expect(screen.queryByRole("button", { name: "Read all" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await userEvent.click(screen.getByRole("button", { name: "Read all" }));
    expect(markEventSeen).toHaveBeenCalledWith(2, 9);
    expect(markEventSeen).not.toHaveBeenCalledWith(1, expect.anything());
    // Issue #1430 — "Read all" is an explicit read action.
    expect(ackAttention).toHaveBeenCalledWith(2);
    expect(ackAttention).not.toHaveBeenCalledWith(1);
  });

  it("approves a pending gate inline from the sheet", async () => {
    sessions = [
      makeSession({
        gateState: "waiting",
        gates: [{ gateId: "g-1", prompt: "Run rm -rf /tmp/build?", at: Date.now() }],
        attention: true,
      }),
    ];
    events = {
      1: [{ ...gateEvent(1), payload: { state: "waiting", gateId: "g-1", prompt: "x" } }],
    };
    await openPhoneSheet();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(resolveReviewGate).toHaveBeenCalledWith(1, "g-1", "approved");
  });

  it("closes from the backdrop, the close button and Escape", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    await openPhoneSheet();
    await userEvent.click(document.querySelector(".mobile-session-backdrop") as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    await userEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /^Notifications,/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not offer a Needs you count/filter for a session the feed has nothing to list for", async () => {
    // attention persists, but every decision event was dismissed.
    events = { 1: [makeEvent({ seq: 1, ts: 1000 })] };
    dismissedEventKeys = { [eventKey(1, 1, 1000)]: true };
    await openPhoneSheet();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Needs you \d/ })).toBeNull();
  });

  it("Enter on the Timeline button opens the timeline, not the terminal", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    const onOpenTimeline = vi.fn();
    const onOpenSession = await openPhoneSheet({ onOpenTimeline });
    screen.getByRole("button", { name: "Timeline" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpenTimeline).toHaveBeenCalledTimes(1);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  describe("history (Android back)", () => {
    let pushState: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      resetPhoneBackStackForTests();
      pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
      vi.spyOn(window.history, "back").mockImplementation(() => {});
      events = { 1: [makeEvent({ seq: 1 })] };
    });
    afterEach(() => {
      resetPhoneBackStackForTests();
      vi.restoreAllMocks();
    });

    it("closes the phone sheet", async () => {
      await openPhoneSheet();
      expect(pushState).toHaveBeenCalledTimes(1);
      act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
      expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    });

    it("is never touched by the desktop popover", async () => {
      await openPanel();
      expect(pushState).not.toHaveBeenCalled();
    });
  });
});
