// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionTimeline } from "./SessionTimeline.js";
import type { NotificationEvent, Session } from "./api.js";

let sessions: Session[];
let events: Record<number, NotificationEvent[]>;

function storeState() {
  return { sessions, events };
}

vi.mock("./store.js", () => {
  const useDashboardStore = (selector: (s: unknown) => unknown) => selector(storeState());
  const eventKey = (sessionId: number, seq: number) => `${sessionId}:${seq}`;
  return { useDashboardStore, eventKey };
});

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
    // Rich statuses (issue: extend surfaced session statuses).
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
    ts: Date.now(),
    payload: { attention: true, signal: "bell" },
    ...overrides,
  };
}

beforeEach(() => {
  sessions = [makeSession()];
  events = {};
});

describe("SessionTimeline sessionIds (Phase 6, 6.5/#218)", () => {
  it("shows a distinct 'no session yet' message for an empty sessionIds array (unclaimed task)", () => {
    sessions = [];
    render(<SessionTimeline params={{ sessionIds: [] }} />);
    expect(screen.getByText("No session yet.")).toBeInTheDocument();
  });

  it("merges and sorts events from multiple sessions by timestamp, not per-session seq", () => {
    // Independent review, PR #477 — the original fixture had ts-order and
    // seq-order agree (session 1's event had both the lower seq AND the
    // earlier ts), so this test still passed under a pure-seq sort and
    // didn't actually prove ts is what's driving the order. Session 1's
    // event now has the HIGHER seq but the EARLIER ts — a pure-seq sort
    // would put it second; the real ts-sort must put it first.
    sessions = [makeSession({ id: 1 }), makeSession({ id: 2 })];
    events = {
      1: [makeEvent({ sessionId: 1, seq: 10, ts: 1000 })],
      2: [
        makeEvent({
          sessionId: 2,
          seq: 1,
          ts: 2000,
          kind: "file_change",
          payload: { path: "src/review.ts", action: "modify" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1, 2] }} />);

    const rows = screen.getAllByText(/Bell|Changed src\/review\.ts/);
    // Session 1's event has the earlier ts (1000 vs. 2000) despite the
    // higher seq — wall-clock order wins, since seq is only comparable
    // within one session.
    expect(rows[0]).toHaveTextContent("Bell");
    expect(rows[1]).toHaveTextContent("Changed src/review.ts");
  });

  it("falls back to the pre-6.5 { sessionId } param shape (a workspace layout saved before this PR)", () => {
    // Independent review, PR #477 — dockview restores a persisted layout's
    // panel params verbatim; a timeline panel docked before this PR shipped
    // still carries the old singular `sessionId` field, not `sessionIds`.
    sessions = [makeSession({ id: 1 })];
    events = { 1: [makeEvent({ sessionId: 1, seq: 1 })] };
    render(<SessionTimeline params={{ sessionId: 1 }} />);
    expect(screen.getByText("Bell")).toBeInTheDocument();
  });

  it("merges subagent labels across every requested session", () => {
    sessions = [
      makeSession({
        id: 1,
        subagents: [
          {
            agentId: "worker-subagent",
            agentType: "worker",
            startedAt: Date.now(),
            endedAt: null,
            summary: null,
            fileChanges: 0,
            toolFailures: 0,
            eventCount: 1,
          },
        ],
      }),
      makeSession({ id: 2, subagents: [] }),
    ];
    events = {
      1: [
        makeEvent({
          sessionId: 1,
          seq: 1,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify", agentId: "worker-subagent" },
        }),
      ],
      2: [
        makeEvent({
          sessionId: 2,
          seq: 1,
          kind: "file_change",
          payload: { path: "src/b.ts", action: "modify", agentId: "review-subagent" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1, 2] }} />);

    // session 1's subagent resolves to its real label; session 2's unknown
    // agentId falls back to its truncated id — both from the merged pool,
    // not just the first session's own subagents.
    expect(screen.getByRole("button", { name: "worker" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "review-subagent".slice(0, 8) })).toBeInTheDocument();
  });
});

describe("SessionTimeline (issue #212)", () => {
  it("shows a not-found message when the session isn't tracked", () => {
    sessions = [];
    render(<SessionTimeline params={{ sessionIds: [1] }} />);
    expect(screen.getByText("Session not found.")).toBeInTheDocument();
  });

  it("shows an empty state when the session has no events", () => {
    render(<SessionTimeline params={{ sessionIds: [1] }} />);
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("renders one row per describable event, oldest first (store order)", () => {
    events = {
      1: [
        makeEvent({ seq: 1, ts: 1000 }),
        makeEvent({
          seq: 2,
          ts: 2000,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    const rows = screen.getAllByText(/Bell|Changed src\/a\.ts/);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Bell");
    expect(rows[1]).toHaveTextContent("Changed src/a.ts");
  });

  it("drops events describeEvent can't describe (e.g. a bare title_change with no title)", () => {
    events = {
      1: [makeEvent({ seq: 1, kind: "title_change", payload: {} })],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("filters by kind via the chip toggles", async () => {
    events = {
      1: [
        makeEvent({ seq: 1 }),
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);
    expect(screen.getByText("Bell")).toBeInTheDocument();
    expect(screen.getByText("Changed src/a.ts")).toBeInTheDocument();

    // Untoggling "Files" hides the file_change row without touching the
    // attention one.
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByText("Bell")).toBeInTheDocument();
    expect(screen.queryByText("Changed src/a.ts")).not.toBeInTheDocument();
  });

  it("shows the filtered-empty message once every kind is toggled off", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.click(screen.getByRole("button", { name: "Attention" }));

    expect(screen.getByText("No events match the current filter.")).toBeInTheDocument();
  });

  it("searches the described text, case-insensitively", async () => {
    events = {
      1: [
        makeEvent({ seq: 1 }),
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/Widget.tsx", action: "create" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.type(screen.getByLabelText("Search timeline"), "widget");

    expect(screen.queryByText("Bell")).not.toBeInTheDocument();
    expect(screen.getByText("Created src/Widget.tsx")).toBeInTheDocument();
  });

  it("search and kind filters combine (both must match)", async () => {
    events = {
      1: [
        makeEvent({ seq: 1 }),
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/bell-widget.ts", action: "modify" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.type(screen.getByLabelText("Search timeline"), "bell");
    // Both rows match the text search ("Bell" and ".../bell-widget.ts"), but
    // untoggling "Attention" should still remove only that one.
    await userEvent.click(screen.getByRole("button", { name: "Attention" }));

    expect(screen.queryByText("Bell")).not.toBeInTheDocument();
    expect(screen.getByText("Changed src/bell-widget.ts")).toBeInTheDocument();
  });
});

describe("SessionTimeline subagent grouping (Phase 5 Track A, #195/5.5a)", () => {
  it("renders no subagent filter row when no event carries an agentId, and the event still renders", () => {
    // The no-group assertion is the load-bearing one — see the
    // filter-predicate comment in SessionTimeline.tsx for why a session
    // with zero subagents can never have anything to isolate against. The
    // getByText assertion is a plain sanity check that the event itself
    // still describes/renders in this shape (independent review, PR #449:
    // on a fresh render activeAgentKeys is always empty, so this line alone
    // can't detect a broken render gate — that's what the no-group
    // assertion above is for).
    events = {
      1: [makeEvent({ seq: 1 })],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);
    expect(screen.queryByRole("group", { name: "Filter by subagent" })).not.toBeInTheDocument();
    expect(screen.getByText("Bell")).toBeInTheDocument();
  });

  it("renders one chip per distinct agentId, labeled from session.subagents when known", () => {
    sessions = [
      makeSession({
        subagents: [
          {
            agentId: "subagent-test-id-1",
            agentType: "code-reviewer",
            startedAt: Date.now(),
            endedAt: null,
            summary: null,
            fileChanges: 1,
            toolFailures: 0,
            eventCount: 1,
          },
        ],
      }),
    ];
    events = {
      1: [
        makeEvent({
          seq: 1,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify", agentId: "subagent-test-id-1" },
        }),
        makeEvent({ seq: 2 }), // unattributed
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    const group = screen.getByRole("group", { name: "Filter by subagent" });
    expect(screen.getByRole("button", { name: "code-reviewer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unattributed" })).toBeInTheDocument();
    expect(group.querySelectorAll("button")).toHaveLength(2);
  });

  it("falls back to a truncated agentId label when the subagent isn't in session.subagents", () => {
    events = {
      1: [
        makeEvent({
          seq: 1,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify", agentId: "subagent-test-id-2" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);
    expect(
      screen.getByRole("button", { name: "subagent-test-id-2".slice(0, 8) }),
    ).toBeInTheDocument();
  });

  it("filters to only the selected subagent's events on chip click", async () => {
    // Distinct first-8-char prefixes ("alpha-fa"/"beta-fak") so the
    // truncated-label fallback produces two distinguishable button names —
    // real agentIds don't share a prefix like the shorter fixtures elsewhere
    // in this file do.
    events = {
      1: [
        makeEvent({
          seq: 1,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify", agentId: "alpha-fake-subagent-id" },
        }),
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/b.ts", action: "modify", agentId: "beta-fake-subagent-id" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(screen.getByText("Changed src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("Changed src/b.ts")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "alpha-fake-subagent-id".slice(0, 8) }),
    );

    expect(screen.getByText("Changed src/a.ts")).toBeInTheDocument();
    expect(screen.queryByText("Changed src/b.ts")).not.toBeInTheDocument();
  });

  it("degrades a fully-stale agent selection back to showing everything, instead of dead-ending the timeline", async () => {
    // Buffered events are capped (store.ts's EVENTS_PER_SESSION_CAP) — a
    // selected agentId can age out of the buffer entirely while a stale
    // selection for it lingers in component state. Filtering against that
    // stale selection verbatim would leave every event failing the check
    // with no visible chip left to un-click to recover.
    events = {
      1: [
        makeEvent({
          seq: 1,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify", agentId: "alpha-fake-subagent-id" },
        }),
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/b.ts", action: "modify", agentId: "beta-fake-subagent-id" },
        }),
      ],
    };
    const { rerender } = render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.click(
      screen.getByRole("button", { name: "alpha-fake-subagent-id".slice(0, 8) }),
    );
    expect(screen.getByText("Changed src/a.ts")).toBeInTheDocument();
    expect(screen.queryByText("Changed src/b.ts")).not.toBeInTheDocument();

    // Simulate the cap evicting "alpha"'s event out of the buffer entirely —
    // its option (and chip) disappears, but the earlier click left it
    // selected.
    events = {
      1: [
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/b.ts", action: "modify", agentId: "beta-fake-subagent-id" },
        }),
      ],
    };
    rerender(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(screen.queryByRole("button", { name: "alpha-fake-subagent-id".slice(0, 8) })).toBeNull();
    expect(screen.getByText("Changed src/b.ts")).toBeInTheDocument();
  });

  it("selecting an agent chip isolates it — both chips must be selected to see unattributed and a subagent together", async () => {
    events = {
      1: [
        makeEvent({ seq: 1 }), // unattributed (attention/Bell)
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify", agentId: "subagent-test-id-1" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    // Isolate-model filter — see the filter-predicate comment in
    // SessionTimeline.tsx. Combining both chips is how a caller sees
    // everything again.
    await userEvent.click(screen.getByRole("button", { name: "Unattributed" }));
    expect(screen.getByText("Bell")).toBeInTheDocument();
    expect(screen.queryByText("Changed src/a.ts")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "subagent-test-id-1".slice(0, 8) }));
    expect(screen.getByText("Bell")).toBeInTheDocument();
    expect(screen.getByText("Changed src/a.ts")).toBeInTheDocument();
  });

  it("selecting a subagent chip alone hides unattributed events too — isolation, not an allowlist for subagents only", async () => {
    // The central claim of the filter-predicate comment in SessionTimeline.tsx:
    // clicking a subagent's own chip (without ever touching "Unattributed")
    // isolates to that subagent and hides the unattributed event, the same way
    // it would hide any other subagent's events. Distinct from the test above,
    // which clicks "Unattributed" first — this covers the subagent-chip-first
    // order, which is the one order the isolate-model comment describes but
    // nothing previously exercised.
    events = {
      1: [
        makeEvent({ seq: 1 }), // unattributed (attention/Bell)
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify", agentId: "subagent-test-id-1" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.click(screen.getByRole("button", { name: "subagent-test-id-1".slice(0, 8) }));
    expect(screen.queryByText("Bell")).not.toBeInTheDocument();
    expect(screen.getByText("Changed src/a.ts")).toBeInTheDocument();
  });

  it("two parallel subagents of the same type get distinct groups (grouped by agentId, not agentType), with disambiguated labels", () => {
    // Distinct first-8-char prefixes, same rationale as the filter test
    // above — a bare agentType label would otherwise give two functionally
    // distinct chips an identical accessible name.
    sessions = [
      makeSession({
        subagents: [
          {
            agentId: "alpha-fake-subagent-a",
            agentType: "code-reviewer",
            startedAt: Date.now(),
            endedAt: null,
            summary: null,
            fileChanges: 0,
            toolFailures: 0,
            eventCount: 1,
          },
          {
            agentId: "beta-fake-subagent-b",
            agentType: "code-reviewer",
            startedAt: Date.now(),
            endedAt: null,
            summary: null,
            fileChanges: 0,
            toolFailures: 0,
            eventCount: 1,
          },
        ],
      }),
    ];
    events = {
      1: [
        makeEvent({
          seq: 1,
          kind: "file_change",
          payload: { path: "src/a.ts", action: "modify", agentId: "alpha-fake-subagent-a" },
        }),
        makeEvent({
          seq: 2,
          kind: "file_change",
          payload: { path: "src/b.ts", action: "modify", agentId: "beta-fake-subagent-b" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    const group = screen.getByRole("group", { name: "Filter by subagent" });
    const buttons = group.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    // Same base label ("code-reviewer"), but disambiguated with each
    // subagent's own truncated id — no two chips share an accessible name.
    expect(screen.getByRole("button", { name: "code-reviewer (alpha-fa)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "code-reviewer (beta-fak)" })).toBeInTheDocument();
  });
});
