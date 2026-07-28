import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type net from "node:net";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { SocketChannel } from "../../src/services/socket-channel.js";

// Focused unit coverage for proxyToRemoteAttach's browser<->upstream wiring
// (Hermes review, PR #34/issue #26): the browser-side message/close
// handlers must be registered unconditionally at call time, not only
// inside upstream's "open" callback — otherwise a browser close that
// arrives before the (up to 5s) upstream connect finishes never triggers
// closeUpstream, leaking that connection. A real network round trip can't
// reliably exercise this race deterministically, so this drives
// proxyToRemoteAttach directly against fake EventEmitter-based sockets
// instead of a real WS server pair.

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

const openAttachMock = vi.fn();

vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: vi.fn(() => ({ openAttach: openAttachMock })),
}));

const { proxyToRemoteAttach } = await import("../../src/routes/terminal.js");

function fakeApp(): FastifyInstance {
  return { log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } } as unknown as FastifyInstance;
}

const OPTS = { id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 };

describe("proxyToRemoteAttach (issue #26, Hermes review PR #34)", () => {
  beforeEach(() => {
    openAttachMock.mockReset();
  });

  it("registers the browser message handler immediately, before the upstream connection opens", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openAttachMock.mockReturnValue(upstream);

    proxyToRemoteAttach(fakeApp(), browserSocket as unknown as WebSocket, "remote-host", OPTS);

    // Registered synchronously by proxyToRemoteAttach itself, not deferred
    // until upstream's "open" fires — the whole point of the fix.
    expect(browserSocket.listenerCount("message")).toBeGreaterThan(0);
    expect(browserSocket.listenerCount("close")).toBeGreaterThan(0);

    // Once the upstream actually opens, a message sent by the browser
    // forwards correctly using that same, already-registered handler.
    upstream.open();
    browserSocket.emit("message", Buffer.from("hello"), true);
    expect(upstream.sendSpy).toHaveBeenCalledWith(Buffer.from("hello"), { binary: true });
  });

  it("closes a still-connecting upstream when the browser closes first, instead of leaking it", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    // Deliberately left CONNECTING — never opened — to reproduce the
    // pre-fix leak: closeUpstream must still run.
    openAttachMock.mockReturnValue(upstream);

    proxyToRemoteAttach(fakeApp(), browserSocket as unknown as WebSocket, "remote-host", OPTS);

    browserSocket.emit("close");

    expect(upstream.closeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not forward a browser message while the upstream is still connecting", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openAttachMock.mockReturnValue(upstream);

    proxyToRemoteAttach(fakeApp(), browserSocket as unknown as WebSocket, "remote-host", OPTS);

    browserSocket.emit("message", Buffer.from("too early"), true);
    expect(upstream.sendSpy).not.toHaveBeenCalled();
  });

  it("drops a browser message when the upstream's own send buffer is over the backpressure threshold (Hermes review, PR #34)", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openAttachMock.mockReturnValue(upstream);

    proxyToRemoteAttach(fakeApp(), browserSocket as unknown as WebSocket, "remote-host", OPTS);
    upstream.open();
    upstream.bufferedAmount = 4 * 1024 * 1024 + 1; // just over the 4MB cap

    browserSocket.emit("message", Buffer.from("overflow"), true);
    expect(upstream.sendSpy).not.toHaveBeenCalled();
  });

  it("closes the browser when the upstream errors before ever opening", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openAttachMock.mockReturnValue(upstream);

    proxyToRemoteAttach(fakeApp(), browserSocket as unknown as WebSocket, "remote-host", OPTS);
    upstream.emit("error", new Error("connection reset"));

    expect(browserSocket.closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the browser when the upstream closes before ever opening (Hermes review, PR #34)", () => {
    const browserSocket = new MockSocket();
    browserSocket.readyState = MockSocket.OPEN;
    const upstream = new MockSocket();
    openAttachMock.mockReturnValue(upstream);

    proxyToRemoteAttach(fakeApp(), browserSocket as unknown as WebSocket, "remote-host", OPTS);
    // A "close" with no preceding "error" — e.g. a clean TCP reset mid
    // handshake — must still tear down the browser side, not just the
    // "error"/"unexpected-response" cases.
    upstream.emit("close");

    expect(browserSocket.closeSpy).toHaveBeenCalledTimes(1);
  });
});

// Focused coverage for the control-socket transport specifically (PR #399
// code review): proxyToRemoteAttach only ever calls the generic
// SocketLike.close() interface method on an upstream failure — there is no
// request/response op to reply on, since sessions.attach's own success path
// deliberately sends no ack. A real SocketChannel must turn that generic
// close() into an observable signal (a wire frame plus a fired "close"
// listener), or a remote-hosted attach that fails leaves the client waiting
// forever with a permanently wedged stream id and no error ever reported.
describe("proxyToRemoteAttach against a real SocketChannel (control-socket transport, #186)", () => {
  beforeEach(() => {
    openAttachMock.mockReset();
  });

  function fakeNetSocket() {
    const lines: string[] = [];
    const socket = {
      writable: true,
      write: vi.fn((data: string, cb?: () => void) => {
        lines.push(data);
        cb?.();
      }),
    };
    return { socket: socket as unknown as net.Socket, lines };
  }

  it("an upstream error before opening closes the SocketChannel, which writes {id,type:'closed'} and fires its own close listeners", () => {
    const { socket } = fakeNetSocket();
    const channel = new SocketChannel(socket, 42);
    const onChannelClose = vi.fn();
    // Mirrors control-socket.ts's sessions.attach handler registering this
    // to clean up conn.openChannels.
    channel.on("close", onChannelClose);

    const upstream = new MockSocket();
    openAttachMock.mockReturnValue(upstream);
    proxyToRemoteAttach(fakeApp(), channel, "remote-host", OPTS);

    upstream.emit("error", new Error("connection reset"));

    expect(channel.readyState).toBe(channel.CLOSED);
    expect(onChannelClose).toHaveBeenCalledTimes(1);
  });

  it("the {id,type:'closed'} frame carries this stream's own id, distinguishing it from every other stream multiplexed on the same connection", () => {
    const { socket, lines } = fakeNetSocket();
    const channel = new SocketChannel(socket, 7);

    const upstream = new MockSocket();
    openAttachMock.mockReturnValue(upstream);
    proxyToRemoteAttach(fakeApp(), channel, "remote-host", OPTS);

    upstream.emit("close");

    const closedFrame = lines.map((line) => JSON.parse(line)).find((f) => f.type === "closed");
    expect(closedFrame).toEqual({ id: 7, type: "closed" });
  });
});
