// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionTimeline } from "./SessionTimeline.js";
import type { EventHistoryPage, NotificationEvent, Session, StoredEventRow } from "./api.js";

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Route by URL, unhandled requests reject loudly — same convention as
// SkillsPanel.test.tsx's own mockFetch.
function mockFetch(handler: (url: URL) => EventHistoryPage | Promise<EventHistoryPage>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/events") {
      return Promise.resolve(handler(url)).then(jsonResponse);
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${url.pathname}`));
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

  it("shows a search-scope hint only when more history remains unloaded", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        persistenceEnabled: true,
        events: [makeRow({ id: 1 })],
        nextCursor: 1,
      })),
    );
    render(<SessionTimeline params={{ sessionIds: [1] }} />);

    expect(await screen.findByText(/Search only covers loaded events/)).toBeInTheDocument();
  });
});
