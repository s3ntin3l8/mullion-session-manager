import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";

// Issue #213 cross-host capture — direct, fake-timer unit tests of
// remote-event-subscriber.ts's connection lifecycle (connect/reconnect
// backoff, connect timeout, host-set reconciliation), against mocked
// host-registry.js/remote-host-client.js/settings.js and a hand-rolled
// EventEmitter socket — same MockSocket approach
// test/routes/events-remote-relay.test.ts already uses for
// relayRemoteEventsHost, the closest existing analogue. A real
// two-listening-server end-to-end test is deliberately not attempted here,
// per that file's own stated tradeoff (routes/events.ts).

class MockSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = MockSocket.CONNECTING;
  readonly OPEN = MockSocket.OPEN;
  readonly CLOSING = MockSocket.CLOSING;
  readonly CLOSED = MockSocket.CLOSED;

  readyState = MockSocket.CONNECTING;
  sendSpy = vi.fn();
  closeSpy = vi.fn();
  terminateSpy = vi.fn();

  send(data: unknown, opts?: unknown) {
    this.sendSpy(data, opts);
  }

  close() {
    this.closeSpy();
    this.readyState = MockSocket.CLOSED;
    this.emit("close");
  }

  terminate() {
    this.terminateSpy();
    this.readyState = MockSocket.CLOSED;
    this.emit("close");
  }

  open() {
    this.readyState = MockSocket.OPEN;
    this.emit("open");
  }
}

const openEventsStreamMock = vi.fn();
const getRemoteHostClientMock = vi.fn(() => ({ openEventsStream: openEventsStreamMock }));
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: (...args: unknown[]) => getRemoteHostClientMock(...(args as [])),
}));

const listHostsMock = vi.fn();
vi.mock("../../src/services/host-registry.js", () => ({
  listHosts: (...args: unknown[]) => listHostsMock(...(args as [])),
}));

const getStoredSettingsMock = vi.fn();
vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: (...args: unknown[]) => getStoredSettingsMock(...(args as [])),
}));

const { startRemoteEventSubscriber } =
  await import("../../src/services/remote-event-subscriber.js");

function fakeHost(
  id: string,
  overrides: Partial<{ isLocal: boolean; baseUrl: string | null }> = {},
) {
  return {
    id,
    name: id,
    baseUrl: overrides.baseUrl !== undefined ? overrides.baseUrl : `http://${id}.example`,
    isLocal: overrides.isLocal ?? false,
    hasToken: true,
    createdAt: new Date(0),
    origin: "manual" as const,
  };
}

function fakeApp(): FastifyInstance {
  return {
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    db: {},
  } as unknown as FastifyInstance;
}

describe("startRemoteEventSubscriber", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    openEventsStreamMock.mockReset();
    getRemoteHostClientMock.mockClear();
    listHostsMock.mockReset();
    getStoredSettingsMock.mockReset();
    getStoredSettingsMock.mockReturnValue({ sessions: { eventPersistence: true } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens one subscription per non-local host and none for the local host", () => {
    listHostsMock.mockReturnValue([fakeHost("local", { isLocal: true }), fakeHost("remote-a")]);
    openEventsStreamMock.mockImplementation(() => new MockSocket());
    const app = fakeApp();

    const handle = startRemoteEventSubscriber(app, vi.fn());
    handle.reconcile();

    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1);
    expect(getRemoteHostClientMock).toHaveBeenCalledWith(app, "remote-a");
  });

  // Regression test (Hermes review, PR #564): host-heartbeat.ts's sweep()
  // defensively excludes a baseUrl-less non-local row (today only ever
  // "local" itself, but "for any future path that might introduce one" —
  // its own comment); this module lacked the same filter, so such a row
  // would make getRemoteHostClient throw synchronously on every attempt,
  // parked in an infinite 30s warn+retry loop that can never succeed.
  it("does not attempt a subscription for a non-local host with no baseUrl", () => {
    listHostsMock.mockReturnValue([fakeHost("pending-enrolled", { baseUrl: null })]);
    const app = fakeApp();

    startRemoteEventSubscriber(app, vi.fn()).reconcile();

    expect(getRemoteHostClientMock).not.toHaveBeenCalled();
  });

  it("opens no subscriptions when sessions.eventPersistence is off, and closes any already open", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);
    const app = fakeApp();

    const handle = startRemoteEventSubscriber(app, vi.fn());
    handle.reconcile();
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1);

    getStoredSettingsMock.mockReturnValue({ sessions: { eventPersistence: false } });
    handle.reconcile();

    expect(socket.closeSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses to open a NEW subscription when getStoredSettings fails (unconfirmed, not confirmed-off)", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    getStoredSettingsMock.mockImplementation(() => {
      throw new Error("settings table unreadable");
    });
    const app = fakeApp();

    startRemoteEventSubscriber(app, vi.fn()).reconcile();

    expect(getRemoteHostClientMock).not.toHaveBeenCalled();
    expect(app.log.error).toHaveBeenCalled();
  });

  // Regression test (Hermes review, PR #564): a transient settings-read
  // failure must NOT tear down every open subscription fleet-wide — only a
  // CONFIRMED eventPersistence: false does that. The previous behavior
  // treated a read failure identically to "off," which could pause
  // fleet-wide capture for up to an hour (until the next fallback tick) on
  // one blip.
  it("leaves an already-open, healthy subscription alone when a later getStoredSettings call fails", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);
    const handle = startRemoteEventSubscriber(fakeApp(), vi.fn());
    handle.reconcile();
    socket.open();
    expect(socket.closeSpy).not.toHaveBeenCalled();

    getStoredSettingsMock.mockImplementation(() => {
      throw new Error("settings table unreadable");
    });
    handle.reconcile();

    expect(socket.closeSpy).not.toHaveBeenCalled();
  });

  it("still closes a subscription for a removed host, or one forceReconnect names, even while settings are unconfirmed", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);
    const handle = startRemoteEventSubscriber(fakeApp(), vi.fn());
    handle.reconcile();
    socket.open();

    listHostsMock.mockReturnValue([]); // remote-a deleted
    getStoredSettingsMock.mockImplementation(() => {
      throw new Error("settings table unreadable");
    });
    handle.reconcile();

    expect(socket.closeSpy).toHaveBeenCalledTimes(1);
  });

  it("delivers a received event to onEvent tagged with the reporting host's id", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);
    const onEvent = vi.fn();

    startRemoteEventSubscriber(fakeApp(), onEvent).reconcile();
    socket.open();

    const wireEvent = { seq: 1, sessionId: 5, kind: "attention", ts: 0, payload: {} };
    socket.emit("message", Buffer.from(JSON.stringify(wireEvent)), false);

    expect(onEvent).toHaveBeenCalledWith(wireEvent, "remote-a");
  });

  // Regression test (Hermes review, PR #564 round 4): a frame can arrive in
  // the narrow window between closeSubscription()'s socket.close() and the
  // "close" event actually firing — simulated here by emitting "message" on
  // a socket whose subscription has already been torn down (sub.stopped),
  // rather than relying on the mock's synchronous close/emit to reproduce
  // real async timing.
  it("ignores a message frame that arrives after the subscription has been closed", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);
    const onEvent = vi.fn();

    const handle = startRemoteEventSubscriber(fakeApp(), onEvent);
    handle.reconcile();
    socket.open();
    handle.stop();

    const wireEvent = { seq: 1, sessionId: 5, kind: "attention", ts: 0, payload: {} };
    socket.emit("message", Buffer.from(JSON.stringify(wireEvent)), false);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("drops a binary frame without calling onEvent", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);
    const onEvent = vi.fn();

    startRemoteEventSubscriber(fakeApp(), onEvent).reconcile();
    socket.open();
    socket.emit("message", Buffer.from("irrelevant"), true);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("drops malformed JSON and non-NotificationEvent-shaped frames without throwing or calling onEvent", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);
    const onEvent = vi.fn();
    const app = fakeApp();

    startRemoteEventSubscriber(app, onEvent).reconcile();
    socket.open();

    expect(() => socket.emit("message", Buffer.from("{not json"), false)).not.toThrow();
    expect(() =>
      socket.emit("message", Buffer.from(JSON.stringify({ hello: "world" })), false),
    ).not.toThrow();

    expect(onEvent).not.toHaveBeenCalled();
    expect(app.log.warn).toHaveBeenCalled();
  });

  it("never sends a frame upstream — this is a strictly read-only subscription", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);

    startRemoteEventSubscriber(fakeApp(), vi.fn()).reconcile();
    socket.open();
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ seq: 1, sessionId: 5, kind: "attention", ts: 0, payload: {} })),
      false,
    );

    expect(socket.sendSpy).not.toHaveBeenCalled();
  });

  it("logs a socket-level error without closing it directly — reconnect is left to the close handler", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);
    const app = fakeApp();

    startRemoteEventSubscriber(app, vi.fn()).reconcile();
    socket.open();
    socket.emit("error", new Error("connection reset"));

    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "remote-a" }),
      "[remote-event-subscriber] events ws error",
    );
    expect(socket.closeSpy).not.toHaveBeenCalled();
  });

  it("reconnects with the established backoff shape after the socket closes, and resets on a successful open", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const sockets = [new MockSocket(), new MockSocket(), new MockSocket()];
    let i = 0;
    openEventsStreamMock.mockImplementation(() => sockets[i++]);

    startRemoteEventSubscriber(fakeApp(), vi.fn()).reconcile();
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1);

    sockets[0].emit("close"); // never opened — first reconnect delay: 1s
    vi.advanceTimersByTime(999);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(2);

    sockets[1].emit("close"); // second attempt also failed: 2s delay next
    vi.advanceTimersByTime(1999);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(3);

    sockets[2].open(); // success — backoff resets to attempt 0
    sockets[2].emit("close");
    vi.advanceTimersByTime(999);
    // Would already be 4 calls if the reset hadn't taken effect (that'd
    // imply a 2s-or-shorter next delay); confirms it's back to the 1s tier.
  });

  it("fetches getRemoteHostClient fresh on every reconnect attempt rather than caching the client", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const first = new MockSocket();
    const second = new MockSocket();
    openEventsStreamMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    startRemoteEventSubscriber(fakeApp(), vi.fn()).reconcile();
    first.emit("close");
    vi.advanceTimersByTime(1_000);

    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(2);
  });

  it("catches a synchronous getRemoteHostClient throw (deleted/baseUrl-less host row) and retries instead of throwing", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    getRemoteHostClientMock.mockImplementation(() => {
      throw new Error("Host remote-a has no baseUrl — not a remote host");
    });
    const app = fakeApp();

    expect(() => startRemoteEventSubscriber(app, vi.fn()).reconcile()).not.toThrow();
    expect(app.log.warn).toHaveBeenCalled();

    getRemoteHostClientMock.mockImplementation(() => ({ openEventsStream: openEventsStreamMock }));
    openEventsStreamMock.mockReturnValue(new MockSocket());
    vi.advanceTimersByTime(1_000);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(2);
  });

  it("terminates and retries a connection that never opens within the connect timeout", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValueOnce(socket).mockReturnValueOnce(new MockSocket());

    startRemoteEventSubscriber(fakeApp(), vi.fn()).reconcile();
    vi.advanceTimersByTime(10_000); // CONNECT_TIMEOUT_MS

    expect(socket.terminateSpy).toHaveBeenCalledTimes(1);
  });

  it("closes and drops a subscription for a host that's been removed from listHosts", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);
    const handle = startRemoteEventSubscriber(fakeApp(), vi.fn());
    handle.reconcile();

    listHostsMock.mockReturnValue([]); // remote-a deleted
    handle.reconcile();

    expect(socket.closeSpy).toHaveBeenCalledTimes(1);

    // A subsequent close of the (now-abandoned) old socket must not
    // resurrect a reconnect loop for a host that no longer exists.
    getRemoteHostClientMock.mockClear();
    socket.emit("close");
    vi.advanceTimersByTime(60_000);
    expect(getRemoteHostClientMock).not.toHaveBeenCalled();
  });

  it("forceReconnect tears down and reopens a still-desired host's subscription immediately", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const first = new MockSocket();
    const second = new MockSocket();
    openEventsStreamMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const handle = startRemoteEventSubscriber(fakeApp(), vi.fn());
    handle.reconcile();
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1);

    handle.reconcile({ forceReconnect: ["remote-a"] });

    expect(first.closeSpy).toHaveBeenCalledTimes(1);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(2);
  });

  it("stop() closes every open subscription and permanently halts reconnect attempts", () => {
    listHostsMock.mockReturnValue([fakeHost("remote-a")]);
    const socket = new MockSocket();
    openEventsStreamMock.mockReturnValue(socket);
    const handle = startRemoteEventSubscriber(fakeApp(), vi.fn());
    handle.reconcile();

    handle.stop();
    expect(socket.closeSpy).toHaveBeenCalledTimes(1);

    getRemoteHostClientMock.mockClear();
    handle.reconcile(); // must be a no-op after stop()
    vi.advanceTimersByTime(60_000);
    expect(getRemoteHostClientMock).not.toHaveBeenCalled();
  });
});
