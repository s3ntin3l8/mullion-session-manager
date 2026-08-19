// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionTimeline } from "./SessionTimeline.js";
import type { EventHistoryPage, NotificationEvent, Session } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";

let sessions: Session[];
let events: Record<number, NotificationEvent[]>;

function storeState() {
  return { sessions, events };
}

vi.mock("./store/index.js", () => {
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

// Issue #213 (roadmap 4.7) — SessionTimeline now also fetches persisted
// history (GET /api/events, api.listEventHistory) on mount. Default mock:
// persistence off, no rows — matches the intent of most tests in this file,
// which exercise the LIVE store path and predate this feature. Tests that
// specifically cover the history data source (SessionTimeline.history.test.tsx)
// override this per-test via `fetchImpl`.
let fetchImpl: (url: string) => EventHistoryPage = () => ({
  persistenceEnabled: false,
  events: [],
  nextCursor: null,
});

beforeEach(() => {
  // Making notifications relevant/scannable — activeKinds/onlyAttention now
  // persist to real localStorage (SessionTimeline.tsx's
  // loadPersistedActiveKinds/STORAGE_KEYS.timelineKinds/
  // timelineOnlyAttention), which jsdom does not reset between tests on its
  // own (see persistedState.test.ts's own beforeEach for the established
  // pattern). Without this, one test's toggleKind()/setOnlyAttention() call
  // leaks its filter state into the next test's fresh mount.
  localStorage.clear();
  sessions = [makeSession()];
  events = {};
  fetchImpl = () => ({ persistenceEnabled: false, events: [], nextCursor: null });
  // Route by URL, reject unhandled requests loudly — same convention as
  // SkillsPanel.test.tsx's mockFetch.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/events")) return Promise.resolve(jsonResponse(200, fetchImpl(url)));
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
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
          // Making notifications relevant/scannable — was file_change,
          // which is now hidden by DEFAULT (see DEFAULT_ACTIVE_KINDS); this
          // test isn't about file_change at all, just multi-session merge
          // order, so tool_failure (on by default) is an equally-fine
          // second distinct row.
          kind: "tool_failure",
          payload: { tool: "review-tool", error: "boom" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1, 2] }} />);

    // Scoped to the row TEXT specifically (not the kind pill, which for a
    // bell event also reads "Bell" — see eventDescriptions.ts's
    // SIGNAL_LABELS.bell/describeEvent's own "bell" case, both "Bell").
    const rows = screen.getAllByText(/Bell|Tool failed: review-tool — boom/, {
      selector: ".session-timeline-row-text",
    });
    // Session 1's event has the earlier ts (1000 vs. 2000) despite the
    // higher seq — wall-clock order wins, since seq is only comparable
    // within one session.
    expect(rows[0]).toHaveTextContent("Bell");
    expect(rows[1]).toHaveTextContent("Tool failed: review-tool — boom");
  });

  it("falls back to the pre-6.5 { sessionId } param shape (a workspace layout saved before this PR)", () => {
    // Independent review, PR #477 — dockview restores a persisted layout's
    // panel params verbatim; a timeline panel docked before this PR shipped
    // still carries the old singular `sessionId` field, not `sessionIds`.
    sessions = [makeSession({ id: 1 })];
    events = { 1: [makeEvent({ sessionId: 1, seq: 1 })] };
    render(<SessionTimeline params={{ sessionId: 1 }} />);
    // Making notifications relevant/scannable — scoped to the row text: a
    // bell event's kind pill ALSO reads "Bell" (SIGNAL_LABELS.bell), so an
    // unscoped query matches two elements.
    expect(
      screen.getByText("Bell", { selector: ".session-timeline-row-text" }),
    ).toBeInTheDocument();
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

  it("shows an empty state when the session has no events", async () => {
    render(<SessionTimeline params={{ sessionIds: [1] }} />);
    // async: the history fetch's own "loading" state renders first (see
    // SessionTimeline.tsx's `anyLoading`), settling to "No events yet."
    // only once the mocked GET /api/events response resolves.
    expect(await screen.findByText("No events yet.")).toBeInTheDocument();
  });

  it("renders one row per describable event, oldest first (store order)", () => {
    events = {
      1: [
        makeEvent({ seq: 1, ts: 1000 }),
        makeEvent({
          seq: 2,
          ts: 2000,
          // Making notifications relevant/scannable — was file_change, now
          // hidden by default; swapped for tool_failure (on by default) —
          // this test is about row ORDER, not file_change specifically.
          kind: "tool_failure",
          payload: { tool: "a-tool", error: "boom" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    const rows = screen.getAllByText(/Bell|Tool failed: a-tool — boom/, {
      selector: ".session-timeline-row-text",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Bell");
    expect(rows[1]).toHaveTextContent("Tool failed: a-tool — boom");
  });

  it("drops events describeEvent can't describe (e.g. a bare title_change with no title)", async () => {
    events = {
      1: [makeEvent({ seq: 1, kind: "title_change", payload: {} })],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);
    expect(await screen.findByText("No events yet.")).toBeInTheDocument();
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
    // Making notifications relevant/scannable — file_change is one of the
    // two kinds (with title_change) now hidden by DEFAULT (see
    // DEFAULT_ACTIVE_KINDS): title_change/file_change together were 88% of
    // every event this app has ever persisted, so a fresh timeline no
    // longer opens buried in routine chatter. This is new coverage for
    // that default, layered onto the pre-existing "toggling a chip works"
    // coverage below.
    expect(
      screen.getByText("Bell", { selector: ".session-timeline-row-text" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Changed src/a.ts")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute("aria-pressed", "false");

    // Toggling "Files" ON reveals the file_change row without touching the
    // attention one.
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(
      screen.getByText("Bell", { selector: ".session-timeline-row-text" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Changed src/a.ts")).toBeInTheDocument();

    // Toggling it back OFF hides it again.
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(
      screen.getByText("Bell", { selector: ".session-timeline-row-text" }),
    ).toBeInTheDocument();
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
          // Making notifications relevant/scannable — was file_change, now
          // hidden by default; swapped for tool_failure (on by default) —
          // this test is about search matching, not file_change.
          kind: "tool_failure",
          payload: { tool: "Widget", error: "boom" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.type(screen.getByLabelText("Search timeline"), "widget");

    expect(screen.queryByText("Bell")).not.toBeInTheDocument();
    expect(screen.getByText("Tool failed: Widget — boom")).toBeInTheDocument();
  });

  it("search and kind filters combine (both must match)", async () => {
    events = {
      1: [
        makeEvent({ seq: 1 }),
        makeEvent({
          seq: 2,
          // Making notifications relevant/scannable — was file_change, now
          // hidden by default; swapped for tool_failure (on by default),
          // keeping "bell" in the substring so both rows still match the
          // search term, same as the original fixture intended.
          kind: "tool_failure",
          payload: { tool: "bell-widget", error: "boom" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.type(screen.getByLabelText("Search timeline"), "bell");
    // Both rows match the text search ("Bell" and "...bell-widget..."), but
    // untoggling "Attention" should still remove only that one.
    await userEvent.click(screen.getByRole("button", { name: "Attention" }));

    expect(screen.queryByText("Bell")).not.toBeInTheDocument();
    expect(screen.getByText("Tool failed: bell-widget — boom")).toBeInTheDocument();
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
    // Making notifications relevant/scannable — scoped to the row text: a
    // bell event's kind pill also reads "Bell".
    expect(
      screen.getByText("Bell", { selector: ".session-timeline-row-text" }),
    ).toBeInTheDocument();
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
    // in this file do. Making notifications relevant/scannable — kind
    // swapped from file_change (now hidden by default) to tool_failure (on
    // by default); this test is about subagent-chip filtering, not
    // file_change specifically.
    events = {
      1: [
        makeEvent({
          seq: 1,
          kind: "tool_failure",
          payload: { tool: "toolA", error: "err-a", agentId: "alpha-fake-subagent-id" },
        }),
        makeEvent({
          seq: 2,
          kind: "tool_failure",
          payload: { tool: "toolB", error: "err-b", agentId: "beta-fake-subagent-id" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(screen.getByText("Tool failed: toolA — err-a")).toBeInTheDocument();
    expect(screen.getByText("Tool failed: toolB — err-b")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "alpha-fake-subagent-id".slice(0, 8) }),
    );

    expect(screen.getByText("Tool failed: toolA — err-a")).toBeInTheDocument();
    expect(screen.queryByText("Tool failed: toolB — err-b")).not.toBeInTheDocument();
  });

  it("degrades a fully-stale agent selection back to showing everything, instead of dead-ending the timeline", async () => {
    // Buffered events are capped (store.ts's EVENTS_PER_SESSION_CAP) — a
    // selected agentId can age out of the buffer entirely while a stale
    // selection for it lingers in component state. Filtering against that
    // stale selection verbatim would leave every event failing the check
    // with no visible chip left to un-click to recover. Making
    // notifications relevant/scannable — kind swapped from file_change to
    // tool_failure, same reasoning as the test above.
    events = {
      1: [
        makeEvent({
          seq: 1,
          kind: "tool_failure",
          payload: { tool: "toolA", error: "err-a", agentId: "alpha-fake-subagent-id" },
        }),
        makeEvent({
          seq: 2,
          kind: "tool_failure",
          payload: { tool: "toolB", error: "err-b", agentId: "beta-fake-subagent-id" },
        }),
      ],
    };
    const { rerender } = render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.click(
      screen.getByRole("button", { name: "alpha-fake-subagent-id".slice(0, 8) }),
    );
    expect(screen.getByText("Tool failed: toolA — err-a")).toBeInTheDocument();
    expect(screen.queryByText("Tool failed: toolB — err-b")).not.toBeInTheDocument();

    // Simulate the cap evicting "alpha"'s event out of the buffer entirely —
    // its option (and chip) disappears, but the earlier click left it
    // selected.
    events = {
      1: [
        makeEvent({
          seq: 2,
          kind: "tool_failure",
          payload: { tool: "toolB", error: "err-b", agentId: "beta-fake-subagent-id" },
        }),
      ],
    };
    rerender(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(screen.queryByRole("button", { name: "alpha-fake-subagent-id".slice(0, 8) })).toBeNull();
    expect(screen.getByText("Tool failed: toolB — err-b")).toBeInTheDocument();
  });

  it("selecting an agent chip isolates it — both chips must be selected to see unattributed and a subagent together", async () => {
    // Making notifications relevant/scannable — kind swapped from
    // file_change to tool_failure, same reasoning as the tests above.
    events = {
      1: [
        makeEvent({ seq: 1 }), // unattributed (attention/Bell)
        makeEvent({
          seq: 2,
          kind: "tool_failure",
          payload: { tool: "toolA", error: "err-a", agentId: "subagent-test-id-1" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    // Isolate-model filter — see the filter-predicate comment in
    // SessionTimeline.tsx. Combining both chips is how a caller sees
    // everything again.
    await userEvent.click(screen.getByRole("button", { name: "Unattributed" }));
    expect(
      screen.getByText("Bell", { selector: ".session-timeline-row-text" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Tool failed: toolA — err-a")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "subagent-test-id-1".slice(0, 8) }));
    expect(
      screen.getByText("Bell", { selector: ".session-timeline-row-text" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Tool failed: toolA — err-a")).toBeInTheDocument();
  });

  it("selecting a subagent chip alone hides unattributed events too — isolation, not an allowlist for subagents only", async () => {
    // The central claim of the filter-predicate comment in SessionTimeline.tsx:
    // clicking a subagent's own chip (without ever touching "Unattributed")
    // isolates to that subagent and hides the unattributed event, the same way
    // it would hide any other subagent's events. Distinct from the test above,
    // which clicks "Unattributed" first — this covers the subagent-chip-first
    // order, which is the one order the isolate-model comment describes but
    // nothing previously exercised. Making notifications relevant/scannable
    // — kind swapped from file_change to tool_failure, same reasoning as
    // the tests above.
    events = {
      1: [
        makeEvent({ seq: 1 }), // unattributed (attention/Bell)
        makeEvent({
          seq: 2,
          kind: "tool_failure",
          payload: { tool: "toolA", error: "err-a", agentId: "subagent-test-id-1" },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.click(screen.getByRole("button", { name: "subagent-test-id-1".slice(0, 8) }));
    expect(screen.queryByText("Bell")).not.toBeInTheDocument();
    expect(screen.getByText("Tool failed: toolA — err-a")).toBeInTheDocument();
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

// Making notifications relevant/scannable.
describe("SessionTimeline severity/pairing/persistence", () => {
  it("suppressPairedAttentionRows: a permission_request row and its paired attention/permissionRequest row for the same occurrence collapse to ONE row (the specific-kind one)", () => {
    events = {
      1: [
        makeEvent({
          seq: 1,
          ts: 1000,
          kind: "permission_request",
          payload: { tool: "Bash", summary: "rm -rf /tmp/x" },
        }),
        makeEvent({
          seq: 2,
          ts: 1200, // well within PAIRED_ROW_WINDOW_MS (5000ms) of seq 1
          kind: "attention",
          payload: {
            attention: true,
            signal: "permissionRequest",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    // Both events describe to the same text ("Needs permission: rm -rf
    // /tmp/x") — without suppression this would render twice.
    const rows = screen.getAllByText("Needs permission: rm -rf /tmp/x", {
      selector: ".session-timeline-row-text",
    });
    expect(rows).toHaveLength(1);
    // The SURVIVING row is the specific-kind one, not the generic
    // attention one — same "the specific kind carries more information"
    // reasoning as eventDescriptions.ts's SIGNAL_TO_EVENT_KIND doc comment.
    // The kind class lives on the row's own pill span, not the outer row
    // div (which carries `sev-${severity}` instead).
    const row = rows[0].closest(".session-timeline-row");
    expect(row?.querySelector(".session-timeline-row-kind")).toHaveClass("kind-permission_request");
  });

  it("suppressPairedAttentionRows does NOT collapse a permission_request and an unrelated attention event outside the pairing window", () => {
    events = {
      1: [
        makeEvent({
          seq: 1,
          ts: 1000,
          kind: "permission_request",
          payload: { tool: "Bash", summary: "rm -rf /tmp/x" },
        }),
        makeEvent({
          seq: 2,
          ts: 1000 + 5001, // just outside PAIRED_ROW_WINDOW_MS
          kind: "attention",
          payload: {
            attention: true,
            signal: "permissionRequest",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(
      screen.getAllByText("Needs permission: rm -rf /tmp/x", {
        selector: ".session-timeline-row-text",
      }),
    ).toHaveLength(2);
  });

  it("'Only attention' narrows to notify-worthy rows, layered on top of (not replacing) the kind-chip selection", async () => {
    events = {
      1: [
        // Blocked severity — survives the "Only attention" filter.
        makeEvent({
          seq: 1,
          kind: "attention",
          payload: { attention: true, signal: "permissionRequest", tool: "Bash", summary: "x" },
        }),
        // A review_gate kind is on-by-default but "approved" isn't
        // notify-worthy at all (notifyKind only counts "waiting") — a
        // routine row that should disappear under the toggle.
        makeEvent({ seq: 2, kind: "review_gate", payload: { state: "approved", prompt: "x" } }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(screen.getByText("Needs permission: x")).toBeInTheDocument();
    expect(screen.getByText("Review approved")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Only attention" }));
    expect(screen.getByText("Needs permission: x")).toBeInTheDocument();
    expect(screen.queryByText("Review approved")).not.toBeInTheDocument();

    // Toggling back off restores the underlying kind-chip selection (which
    // was never touched — "Review" was never unchecked), not a hard reset.
    await userEvent.click(screen.getByRole("button", { name: "Only attention" }));
    expect(screen.getByText("Review approved")).toBeInTheDocument();
  });

  // Fresh code-review finding on PR #717 — the test above only exercises a
  // BARE attention/permissionRequest event with no paired permission_request
  // sibling, a state production never actually produces (the backend always
  // emits both — see attention-tracker.ts's drainDeferred). In the REAL
  // shape, suppressPairedAttentionRows (this file) drops the `attention` row
  // and keeps the specific-kind `permission_request` row, which notifySeverity
  // (eventDescriptions.ts) previously didn't recognize on its own — making
  // "Only attention" hide the exact rows it exists to surface, and the
  // severity stripe never render on a genuinely blocked row.
  it("'Only attention' keeps a paired permission_request row visible, with the correct severity stripe, even though its `attention` sibling gets suppressed", async () => {
    events = {
      1: [
        makeEvent({
          seq: 1,
          kind: "permission_request",
          payload: { tool: "Bash", summary: "rm -rf /tmp/x" },
        }),
        makeEvent({
          seq: 2,
          kind: "attention",
          payload: {
            attention: true,
            signal: "permissionRequest",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          },
        }),
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    // Paired suppression: only the specific-kind row survives.
    expect(screen.getByText("Needs permission: rm -rf /tmp/x")).toBeInTheDocument();
    const kindPill = document.querySelector(".session-timeline-row-kind.kind-permission_request");
    expect(kindPill).not.toBeNull();
    const row = kindPill?.closest(".session-timeline-row");
    expect(row).toHaveClass("sev-blocked");

    await userEvent.click(screen.getByRole("button", { name: "Only attention" }));
    expect(screen.getByText("Needs permission: rm -rf /tmp/x")).toBeInTheDocument();
  });

  it("activeKinds and 'Only attention' persist across a remount of the same panel", async () => {
    events = { 1: [makeEvent({ seq: 1 })] };
    const first = render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Only attention" }));
    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Only attention" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    first.unmount();
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Only attention" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
