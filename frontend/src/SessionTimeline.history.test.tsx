// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionTimeline } from "./SessionTimeline.js";
import type { EventHistoryPage, NotificationEvent, Session, StoredEventRow } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";

// Issue #213 (roadmap 4.7) — covers the persisted-history data source added
// to SessionTimeline.tsx: fetching GET /api/events, merging with the live
// store, the nullable sessionId/payload/unknown-kind adapter fixes
// (eventHistory.ts), the persistence-off state, and cursor paging.
// SessionTimeline.test.tsx (pre-existing) covers everything about the live
// store path and stays store-only; this file is fetch-only.

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

function makeRow(overrides: Partial<StoredEventRow> = {}): StoredEventRow {
  return {
    id: 1,
    sessionId: 1,
    seq: 1,
    kind: "attention",
    ts: 1000,
    payload: { attention: true, signal: "bell" },
    ...overrides,
  };
}

// Route by URL, unhandled requests reject loudly — same convention as
// SkillsPanel.test.tsx's own mockFetch.
function mockFetch(handler: (url: URL) => EventHistoryPage | Promise<EventHistoryPage>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/events") {
      return Promise.resolve(handler(url)).then((page) => jsonResponse(200, page));
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${url.pathname}`));
  });
}

function errorResponse(): Response {
  return new Response(JSON.stringify({ message: "boom" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  sessions = [makeSession()];
  events = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionTimeline persisted history (issue #213, roadmap 4.7)", () => {
  it("renders a persisted-history row alongside a live store event", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        persistenceEnabled: true,
        events: [makeRow({ id: 1, seq: 1, ts: 1000, kind: "attention" })],
        nextCursor: null,
      })),
    );
    events = { 1: [{ seq: 2, sessionId: 1, kind: "session_end", ts: 2000, payload: {} }] };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(await screen.findByText("Bell")).toBeInTheDocument();
    expect(screen.getByText("Session ended")).toBeInTheDocument();
  });

  it("history and a live copy of the same event dedupe to one row", async () => {
    // Same (sessionId, seq, ts, kind) in both sources — the debounced-write
    // overlap window (src/services/event-store.ts). Must render once, not
    // twice.
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        persistenceEnabled: true,
        events: [makeRow({ id: 5, seq: 1, ts: 1000, kind: "attention" })],
        nextCursor: null,
      })),
    );
    events = { 1: [{ seq: 1, sessionId: 1, kind: "attention", ts: 1000, payload: {} }] };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(await screen.findAllByText("Bell")).toHaveLength(1);
  });

  it("a seq collision across a backend restart renders both events, not one", async () => {
    // Session.eventSeq (pty-manager.ts) is in-memory only and resets to 1
    // after a restart for a surviving dtach session — so (sessionId, seq)
    // alone is not a safe dedupe key. Same seq, different ts/kind: both
    // must survive the merge.
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        persistenceEnabled: true,
        events: [
          makeRow({ id: 1, seq: 1, ts: 1000, kind: "attention" }),
          makeRow({
            id: 2,
            seq: 1,
            ts: 5000,
            kind: "session_end",
            payload: {},
          }),
        ],
        nextCursor: null,
      })),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(await screen.findByText("Bell")).toBeInTheDocument();
    expect(screen.getByText("Session ended")).toBeInTheDocument();
  });

  it("does not throw on a null payload and renders the row", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        persistenceEnabled: true,
        events: [makeRow({ id: 1, kind: "session_end", payload: null })],
        nextCursor: null,
      })),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(await screen.findByText("Session ended")).toBeInTheDocument();
  });

  it("drops a row whose kind is unrecognized instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        persistenceEnabled: true,
        events: [makeRow({ id: 1, kind: "some_future_kind_v2" })],
        nextCursor: null,
      })),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(await screen.findByText("No events yet.")).toBeInTheDocument();
  });

  it("renders an orphaned row (sessionId: null) with a session-removed marker", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        persistenceEnabled: true,
        events: [makeRow({ id: 1, sessionId: null, kind: "attention" })],
        nextCursor: null,
      })),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(await screen.findByText("Bell")).toBeInTheDocument();
    expect(screen.getByText("(session removed)")).toBeInTheDocument();
  });

  it("shows a distinct hint when history persistence is off", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ persistenceEnabled: false, events: [], nextCursor: null })),
    );
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "attention",
          ts: 1000,
          payload: { attention: true, signal: "bell" },
        },
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(await screen.findByText(/History persistence is off/)).toBeInTheDocument();
    // The live event still renders — persistence being off only affects
    // durability across a restart, not the live ring buffer (roadmap.md's
    // own "continues to operate independently" guarantee).
    expect(screen.getByText("Bell")).toBeInTheDocument();
  });

  it("does not show the persistence-off hint while still loading", () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => new Promise<EventHistoryPage>(() => {})),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(screen.queryByText(/History persistence is off/)).not.toBeInTheDocument();
  });

  it("'Load older events' issues a cursored request and prepends the result", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        const cursor = url.searchParams.get("cursor");
        if (cursor === null) {
          return {
            persistenceEnabled: true,
            events: [makeRow({ id: 10, seq: 2, ts: 2000, kind: "attention" })],
            nextCursor: 10,
          };
        }
        expect(cursor).toBe("10");
        return {
          persistenceEnabled: true,
          events: [makeRow({ id: 1, seq: 1, ts: 1000, kind: "session_end", payload: {} })],
          nextCursor: null,
        };
      }),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(await screen.findByText("Bell")).toBeInTheDocument();
    const loadOlder = screen.getByRole("button", { name: "Load older events" });

    await userEvent.click(loadOlder);

    await waitFor(() => expect(screen.getByText("Session ended")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Load older events" })).not.toBeInTheDocument();
  });

  it("shows a search-scope hint once the user has typed a query, but only when more history remains unloaded", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        persistenceEnabled: true,
        events: [makeRow({ id: 1 })],
        nextCursor: 1,
      })),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);
    await screen.findByText("Bell");

    // Hermes review, PR #560 — the hint is gated on a non-empty search box:
    // it has nothing to say about an empty one.
    expect(screen.queryByText(/Search only covers loaded events/)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Search timeline"), "bell");

    expect(await screen.findByText(/Search only covers loaded events/)).toBeInTheDocument();
  });

  // Hermes review, PR #560 — the four cases below cover the two robustness
  // gaps the review flagged (a failed initial fetch was indistinguishable
  // from "empty"; a failed "Load older" click failed silently) plus the two
  // suggestions (search hint gating, already covered above; the orphan
  // marker's real trigger).

  it("shows an error banner with a retry button when the initial history fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(errorResponse())),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load history for this session.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows the error banner even when live events already fill the list (round 2 of Hermes review)", async () => {
    // The bug the first fix missed: folding the error text into the
    // empty-state ternary meant it never rendered once `filtered.length >
    // 0` — a live event alone was enough to hide a failed history fetch
    // entirely.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(errorResponse())),
    );
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "attention",
          ts: 1000,
          payload: { attention: true, signal: "bell" },
        },
      ],
    };
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(screen.getByText("Bell")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load history for this session.",
    );
  });

  it("clicking Retry re-fetches and clears the error banner on success", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname !== "/api/events") {
          return Promise.reject(new Error(`unhandled fetch in test: ${url.pathname}`));
        }
        calls += 1;
        if (calls === 1) return Promise.resolve(errorResponse());
        return Promise.resolve(
          jsonResponse(200, {
            persistenceEnabled: true,
            events: [makeRow({ id: 1 })],
            nextCursor: null,
          } satisfies EventHistoryPage),
        );
      }),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Bell")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a failed 'Load older events' click shows an inline error, not a silent no-op", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname !== "/api/events") {
          return Promise.reject(new Error(`unhandled fetch in test: ${url.pathname}`));
        }
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            jsonResponse(200, {
              persistenceEnabled: true,
              events: [makeRow({ id: 1 })],
              nextCursor: 1,
            } satisfies EventHistoryPage),
          );
        }
        return Promise.resolve(errorResponse());
      }),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    const loadOlder = await screen.findByRole("button", { name: "Load older events" });
    await userEvent.click(loadOlder);

    expect(await screen.findByText("Couldn't load older events. Try again.")).toBeInTheDocument();
    // The button survives the failure so the user can retry — it doesn't
    // vanish or get stuck disabled.
    expect(screen.getByRole("button", { name: "Load older events" })).toBeEnabled();
  });

  it("two rapid 'Load older events' clicks issue only one request (in-flight guard)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        const cursor = url.searchParams.get("cursor");
        if (cursor === null) {
          return {
            persistenceEnabled: true,
            events: [makeRow({ id: 10, seq: 2, ts: 2000 })],
            nextCursor: 10,
          };
        }
        calls += 1;
        return {
          persistenceEnabled: true,
          events: [makeRow({ id: 1, seq: 1, ts: 1000, kind: "session_end", payload: {} })],
          nextCursor: null,
        };
      }),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    const loadOlder = await screen.findByRole("button", { name: "Load older events" });
    // Two synchronous clicks, no await between them — before React commits
    // `disabled`, only the in-flight ref can prevent a second request.
    await Promise.all([userEvent.click(loadOlder), userEvent.click(loadOlder)]);

    await waitFor(() => expect(screen.getByText("Session ended")).toBeInTheDocument());
    expect(calls).toBe(1);
  });

  it("marks an event's row as orphaned when its session is missing from the store, even though sessionId is non-null", async () => {
    // The reachable case Hermes flagged: a per-session history fetch is
    // always scoped by an explicit sessionId filter (eq(...)), which SQL
    // never matches against a NULL column — so a row belonging to a
    // genuinely deleted session (onDelete: "set null") can never come back
    // through this query surface at all. What CAN happen: a multi-session
    // panel (worker + review agent) where one session is still live and the
    // other has dropped out of the store (e.g. removed) while its
    // already-fetched history rows remain in memory.
    sessions = [makeSession({ id: 1 })];
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        const sessionId = url.searchParams.get("sessionId");
        return {
          persistenceEnabled: true,
          events: sessionId === "2" ? [makeRow({ id: 1, sessionId: 2 })] : [],
          nextCursor: null,
        };
      }),
    );
    render(<SessionTimeline params={{ sessionIds: [1, 2] }} />);

    expect(await screen.findByText("Bell")).toBeInTheDocument();
    expect(screen.getByText("(session removed)")).toBeInTheDocument();
  });
});
