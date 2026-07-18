import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";

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
});
