// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationBell } from "./NotificationBell.js";
import type { NotificationEvent, Project, Session } from "./api.js";

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
let notificationsPanelOpenRequest: number;

function eventKey(sessionId: number, seq: number): string {
  return `${sessionId}:${seq}`;
}

const markEventSeen = vi.fn((sessionId: number, seq: number) => {
  const current = lastSeenSeq[sessionId] ?? 0;
  if (seq > current) lastSeenSeq = { ...lastSeenSeq, [sessionId]: seq };
});

const dismissEvent = vi.fn((sessionId: number, seq: number) => {
  dismissedEventKeys = { ...dismissedEventKeys, [eventKey(sessionId, seq)]: true };
});

function storeState() {
  return {
    theme: "dark",
    sessions,
    projects,
    events,
    lastSeenSeq,
    dismissedEventKeys,
    markEventSeen,
    dismissEvent,
    notificationsPanelOpenRequest,
  };
}

vi.mock("./store.js", () => {
  const useDashboardStore = (selector: (s: unknown) => unknown) => selector(storeState());
  return { useDashboardStore, eventKey };
});

// Minimal review gate (issue #178) — GateActions calls api.resolveReviewGate
// directly (not through the store), so it's mocked the same
// selector-independent way.
const resolveReviewGate = vi.fn((_id: number, _decision: "approved" | "denied", _reason?: string) =>
  Promise.resolve(),
);
// A lazy wrapper, not `{ resolveReviewGate }` directly: vi.mock's factory
// runs at module-resolution time (hoisted above this file's own `const`
// declarations), before `resolveReviewGate` above has actually initialized
// — referencing it directly here would hit the same TDZ vi.mock footgun
// store.js's mock below avoids via storeState() being a lazily-invoked
// function declaration instead.
vi.mock("./api.js", () => ({
  api: {
    resolveReviewGate: (...args: [number, "approved" | "denied", string?]) =>
      resolveReviewGate(...args),
  },
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    projectId: 1,
    name: "claude code",
    nameLocked: true,
    command: "claude code",
    cwd: null,
    liveCwd: null,
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
    ...overrides,
  };
}

// Defaults to a bell-signal attention event (describeEvent -> "Bell") so
// most tests don't need to spell out a payload just to get readable text.
function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "attention",
    ts: Date.now(),
    payload: { attention: true, signal: "bell" },
    ...overrides,
  };
}

// The virtual list's scroll container and row wrappers need a non-zero
// `offsetHeight` in jsdom (which never lays out CSS, so every element
// reports 0 by default) — @tanstack/react-virtual reads `offsetHeight`
// directly (see node_modules/@tanstack/virtual-core) both for the scroll
// container's own visible height and for each row's measured size. Without
// this, the container's computed viewport height is 0 and getVirtualItems()
// never returns anything, so every "renders a row" assertion would fail for
// a reason that has nothing to do with this component's own logic. The
// scroll container is distinguished by its class; every other measured
// element is a row (header or event).
function stubVirtualizerLayout() {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("notif-feed-scroll") ? 400 : 50;
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
}

// Renders the bell and opens its dropdown, returning the onOpenSession spy
// (a fresh one per call unless the caller supplies its own) so tests that
// only care about the panel's contents don't each need their own
// render+click boilerplate.
async function openPanel(onOpenSession = vi.fn()) {
  render(<NotificationBell onOpenSession={onOpenSession} />);
  await userEvent.click(screen.getByRole("button", { name: /notifications/i }));
  return onOpenSession;
}

beforeEach(() => {
  sessions = [makeSession()];
  projects = [{ id: 1, name: "mullion", cwd: "/x", hostId: "local" } as Project];
  events = {};
  lastSeenSeq = {};
  dismissedEventKeys = {};
  notificationsPanelOpenRequest = 0;
  markEventSeen.mockClear();
  dismissEvent.mockClear();
  resolveReviewGate.mockClear();
  resolveReviewGate.mockResolvedValue(undefined);
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

  it("shows no unread badge on the trigger button when there are no events", () => {
    render(<NotificationBell onOpenSession={vi.fn()} />);
    expect(document.querySelector(".attention-badge")).not.toBeInTheDocument();
  });

  it("renders one row per notification-worthy event, grouped under a session header", async () => {
    events = {
      1: [
        makeEvent({ seq: 1 }),
        makeEvent({ seq: 2, kind: "status_change", payload: { reason: "exited" } }),
      ],
    };
    await openPanel();
    expect(screen.getByText("claude code")).toBeInTheDocument(); // group header title
    expect(screen.getByText("mullion")).toBeInTheDocument(); // group header subtitle
    expect(screen.getByText("Bell")).toBeInTheDocument();
    expect(screen.getByText("Exited")).toBeInTheDocument();
  });

  it("excludes routine, high-frequency kinds (title_change, alt-screen status_change) from the feed", async () => {
    events = {
      1: [
        makeEvent({ seq: 1, kind: "title_change", payload: { title: "zsh" } }),
        makeEvent({ seq: 2, kind: "status_change", payload: { screen: "alt" } }),
        makeEvent({ seq: 3 }),
      ],
    };
    await openPanel();
    expect(screen.queryByText("zsh")).not.toBeInTheDocument();
    expect(screen.queryByText("Entered full-screen mode")).not.toBeInTheDocument();
    expect(screen.getByText("Bell")).toBeInTheDocument();
  });

  it("sorts sessions by recency — the session with the newest event leads", async () => {
    sessions = [makeSession({ id: 1, name: "older" }), makeSession({ id: 2, name: "newer" })];
    events = {
      1: [makeEvent({ sessionId: 1, seq: 1, ts: 1000 })],
      2: [makeEvent({ sessionId: 2, seq: 1, ts: 5000 })],
    };
    await openPanel();
    const headers = screen.getAllByText(/older|newer/);
    expect(headers[0]).toHaveTextContent("newer");
    expect(headers[1]).toHaveTextContent("older");
  });

  it("shows an unread count on the trigger badge for unread notification-worthy events", () => {
    events = { 1: [makeEvent({ seq: 1 }), makeEvent({ seq: 2 })] };
    render(<NotificationBell onOpenSession={vi.fn()} />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("excludes dismissed events from the unread count", () => {
    events = { 1: [makeEvent({ seq: 1 }), makeEvent({ seq: 2 })] };
    dismissedEventKeys = { "1:1": true };
    render(<NotificationBell onOpenSession={vi.fn()} />);
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("per-event mark-read advances the cursor to that event's own seq, without touching newer unread events", async () => {
    events = { 1: [makeEvent({ seq: 1 }), makeEvent({ seq: 2 })] };
    await openPanel();
    const markReadButtons = screen.getAllByRole("button", { name: "Mark read" });
    expect(markReadButtons).toHaveLength(2);

    // Rows render newest-first — the first "Mark read" button belongs to seq 2.
    await userEvent.click(markReadButtons[0]);
    expect(markEventSeen).toHaveBeenCalledWith(1, 2);
  });

  it("dismiss removes the event from the feed and it does not resurface on a later render", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    const first = render(<NotificationBell onOpenSession={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByText("Bell")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissEvent).toHaveBeenCalledWith(1, 1);
    first.unmount();

    // Simulate the dismissal actually landing in the store (the mock above
    // already updated `dismissedEventKeys`) and a fresh mount — mirrors a
    // reconnect's replay batch re-delivering an event this store already
    // has: the SAME event object arrives again in `events`, and must still
    // stay filtered out because dismissal is keyed on (sessionId, seq), not
    // on the event's continued presence in the `events` slice.
    events = { 1: [makeEvent({ seq: 1 })] };
    render(<NotificationBell onOpenSession={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.queryByText("Bell")).not.toBeInTheDocument();
    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
  });

  it("mark-all-read advances every unread session's cursor to its true latest seq across all buffered events, not just notification-worthy ones", async () => {
    events = {
      1: [
        makeEvent({ seq: 1 }),
        // A routine title_change with a HIGHER seq than the notification-worthy
        // event — mark-all-read should still clear the tab badge fully, so it
        // must advance past this too, not stop at the last notify-worthy seq.
        makeEvent({ seq: 2, kind: "title_change", payload: { title: "zsh" } }),
      ],
    };
    await openPanel();
    await userEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(markEventSeen).toHaveBeenCalledWith(1, 2);
  });

  it("clicking an event row opens the session and closes the panel", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    const onOpenSession = await openPanel();
    await userEvent.click(screen.getByText("Bell"));
    expect(onOpenSession).toHaveBeenCalledWith(sessions[0]);
    expect(screen.queryByText("Bell")).not.toBeInTheDocument();
  });

  it("keeps an already-read event visible in the feed (history, not just unread inbox), without a mark-read button", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    lastSeenSeq = { 1: 1 };
    await openPanel();
    expect(screen.getByText("Bell")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark read" })).not.toBeInTheDocument();
    // Dismiss is still offered even for a read event.
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("does not show the mark-all-read button when nothing is unread", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    lastSeenSeq = { 1: 1 };
    await openPanel();
    expect(screen.queryByRole("button", { name: "Mark all read" })).not.toBeInTheDocument();
  });
});

// Issue #170: a desktop notification's onclick handler opens the panel by
// bumping store.ts's `notificationsPanelOpenRequest` (App.tsx can't reach
// this component's local `open` state with a prop) rather than the trigger
// button being clicked directly.
describe("notificationsPanelOpenRequest (issue #170)", () => {
  it("does not open the panel on initial mount, even with a nonzero request already pending", () => {
    notificationsPanelOpenRequest = 3;
    render(<NotificationBell onOpenSession={vi.fn()} />);
    expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();
  });

  it("opens the panel when the request counter changes after mount", () => {
    const { rerender } = render(<NotificationBell onOpenSession={vi.fn()} />);
    expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();

    notificationsPanelOpenRequest += 1;
    rerender(<NotificationBell onOpenSession={vi.fn()} />);

    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
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
    sessions = [makeSession({ gateState: "waiting", gatePrompt: "Run rm -rf /tmp/build?" })];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("does not show Approve/Deny once the session's gateState has moved past waiting, even though the waiting event is still in the feed", async () => {
    sessions = [makeSession({ gateState: "approved" })];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    expect(screen.getByText(/Waiting for review/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
  });

  it("Approve calls api.resolveReviewGate with the session id and 'approved', without opening the session", async () => {
    sessions = [makeSession({ gateState: "waiting", gatePrompt: "x" })];
    events = { 1: [makeGateEvent()] };
    const onOpenSession = await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(resolveReviewGate).toHaveBeenCalledWith(1, "approved");
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("Deny opens an inline reason field instead of submitting immediately", async () => {
    sessions = [makeSession({ gateState: "waiting", gatePrompt: "x" })];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));

    expect(resolveReviewGate).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Reason (optional)")).toBeInTheDocument();
  });

  it("confirming Deny with a typed reason submits it, trimmed", async () => {
    sessions = [makeSession({ gateState: "waiting", gatePrompt: "x" })];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.type(screen.getByPlaceholderText("Reason (optional)"), "  looks unsafe  ");
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));

    expect(resolveReviewGate).toHaveBeenCalledWith(1, "denied", "looks unsafe");
  });

  it("confirming Deny with no reason typed submits undefined, not an empty string", async () => {
    sessions = [makeSession({ gateState: "waiting", gatePrompt: "x" })];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));

    expect(resolveReviewGate).toHaveBeenCalledWith(1, "denied", undefined);
  });

  it("Cancel returns to the Approve/Deny buttons without submitting", async () => {
    sessions = [makeSession({ gateState: "waiting", gatePrompt: "x" })];
    events = { 1: [makeGateEvent()] };
    await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(resolveReviewGate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("clicking Approve/Deny does not bubble into the row's own onOpen click handler", async () => {
    sessions = [makeSession({ gateState: "waiting", gatePrompt: "x" })];
    events = { 1: [makeGateEvent()] };
    const onOpenSession = await openPanel();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
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
    expect(within(panel as HTMLElement).getByText("Bell")).toBeInTheDocument();
  });
});
