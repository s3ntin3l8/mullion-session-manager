import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";

// Focused unit coverage for relayRemoteEventsHost's browser<->upstream
// wiring (issue #166's multi-host twin) — mirrors
// test/routes/terminal-remote-proxy.test.ts's own MockSocket approach for
// proxyToRemoteAttach exactly, for the same reason: a real end-to-end
// multi-host WS test needs two full listening servers for proportionally
// much less coverage than driving this function directly against fake
// EventEmitter-based sockets.

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
  bufferedAmount = 0;
  sendSpy = vi.fn();
  closeSpy = vi.fn();

  send(data: unknown, opts?: unknown) {
    this.sendSpy(data, opts);
  }

  close() {
    this.closeSpy();
    this.readyState = MockSocket.CLOSED;
    this.emit("close");
  }

  open() {
    this.readyState = MockSocket.OPEN;
    this.emit("open");
  }
}

const openEventsStreamMock = vi.fn();

vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: vi.fn(() => ({ openEventsStream: openEventsStreamMock })),
}));

const listHostsMock = vi.fn();
vi.mock("../../src/services/host-registry.js", () => ({
  listHosts: listHostsMock,
}));

// Issue #1459 — relayRemoteEventsHost's own ownership-filtering collision
// guard. Mocked here (rather than exercised against a real DB, the way
// test/services/session-live-info-resolve-session-host-ids.test.ts already
// covers resolveSessionHostIds' own real-join correctness) so this file can
// keep its existing lightweight fakeApp()/fakeAppWithPty() harness — a real
// buildApp() here would also pull in `LOCAL_HOST_ID` and other exports this
// file's own host-registry.js/remote-host-client.js mocks don't provide,
// throwing at import time.
const resolveSessionHostIdsMock = vi.fn();
vi.mock("../../src/services/session-live-info.js", () => ({
  resolveSessionHostIds: resolveSessionHostIdsMock,
}));

const { relayRemoteEventsHost, attachAggregatedEventsSocket } =
  await import("../../src/routes/events.js");

function fakeApp(): FastifyInstance {
  return { log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } } as unknown as FastifyInstance;
}

function fakeAppWithPty(): FastifyInstance {
  return {
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    pty: {
      onEvent: vi.fn(() => () => {}),
      listEvents: vi.fn(() => []),
      listCursors: vi.fn(() => ({})),
      bootId: "test-boot-id",
      markEventsSeen: vi.fn(),
    },
  } as unknown as FastifyInstance;
}

describe("relayRemoteEventsHost (issue #166's multi-host twin)", () => {
  beforeEach(() => {
    openEventsStreamMock.mockReset();
    resolveSessionHostIdsMock.mockReset();
  });

  it("opens the upstream with the cursors:true opt-in flag", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openEventsStreamMock.mockReturnValue(upstream);

    relayRemoteEventsHost(fakeApp(), browserSocket as unknown as WebSocket, "remote-host");

    expect(openEventsStreamMock).toHaveBeenCalledWith({ cursors: true });
  });

  it("relays an upstream event message into the browser socket, explicitly forwarding isBinary", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openEventsStreamMock.mockReturnValue(upstream);

    const returned = relayRemoteEventsHost(
      fakeApp(),
      browserSocket as unknown as WebSocket,
      "remote-host",
    );
    expect(returned).toBe(upstream);

    const wireEvent = JSON.stringify({
      seq: 1,
      sessionId: 5,
      kind: "attention",
      ts: 0,
      payload: {},
    });
    // Real `ws` "message" events always deliver a Buffer (never a bare
    // string) plus an explicit boolean isBinary — emitting anything else
    // here would let this test pass without actually exercising the
    // `{ binary: isBinary }` opts this relies on (a SocketChannel
    // browserSocket would otherwise misframe this always-JSON payload as
    // PTY-style binary data — see relayRemoteEventsHost's own doc comment).
    upstream.emit("message", Buffer.from(wireEvent), false);

    expect(browserSocket.sendSpy).toHaveBeenCalledWith(Buffer.from(wireEvent), { binary: false });
  });

  it("drops an upstream event once the browser socket's own send buffer is over the backpressure threshold", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    browserSocket.bufferedAmount = 4 * 1024 * 1024 + 1;
    const upstream = new MockSocket();
    openEventsStreamMock.mockReturnValue(upstream);

    relayRemoteEventsHost(fakeApp(), browserSocket as unknown as WebSocket, "remote-host");
    upstream.emit("message", Buffer.from("{}"), false);

    expect(browserSocket.sendSpy).not.toHaveBeenCalled();
  });

  it("does not forward an upstream message once the browser socket has closed", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.CLOSED;
    const upstream = new MockSocket();
    openEventsStreamMock.mockReturnValue(upstream);

    relayRemoteEventsHost(fakeApp(), browserSocket as unknown as WebSocket, "remote-host");
    upstream.emit("message", Buffer.from("{}"), false);

    expect(browserSocket.sendSpy).not.toHaveBeenCalled();
  });

  it("returns null and logs, without throwing, when opening the upstream fails synchronously", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    openEventsStreamMock.mockImplementation(() => {
      throw new Error("no baseUrl configured");
    });
    const app = fakeApp();

    const returned = relayRemoteEventsHost(
      app,
      browserSocket as unknown as WebSocket,
      "remote-host",
    );

    expect(returned).toBeNull();
    expect(app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "remote-host" }),
      "failed to open remote events stream",
    );
  });

  it("logs, without closing the browser socket, when the upstream itself errors", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openEventsStreamMock.mockReturnValue(upstream);
    const app = fakeApp();

    relayRemoteEventsHost(app, browserSocket as unknown as WebSocket, "remote-host");
    upstream.emit("error", new Error("connection reset"));

    // Unlike proxyToRemoteAttach (a 1:1 relationship where one host's
    // failure legitimately ends the browser's single-session socket), this
    // is an aggregated multi-host stream — one host's upstream erroring
    // must never close the browser's own /ws/events socket, since other
    // hosts' (and local) events must keep flowing.
    expect(browserSocket.closeSpy).not.toHaveBeenCalled();
    expect(app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "remote-host" }),
      "remote events ws upstream error",
    );
  });

  it("still forwards a plain event frame completely unparsed, byte-for-byte — no regression on the hot path", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openEventsStreamMock.mockReturnValue(upstream);

    relayRemoteEventsHost(fakeApp(), browserSocket as unknown as WebSocket, "remote-host");

    const wireEvent = JSON.stringify({ seq: 9, sessionId: 5, kind: "attention", ts: 0, payload: {} });
    const buf = Buffer.from(wireEvent);
    upstream.emit("message", buf, false);

    // Forwarded as the EXACT SAME Buffer instance, never re-stringified —
    // and resolveSessionHostIds is never even called for a frame that isn't
    // a cursors/seen type, confirming the prefix check short-circuits
    // before any JSON.parse.
    expect(browserSocket.sendSpy).toHaveBeenCalledWith(buf, { binary: false });
    expect(resolveSessionHostIdsMock).not.toHaveBeenCalled();
  });

  it("re-emits a remote cursors frame tagged with hostId, filtered to sessions this host owns", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openEventsStreamMock.mockReturnValue(upstream);

    // session 5 belongs to remote-host, session 6 belongs to a DIFFERENT
    // host despite being reported in remote-host's own cursors frame — the
    // exact numeric-session-id-collision hazard this filter exists for.
    resolveSessionHostIdsMock.mockReturnValue(
      new Map([
        [5, "remote-host"],
        [6, "some-other-host"],
      ]),
    );

    relayRemoteEventsHost(fakeApp(), browserSocket as unknown as WebSocket, "remote-host");

    const cursorsFrame = JSON.stringify({
      type: "cursors",
      bootId: "agent-boot-1",
      cursors: { "5": { seen: 3, head: 10 }, "6": { seen: 0, head: 1 } },
    });
    upstream.emit("message", Buffer.from(cursorsFrame), false);

    expect(resolveSessionHostIdsMock).toHaveBeenCalledWith(expect.anything(), [5, 6]);
    expect(browserSocket.sendSpy).toHaveBeenCalledWith(
      JSON.stringify({
        type: "cursors",
        hostId: "remote-host",
        bootId: "agent-boot-1",
        cursors: { 5: { seen: 3, head: 10 } },
      }),
      undefined,
    );
  });

  it("relays a remote seen frame for a session OWNED by this host", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openEventsStreamMock.mockReturnValue(upstream);
    resolveSessionHostIdsMock.mockReturnValue(new Map([[5, "remote-host"]]));

    relayRemoteEventsHost(fakeApp(), browserSocket as unknown as WebSocket, "remote-host");

    const seenFrame = JSON.stringify({ type: "seen", sessionId: 5, seq: 4 });
    upstream.emit("message", Buffer.from(seenFrame), false);

    expect(resolveSessionHostIdsMock).toHaveBeenCalledWith(expect.anything(), [5]);
    expect(browserSocket.sendSpy).toHaveBeenCalledWith(
      JSON.stringify({ type: "seen", sessionId: 5, seq: 4 }),
      undefined,
    );
  });

  it("silently drops a remote seen frame for a session NOT owned by this host", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openEventsStreamMock.mockReturnValue(upstream);
    // session 5 actually belongs to a different host than the one reporting it.
    resolveSessionHostIdsMock.mockReturnValue(new Map([[5, "some-other-host"]]));

    relayRemoteEventsHost(fakeApp(), browserSocket as unknown as WebSocket, "remote-host");

    const seenFrame = JSON.stringify({ type: "seen", sessionId: 5, seq: 4 });
    upstream.emit("message", Buffer.from(seenFrame), false);

    expect(browserSocket.sendSpy).not.toHaveBeenCalled();
  });
});

// Focused coverage for the OTHER direction of the same isBinary fix
// (subagent review, PR #400): relayRemoteEventsHost's own upstream→browser
// forwarding was fixed to pass { binary: isBinary } explicitly, but
// attachAggregatedEventsSocket's browser→upstream "seen"-forwarding handler
// needs the identical fix — without it, `upstream.send(data)` with a Buffer
// (what a "seen" message always is, whether from a SocketChannel or a real
// WS's own default binaryType) defaults to a BINARY frame, and the
// receiving agent's own attachLocalEventsSocket message handler starts with
// `if (isBinary) return;`, silently dropping it.
describe("attachAggregatedEventsSocket's browser->upstream forwarding (Phase 4 #188)", () => {
  beforeEach(() => {
    openEventsStreamMock.mockReset();
    listHostsMock.mockReset();
  });

  it("forwards a browser 'seen' message to every open remote-host upstream with isBinary explicitly forwarded, not left to default inference", () => {
    listHostsMock.mockReturnValue([
      {
        id: "remote-1",
        name: "r",
        baseUrl: "http://remote-1",
        isLocal: false,
        hasToken: true,
        createdAt: new Date(0),
      },
    ]);
    const upstream = new MockSocket();
    upstream.readyState = MockSocket.OPEN;
    openEventsStreamMock.mockReturnValue(upstream);

    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;

    attachAggregatedEventsSocket(fakeAppWithPty(), browserSocket as unknown as WebSocket);

    const seenMessage = Buffer.from(JSON.stringify({ type: "seen", sessionId: 5, seq: 2 }));
    browserSocket.emit("message", seenMessage, false);

    expect(upstream.sendSpy).toHaveBeenCalledWith(seenMessage, { binary: false });
  });
});
