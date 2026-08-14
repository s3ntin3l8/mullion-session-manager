// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore } from "./store/index.js";
import { api } from "./api/index.js";
import { EVENTS_REFRESH_THROTTLE_MS } from "./store/constants.js";
import type { NotificationEvent } from "./api/index.js";

// Issue #673 — the /ws/events push now throttled-triggers refreshSessions()
// on status-bearing frames, instead of session status reaching the UI only
// via the 4s poll (which stops entirely while the tab is hidden). Mirrors
// store.events.test.ts's own convention: mock the platform WebSocket (not
// eventsClient.ts) so this exercises the real dedupe/throttle logic end to
// end, plus vi.spyOn(api, "listSessions") (store.sessionsLoaded.test.ts's
// convention) so the triggered refresh can be observed without a real
// backend.

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
  private listeners: Record<string, Array<(event: { data?: unknown }) => void>> = {};

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data?: unknown }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  send() {}

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
let nextSeq = 1;

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: nextSeq++,
    sessionId: 5,
    kind: "status_change",
    ts: 1000,
    payload: {},
    ...overrides,
  };
}

describe("store /ws/events -> refreshSessions() throttle (issue #673)", () => {
  beforeEach(() => {
    instances = [];
    nextSeq = 1;
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    useDashboardStore.setState({ events: {}, lastSeenSeq: {}, dismissedEventKeys: {} });
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refreshes sessions immediately (leading edge) on a single status-bearing frame", async () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(JSON.stringify(event({ kind: "status_change" })));
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(api.listSessions)).toHaveBeenCalledTimes(1);

    stop();
  });

  it("coalesces a burst inside one throttle window into exactly 2 calls (leading + trailing)", async () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    // Simulates a stale-latch sweep tick or a reconnect replay burst — many
    // status-bearing frames arriving well inside one throttle window.
    for (let i = 0; i < 10; i++) {
      instances[0].__message(JSON.stringify(event({ kind: "status_change" })));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(api.listSessions)).toHaveBeenCalledTimes(1); // leading call only so far

    await vi.advanceTimersByTimeAsync(EVENTS_REFRESH_THROTTLE_MS);
    expect(vi.mocked(api.listSessions)).toHaveBeenCalledTimes(2); // one trailing call, not 10

    stop();
  });

  it("keeps refreshing periodically under a continuous stream — the trailing call is not starved", async () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    // A frame every 50ms — far more frequent than the throttle window — for
    // 4 full windows' worth of elapsed time. A pure trailing debounce that
    // reschedules from the LAST event would never let the window elapse
    // (each new frame arrives well before the prior one's debounce fires)
    // and would starve entirely: 0 refreshes for the whole stretch. The
    // fixed-window throttle must still refresh roughly once per window
    // regardless, since only the FIRST frame after a window closes matters,
    // not the most recent one.
    const totalMs = EVENTS_REFRESH_THROTTLE_MS * 4;
    for (let elapsed = 0; elapsed < totalMs; elapsed += 50) {
      instances[0].__message(JSON.stringify(event({ kind: "status_change" })));
      await vi.advanceTimersByTimeAsync(50);
    }

    // ~4 windows elapsed; expect multiple refreshes, not the single one a
    // starved trailing-only debounce would produce.
    expect(vi.mocked(api.listSessions).mock.calls.length).toBeGreaterThanOrEqual(3);

    stop();
  });

  it("does not refresh on a denied (routine, high-frequency) kind alone", async () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(JSON.stringify(event({ kind: "title_change" })));
    instances[0].__message(JSON.stringify(event({ kind: "file_change" })));
    await vi.advanceTimersByTimeAsync(EVENTS_REFRESH_THROTTLE_MS * 2);

    expect(vi.mocked(api.listSessions)).not.toHaveBeenCalled();

    stop();
  });

  it("still refreshes when a denied kind is mixed into the same burst as a status-bearing one", async () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(JSON.stringify(event({ kind: "title_change" })));
    instances[0].__message(JSON.stringify(event({ kind: "attention" })));
    instances[0].__message(JSON.stringify(event({ kind: "file_change" })));
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(api.listSessions)).toHaveBeenCalledTimes(1);

    stop();
  });

  it("clears the pending trailing refresh when the stream's own disposer runs", async () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(JSON.stringify(event({ kind: "status_change" })));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(api.listSessions)).toHaveBeenCalledTimes(1);

    // A second frame inside the same window schedules a trailing call...
    instances[0].__message(JSON.stringify(event({ kind: "status_change" })));
    // ...but cleanup runs before that window elapses.
    stop();

    await vi.advanceTimersByTimeAsync(EVENTS_REFRESH_THROTTLE_MS * 2);
    // No leaked timer firing post-unmount.
    expect(vi.mocked(api.listSessions)).toHaveBeenCalledTimes(1);
  });

  it("a rejected refreshSessions() doesn't wedge the throttle or crash — the next window still refreshes", async () => {
    // refreshSessions() rethrows on failure (sessions.ts), and this call
    // site has no awaiting caller — omitting .catch() here would surface as
    // an unhandled rejection that fails this test on its own (vitest's
    // default unhandled-rejection reporting), so a passing run is itself
    // evidence .catch() is in place. Also exercises the more concrete
    // behavior that matters: a failed fetch must not leave the throttle
    // timer stuck, since scheduleRefresh() never awaits its own promise.
    vi.useFakeTimers();
    vi.mocked(api.listSessions).mockRejectedValueOnce(new Error("network error"));

    const stop = useDashboardStore.getState().startEventsStream();
    instances[0].__open();

    instances[0].__message(JSON.stringify(event({ kind: "status_change" })));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(api.listSessions)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(EVENTS_REFRESH_THROTTLE_MS);
    instances[0].__message(JSON.stringify(event({ kind: "status_change" })));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(api.listSessions)).toHaveBeenCalledTimes(2);

    stop();
  });
});
