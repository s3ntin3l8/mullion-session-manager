// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eventKey, useDashboardStore } from "./store/index.js";
import type { NotificationEvent } from "./api/index.js";

// Phase 1's notification event model (issue #166) — store.ts's `events`
// slice + startEventsStream()/markEventSeen(), driven against a mocked
// global WebSocket. Mirrors store.gitStatus.test.ts's own convention: mock
// the platform API (fetch there, WebSocket here) rather than mocking
// eventsClient.ts itself, so this exercises the real dedupe/cap/reconnect
// logic end to end.

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = MockWebSocket.CONNECTING;
  readonly OPEN = MockWebSocket.OPEN;
  readonly CLOSING = MockWebSocket.CLOSING;
  readonly CLOSED = MockWebSocket.CLOSED;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  private listeners: Record<string, Array<(event: { data?: unknown }) => void>> = {};

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data?: unknown }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch("close", {});
  }

  // Test-only helpers, not part of the real WebSocket API.
  __open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch("open", {});
  }

  __message(data: unknown) {
    this.dispatch("message", { data });
  }

  private dispatch(type: string, event: { data?: unknown }) {
    for (const cb of this.listeners[type] ?? []) cb(event);
  }
}

let instances: MockWebSocket[] = [];

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 5,
    kind: "attention",
    ts: 1000,
    payload: { attention: true },
    ...overrides,
  };
}

describe("store /ws/events integration (issue #166)", () => {
  beforeEach(() => {
    instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    useDashboardStore.setState({ events: {}, lastSeenSeq: {}, dismissedEventKeys: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("connects exactly one WebSocket on startEventsStream() and appends a live event to the right session", () => {
    const stop = useDashboardStore.getState().startEventsStream();
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toMatch(/\/ws\/events$/);

    instances[0].__open();
    instances[0].__message(JSON.stringify(event()));

    expect(useDashboardStore.getState().events[5]).toEqual([event()]);

    stop();
  });

  it("dedupes a duplicate (sessionId, seq) delivery — e.g. a reconnect replaying an event the store already has", () => {
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(JSON.stringify(event({ seq: 1 })));
    instances[0].__message(JSON.stringify(event({ seq: 1 }))); // duplicate delivery

    expect(useDashboardStore.getState().events[5]).toHaveLength(1);

    stop();
  });

  it("keeps events from different sessions independently, each with its own seq space", () => {
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(JSON.stringify(event({ sessionId: 1, seq: 1 })));
    instances[0].__message(JSON.stringify(event({ sessionId: 2, seq: 1 })));

    expect(useDashboardStore.getState().events[1]).toHaveLength(1);
    expect(useDashboardStore.getState().events[2]).toHaveLength(1);

    stop();
  });

  it("ignores a malformed frame without throwing or storing anything", () => {
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    expect(() => instances[0].__message("not json")).not.toThrow();
    expect(() => instances[0].__message(JSON.stringify({ not: "an event" }))).not.toThrow();

    expect(useDashboardStore.getState().events).toEqual({});

    stop();
  });

  it("reconnects with capped exponential backoff after the socket closes", () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startEventsStream();
    expect(instances).toHaveLength(1);

    instances[0].__open();
    instances[0].close(); // simulate a drop, not an explicit stop()

    // First reconnect fires at 500ms.
    vi.advanceTimersByTime(499);
    expect(instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(instances).toHaveLength(2);

    stop();
  });

  it("does not reconnect after the caller's own cleanup function is called", () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    stop();
    // stop() itself closes the socket, which normally would schedule a
    // reconnect — the "destroyed" guard in eventsClient.ts must suppress
    // that once the caller has explicitly torn this down.
    vi.advanceTimersByTime(10_000);

    expect(instances).toHaveLength(1);
  });

  it("markEventSeen sends a 'seen' message while connected, and is a no-op while not", () => {
    const stop = useDashboardStore.getState().startEventsStream();

    // Not yet OPEN — must not throw or queue anything unexpected.
    useDashboardStore.getState().markEventSeen(5, 3);
    expect(instances[0].sent).toHaveLength(0);

    instances[0].__open();
    useDashboardStore.getState().markEventSeen(5, 3);
    expect(instances[0].sent).toEqual([JSON.stringify({ type: "seen", sessionId: 5, seq: 3 })]);

    stop();
    // After cleanup, the handle is cleared — a stray call must not throw.
    expect(() => useDashboardStore.getState().markEventSeen(5, 4)).not.toThrow();
  });

  it("markEventSeen advances the local lastSeenSeq cursor, monotonically per session", () => {
    useDashboardStore.getState().markEventSeen(5, 3);
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(3);

    // A lower/equal seq than what's already recorded must not regress the
    // cursor — mirrors the server's own monotonic-only lastSeenSeq.
    useDashboardStore.getState().markEventSeen(5, 2);
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(3);

    useDashboardStore.getState().markEventSeen(5, 7);
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(7);

    // Independent per session, like `events` itself.
    useDashboardStore.getState().markEventSeen(9, 1);
    expect(useDashboardStore.getState().lastSeenSeq).toEqual({ 5: 7, 9: 1 });
  });

  it("caps each session's accumulated event list, evicting the oldest first", () => {
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    // Cap is 200 (EVENTS_PER_SESSION_CAP) — push comfortably past it.
    for (let seq = 1; seq <= 210; seq++) {
      instances[0].__message(JSON.stringify(event({ seq })));
    }

    const stored = useDashboardStore.getState().events[5];
    expect(stored).toHaveLength(200);
    expect(stored[0].seq).toBe(11); // oldest 10 evicted
    expect(stored[stored.length - 1].seq).toBe(210);

    stop();
  });
});

// Issue #1427 — the server-owned read cursor's two wire frames, driven
// through the same mocked WebSocket as the block above.
describe("cursors/seen frames (issue #1427)", () => {
  beforeEach(() => {
    instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    useDashboardStore.setState({ events: {}, lastSeenSeq: {}, dismissedEventKeys: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normal reconnect: takes the higher of local and the server's cursor", () => {
    useDashboardStore.setState({ lastSeenSeq: { 5: 3 } });
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(
      JSON.stringify({
        type: "cursors",
        bootId: "boot-1",
        cursors: { "5": { seen: 7, head: 20 } },
      }),
    );

    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(7);
    stop();
  });

  it("first-ever cursors frame this page load: local above the server's head falls back to the numeric restart heuristic", () => {
    useDashboardStore.setState({ lastSeenSeq: { 5: 50 } });
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    // The server has only ever emitted up to seq 10 in this process's
    // lifetime — a local cursor of 50 can only mean the server restarted.
    // This is the very first cursors frame this store has ever seen, so
    // there's no prior bootId to compare against — mergeServerCursor's own
    // numeric heuristic is what catches this case.
    instances[0].__message(
      JSON.stringify({
        type: "cursors",
        bootId: "boot-1",
        cursors: { "5": { seen: 2, head: 10 } },
      }),
    );

    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(2);
    stop();
  });

  it("leaves a session absent from the cursors frame untouched", () => {
    useDashboardStore.setState({ lastSeenSeq: { 9: 40 } });
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(
      JSON.stringify({ type: "cursors", bootId: "boot-1", cursors: { "5": { seen: 1, head: 1 } } }),
    );

    expect(useDashboardStore.getState().lastSeenSeq[9]).toBe(40);
    stop();
  });

  it("confirmed restart (changed bootId): adopts the server's cursor even once its new head has caught up past the old local value", () => {
    // The scenario the numeric-only heuristic alone can't catch: a fully-
    // read local cursor of 5, then the backend restarts and re-emits 10
    // brand-new events before this tab reconnects. local(5) is NOT above
    // the new head(10), so mergeServerCursor's own check would wrongly
    // take max(5, 0) = 5, treating those 10 new events as already read.
    // The changed bootId removes the ambiguity outright.
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();
    instances[0].__message(
      JSON.stringify({ type: "cursors", bootId: "boot-1", cursors: { "5": { seen: 5, head: 5 } } }),
    );
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(5);

    instances[0].__message(
      JSON.stringify({
        type: "cursors",
        bootId: "boot-2",
        cursors: { "5": { seen: 0, head: 10 } },
      }),
    );
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(0);

    stop();
  });

  it("same bootId across two cursors frames uses the normal (non-adopting) merge", () => {
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();
    instances[0].__message(
      JSON.stringify({ type: "cursors", bootId: "boot-1", cursors: { "5": { seen: 5, head: 5 } } }),
    );
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(5);

    // A second frame from the SAME process incarnation reporting a LOWER
    // seen value must not regress the cursor — this is the ordinary merge
    // path, not a forced adopt.
    instances[0].__message(
      JSON.stringify({ type: "cursors", bootId: "boot-1", cursors: { "5": { seen: 2, head: 8 } } }),
    );
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(5);

    stop();
  });

  it("a live 'seen' broadcast from another client advances the cursor without re-sending 'seen'", () => {
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(JSON.stringify({ type: "seen", sessionId: 5, seq: 9 }));

    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(9);
    // Applying an incoming broadcast must not itself echo a "seen" back —
    // that would be a pointless (and potentially loopy) round trip.
    expect(instances[0].sent).toHaveLength(0);
    stop();
  });

  it("a live 'seen' broadcast is monotonic-only, same as a local markEventSeen", () => {
    useDashboardStore.setState({ lastSeenSeq: { 5: 9 } });
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(JSON.stringify({ type: "seen", sessionId: 5, seq: 3 }));

    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(9);
    stop();
  });

  // Issue #1459 — a multi-host cursors frame carries its own `hostId`, and
  // each host's boot generation must be tracked independently (the module's
  // knownBootIds map, keyed by `hostId ?? "local"`) rather than colliding on
  // one shared bootId the way a pre-#1459 single `knownBootId` variable
  // would have.
  it("a remote host's cursors frame with a DIFFERENT bootId than one previously seen for that SAME hostId triggers adopt for that host only", () => {
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    // Local session 5 and remote-host-A's session 100 both start out fully
    // read locally.
    useDashboardStore.setState({ lastSeenSeq: { 5: 5, 100: 20 } });

    instances[0].__message(
      JSON.stringify({
        type: "cursors",
        hostId: "remote-a",
        bootId: "remote-a-boot-1",
        cursors: { "100": { seen: 20, head: 20 } },
      }),
    );
    expect(useDashboardStore.getState().lastSeenSeq[100]).toBe(20);

    // remote-a restarts and re-emits new events before the next frame —
    // a changed bootId for the SAME hostId ("remote-a") must adopt the
    // server's cursor outright, exactly like a local restart would.
    instances[0].__message(
      JSON.stringify({
        type: "cursors",
        hostId: "remote-a",
        bootId: "remote-a-boot-2",
        cursors: { "100": { seen: 0, head: 30 } },
      }),
    );
    expect(useDashboardStore.getState().lastSeenSeq[100]).toBe(0);

    // The LOCAL session (no hostId, tracked under "local") is completely
    // untouched by remote-a's own restart — a different hostKey entirely.
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(5);

    stop();
  });

  it("a cursors frame for a NEW hostId never seen before is a fresh boot for that host, not a restart", () => {
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();
    useDashboardStore.setState({ lastSeenSeq: { 200: 999 } });

    // The very first frame this tab has ever seen for "remote-b" — even
    // though a local cursors frame (hostId undefined) may already have been
    // observed, "remote-b" is a distinct, never-before-seen hostKey, so this
    // must use the normal merge (Math.max), not force-adopt.
    instances[0].__message(
      JSON.stringify({
        type: "cursors",
        hostId: "remote-b",
        bootId: "remote-b-boot-1",
        cursors: { "200": { seen: 5, head: 999 } },
      }),
    );

    // local(999) is not above server.head(999), so the normal merge takes
    // Math.max(999, 5) = 999 — proving this went through mergeCursorsFrame,
    // not adoptServerCursors (which would have unconditionally set it to 5).
    expect(useDashboardStore.getState().lastSeenSeq[200]).toBe(999);

    stop();
  });

  it("a local (no hostId) cursors frame and a remote host's cursors frame track independent boot generations", () => {
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(
      JSON.stringify({
        type: "cursors",
        bootId: "local-boot-1",
        cursors: { "1": { seen: 1, head: 1 } },
      }),
    );
    instances[0].__message(
      JSON.stringify({
        type: "cursors",
        hostId: "remote-c",
        bootId: "remote-c-boot-1",
        cursors: { "2": { seen: 2, head: 2 } },
      }),
    );

    // Same bootId again for the LOCAL key — ordinary merge, not a restart.
    useDashboardStore.setState({ lastSeenSeq: { 1: 1, 2: 2 } });
    instances[0].__message(
      JSON.stringify({
        type: "cursors",
        bootId: "local-boot-1",
        cursors: { "1": { seen: 0, head: 5 } },
      }),
    );
    expect(useDashboardStore.getState().lastSeenSeq[1]).toBe(1); // unchanged: merge, not adopt.

    // A genuinely changed bootId for remote-c alone forces an adopt for
    // session 2 only — session 1 (local) stays exactly as it was.
    instances[0].__message(
      JSON.stringify({
        type: "cursors",
        hostId: "remote-c",
        bootId: "remote-c-boot-2",
        cursors: { "2": { seen: 0, head: 9 } },
      }),
    );
    expect(useDashboardStore.getState().lastSeenSeq[2]).toBe(0); // adopted.
    expect(useDashboardStore.getState().lastSeenSeq[1]).toBe(1); // still untouched.

    stop();
  });
});

// Issue #1429 — the one shared "mark this session as fully read" primitive
// every explicit-open call site now uses (NotificationBell's rows/mark-all,
// the push/deep-link/requestOpenSession session openers), replacing each
// site's own duplicated `.reduce(Math.max...)`.
describe("markSessionRead (issue #1429)", () => {
  beforeEach(() => {
    useDashboardStore.setState({ events: {}, lastSeenSeq: {} });
  });

  it("advances lastSeenSeq to the session's own highest buffered seq", () => {
    // Seeded already seq-ascending, same invariant addEvent (store/
    // helpers.ts) actually maintains in production — markSessionRead reads
    // the LAST entry, not a max-scan, relying on that ordering.
    useDashboardStore.setState({
      events: { 5: [event({ seq: 1 }), event({ seq: 2 }), event({ seq: 3 })] },
    });
    useDashboardStore.getState().markSessionRead(5);
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(3);
  });

  it("is a no-op when the session has no buffered events", () => {
    expect(() => useDashboardStore.getState().markSessionRead(404)).not.toThrow();
    expect(useDashboardStore.getState().lastSeenSeq[404]).toBeUndefined();
  });

  it("never regresses the cursor, same monotonic guarantee as markEventSeen", () => {
    useDashboardStore.getState().markEventSeen(5, 10);
    useDashboardStore.setState({ events: { 5: [event({ seq: 3 })] } });
    useDashboardStore.getState().markSessionRead(5);
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBe(10);
  });
});

// Issue #1429 — store/slices/ui.ts's requestOpenSession, the store-level
// "intent" useAttentionNotifications.ts's in-app Notification onclick uses
// since it has no direct access to onOpenSession (resolved by
// hooks/useOpenSessionRequest.ts, App.tsx).
describe("requestOpenSession (issue #1429)", () => {
  beforeEach(() => {
    useDashboardStore.setState({ openSessionRequest: null });
  });

  it("sets openSessionRequest with the given sessionId and an incrementing nonce", () => {
    useDashboardStore.getState().requestOpenSession(7);
    expect(useDashboardStore.getState().openSessionRequest).toEqual({ sessionId: 7, nonce: 1 });

    // A SECOND request — even for the same session — bumps the nonce, so a
    // resolver that already handled nonce 1 can tell this one apart.
    useDashboardStore.getState().requestOpenSession(7);
    expect(useDashboardStore.getState().openSessionRequest).toEqual({ sessionId: 7, nonce: 2 });

    useDashboardStore.getState().requestOpenSession(9);
    expect(useDashboardStore.getState().openSessionRequest).toEqual({ sessionId: 9, nonce: 3 });
  });
});

// Hermes review, PR #1456 — cosmetic cleanup once a request resolves
// (hooks/useOpenSessionRequest.ts), nonce-guarded so it can't wipe out a
// newer request that arrived after the one being cleared.
describe("clearOpenSessionRequest (issue #1429)", () => {
  beforeEach(() => {
    useDashboardStore.setState({ openSessionRequest: null });
  });

  it("clears the request when the given nonce matches the current one", () => {
    useDashboardStore.getState().requestOpenSession(7);
    useDashboardStore.getState().clearOpenSessionRequest(1);
    expect(useDashboardStore.getState().openSessionRequest).toBeNull();
  });

  it("does not clear a newer request tagged with a different nonce", () => {
    useDashboardStore.getState().requestOpenSession(7); // nonce 1
    useDashboardStore.getState().requestOpenSession(8); // nonce 2
    useDashboardStore.getState().clearOpenSessionRequest(1);
    expect(useDashboardStore.getState().openSessionRequest).toEqual({ sessionId: 8, nonce: 2 });
  });
});

// Issue #1427 — eventKey() gained a third `ts` segment, so every dismiss
// test below now seeds `events` with the exact events being dismissed
// (mirroring every real call site: dismissEvent/dismissEvents are only ever
// called on an event the UI is currently rendering, i.e. one still in the
// buffer) rather than dismissing a bare (sessionId, seq) pair with no
// backing event — that would only exercise dismissEvent's Date.now()
// fallback, which is nondeterministic and not what production code paths
// hit.
describe("dismissEvent / dismissedEventKeys (issue #169)", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      events: {
        5: [
          event({ sessionId: 5, seq: 1, ts: 1000 }),
          event({ sessionId: 5, seq: 3, ts: 3000 }),
          event({ sessionId: 5, seq: 10, ts: 10000 }),
        ],
        9: [event({ sessionId: 9, seq: 1, ts: 2000 })],
      },
      lastSeenSeq: {},
      dismissedEventKeys: {},
    });
  });

  it("flags a (sessionId, seq) pair as dismissed", () => {
    useDashboardStore.getState().dismissEvent(5, 3);
    expect(useDashboardStore.getState().dismissedEventKeys[eventKey(5, 3, 3000)]).toBe(true);
  });

  it("keeps dismissals independent per session even with the same seq", () => {
    useDashboardStore.getState().dismissEvent(5, 1);
    useDashboardStore.getState().dismissEvent(9, 1);
    const dismissed = useDashboardStore.getState().dismissedEventKeys;
    expect(dismissed[eventKey(5, 1, 1000)]).toBe(true);
    expect(dismissed[eventKey(9, 1, 2000)]).toBe(true);
    expect(Object.keys(dismissed)).toHaveLength(2);
  });

  it("does not touch lastSeenSeq — dismiss and read stay orthogonal", () => {
    // Dismissing the newest of several unread events must not silently mark
    // the older, still-unread ones read by moving the shared cursor — that
    // would be the bug of coupling dismiss to markEventSeen.
    useDashboardStore.getState().dismissEvent(5, 10);
    expect(useDashboardStore.getState().lastSeenSeq[5]).toBeUndefined();
  });

  it("is idempotent — dismissing an already-dismissed event is a no-op re-set", () => {
    useDashboardStore.getState().dismissEvent(5, 3);
    useDashboardStore.getState().dismissEvent(5, 3);
    expect(Object.keys(useDashboardStore.getState().dismissedEventKeys)).toHaveLength(1);
  });

  it("falls back to Date.now() rather than throwing when the event isn't buffered", () => {
    useDashboardStore.getState().dismissEvent(5, 999);
    const dismissed = useDashboardStore.getState().dismissedEventKeys;
    expect(Object.keys(dismissed).some((k) => k.startsWith("5:999:"))).toBe(true);
  });
});

describe("dismissEvents (batched, PR #717 — NotificationBell.tsx's folded-row dismiss)", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      events: {
        5: [
          event({ sessionId: 5, seq: 1, ts: 1000 }),
          event({ sessionId: 5, seq: 2, ts: 2000 }),
          event({ sessionId: 5, seq: 3, ts: 3000 }),
        ],
      },
      lastSeenSeq: {},
      dismissedEventKeys: {},
    });
  });

  it("flags every seq in the array as dismissed in a single call", () => {
    useDashboardStore.getState().dismissEvents(5, [3, 2, 1]);
    const dismissed = useDashboardStore.getState().dismissedEventKeys;
    expect(dismissed[eventKey(5, 3, 3000)]).toBe(true);
    expect(dismissed[eventKey(5, 2, 2000)]).toBe(true);
    expect(dismissed[eventKey(5, 1, 1000)]).toBe(true);
  });

  it("is a no-op for an empty array", () => {
    const before = useDashboardStore.getState().dismissedEventKeys;
    useDashboardStore.getState().dismissEvents(5, []);
    expect(useDashboardStore.getState().dismissedEventKeys).toBe(before);
  });

  it("matches dismissEvent's per-key result — batching is an optimization, not a behavior change", () => {
    useDashboardStore.getState().dismissEvents(5, [1, 2]);
    const batched = useDashboardStore.getState().dismissedEventKeys;

    useDashboardStore.setState({ dismissedEventKeys: {} });
    useDashboardStore.getState().dismissEvent(5, 1);
    useDashboardStore.getState().dismissEvent(5, 2);
    const sequential = useDashboardStore.getState().dismissedEventKeys;

    expect(batched).toEqual(sequential);
  });
});
