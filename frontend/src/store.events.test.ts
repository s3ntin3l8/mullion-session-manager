// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eventKey, useDashboardStore } from "./store.js";
import type { NotificationEvent } from "./api.js";

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

describe("dismissEvent / dismissedEventKeys (issue #169)", () => {
  beforeEach(() => {
    useDashboardStore.setState({ events: {}, lastSeenSeq: {}, dismissedEventKeys: {} });
  });

  it("flags a (sessionId, seq) pair as dismissed", () => {
    useDashboardStore.getState().dismissEvent(5, 3);
    expect(useDashboardStore.getState().dismissedEventKeys[eventKey(5, 3)]).toBe(true);
  });

  it("keeps dismissals independent per session even with the same seq", () => {
    useDashboardStore.getState().dismissEvent(5, 1);
    useDashboardStore.getState().dismissEvent(9, 1);
    const dismissed = useDashboardStore.getState().dismissedEventKeys;
    expect(dismissed[eventKey(5, 1)]).toBe(true);
    expect(dismissed[eventKey(9, 1)]).toBe(true);
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
});
