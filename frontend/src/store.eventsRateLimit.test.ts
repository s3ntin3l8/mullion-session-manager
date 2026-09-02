// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardStore } from "./store/index.js";
import { __resetRateLimitBreakerForTests } from "./api/client.js";
import { __resetSessionRefreshBlockForTests } from "./store/slices/sessions.js";
import type { NotificationEvent } from "./api/index.js";

// Regression coverage for issue #959: a status-bearing event from the
// /ws/events push channel must NOT trigger a refreshSessions() when the
// 429 backoff window (set by a previous listSessions 429) is still
// active. Without this, a flood of attention/working/etc. events would
// bypass the backoff the live poll established and continue hammering
// the rate-limited bucket, extending the block indefinitely.

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

describe("events.ts / 429 backoff interaction (issue #959)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetRateLimitBreakerForTests();
    __resetSessionRefreshBlockForTests();
    instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    useDashboardStore.setState({
      events: {},
      lastSeenSeq: {},
      dismissedEventKeys: {},
      sessions: [],
      sessionsLoaded: false,
      backendReachable: true,
      sessionExpired: false,
    });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a status-bearing event arriving during the 429 backoff does NOT trigger refreshSessions", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "Too Many Requests" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "60",
        },
      }),
    );

    // Set the backoff window manually so the test doesn't depend on
    // timing: a real user-facing path would set this from a previous
    // refreshSessions 429. We do this by triggering refreshSessions
    // first, which sets the blockedUntil via its catch. The fetch
    // promise rejects with a RateLimitedError — that's the expected
    // signal, not a test failure.
    await expect(useDashboardStore.getState().refreshSessions()).rejects.toThrow(/Rate limited/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Now start the events stream and push a status-bearing event. The
    // push handler's onStatusBearingEvent -> scheduleRefresh must NOT
    // call refreshSessions while the backoff is still active.
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();
    instances[0].__message(JSON.stringify(event()));

    // Drain microtasks — the WS message handler runs synchronously,
    // but any async work it triggered should also be flushed.
    await vi.advanceTimersByTimeAsync(0);

    // The event was stored…
    expect(useDashboardStore.getState().events[5]).toHaveLength(1);
    // …but no additional fetch happened: the backoff held.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
  });
});
