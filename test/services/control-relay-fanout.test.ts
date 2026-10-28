import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";

class MockSocket extends EventEmitter {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  closeSpy = vi.fn();
  terminateSpy = vi.fn();
  send() {}
  close() {
    this.closeSpy();
    this.readyState = this.CLOSED;
    this.emit("close");
  }
  terminate() {
    this.terminateSpy();
    this.readyState = this.CLOSED;
    this.emit("close");
  }
  open() {
    this.readyState = this.OPEN;
    this.emit("open");
  }
}

const openControlRelayStreamMock = vi.fn();
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: () => ({ openControlRelayStream: openControlRelayStreamMock }),
}));
const listHostsMock = vi.fn();
vi.mock("../../src/services/host-registry.js", () => ({
  listHosts: (...args: unknown[]) => listHostsMock(...(args as [])),
}));

const { startControlRelayFanout } = await import("../../src/services/control-relay-fanout.js");

const host = (id: string, extra: Partial<{ isLocal: boolean; baseUrl: string | null }> = {}) => ({
  id,
  name: id,
  baseUrl: extra.baseUrl !== undefined ? extra.baseUrl : `http://${id}.example`,
  isLocal: extra.isLocal ?? false,
  hasToken: true,
  createdAt: new Date(0),
  origin: "manual" as const,
});

function fakeApp(): FastifyInstance {
  return { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as FastifyInstance;
}

describe("startControlRelayFanout — connection lifecycle (#1656)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    openControlRelayStreamMock.mockReset();
    listHostsMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("dials every enrolled non-local host, with or without sessions", () => {
    listHostsMock.mockReturnValue([
      host("agent-a"),
      host("local", { isLocal: true }),
      host("no-url", { baseUrl: null }),
    ]);
    openControlRelayStreamMock.mockImplementation(() => new MockSocket());
    const fanout = startControlRelayFanout(fakeApp());
    fanout.reconcile();
    expect(openControlRelayStreamMock).toHaveBeenCalledTimes(1);
    fanout.reconcile();
    expect(openControlRelayStreamMock).toHaveBeenCalledTimes(1);
    fanout.stop();
  });

  it("closes a host that is no longer enrolled and on forceReconnect", () => {
    const sockets: MockSocket[] = [];
    openControlRelayStreamMock.mockImplementation(() => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    });
    listHostsMock.mockReturnValue([host("a"), host("b")]);
    const fanout = startControlRelayFanout(fakeApp());
    fanout.reconcile();
    sockets.forEach((s) => s.open());
    listHostsMock.mockReturnValue([host("a")]);
    fanout.reconcile();
    expect(sockets[1].closeSpy).toHaveBeenCalled();
    fanout.reconcile({ forceReconnect: ["a"] });
    expect(sockets[0].closeSpy).toHaveBeenCalled();
    expect(openControlRelayStreamMock).toHaveBeenCalledTimes(3);
    fanout.stop();
  });

  it("reconnects with backoff after the socket closes, and resets after an open", () => {
    const sockets: MockSocket[] = [];
    openControlRelayStreamMock.mockImplementation(() => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    });
    listHostsMock.mockReturnValue([host("a")]);
    const fanout = startControlRelayFanout(fakeApp());
    fanout.reconcile();
    sockets[0].emit("close");
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].emit("close");
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(3);
    fanout.stop();
  });

  it("retries when the stream cannot be opened, and re-logs a failure streak", () => {
    const app = fakeApp();
    openControlRelayStreamMock.mockImplementationOnce(() => {
      throw new Error("no token");
    });
    const sockets: MockSocket[] = [];
    openControlRelayStreamMock.mockImplementation(() => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    });
    listHostsMock.mockReturnValue([host("a")]);
    const fanout = startControlRelayFanout(app);
    fanout.reconcile();
    expect(app.log.warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(1);
    for (let i = 0; i < 5; i++) sockets[0].emit("error", new Error("econnrefused"));
    // 1st and 5th of the streak are logged.
    expect(app.log.warn).toHaveBeenCalledTimes(3);
    fanout.stop();
  });

  it("terminates a connect that never opens", () => {
    const socket = new MockSocket();
    openControlRelayStreamMock.mockReturnValue(socket);
    listHostsMock.mockReturnValue([host("a")]);
    const fanout = startControlRelayFanout(fakeApp());
    fanout.reconcile();
    vi.advanceTimersByTime(10_000);
    expect(socket.terminateSpy).toHaveBeenCalled();
    fanout.stop();
  });

  it("treats a 404 upgrade as an agent without the relay and probes it only rarely", () => {
    const app = fakeApp();
    const sockets: MockSocket[] = [];
    openControlRelayStreamMock.mockImplementation(() => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    });
    listHostsMock.mockReturnValue([host("a")]);
    const fanout = startControlRelayFanout(app);
    fanout.reconcile();
    const res = { statusCode: 404, resume: vi.fn() };
    sockets[0].emit("unexpected-response", {}, res);
    expect(res.resume).toHaveBeenCalled();
    expect(app.log.info).toHaveBeenCalled();
    vi.advanceTimersByTime(9 * 60_000);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
    // Any other status is an ordinary failure, retried on the normal backoff.
    sockets[1].emit("unexpected-response", {}, { statusCode: 401, resume: vi.fn() });
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(3);
    fanout.stop();
  });

  it("does nothing after stop()", () => {
    listHostsMock.mockReturnValue([host("a")]);
    openControlRelayStreamMock.mockImplementation(() => new MockSocket());
    const fanout = startControlRelayFanout(fakeApp());
    fanout.stop();
    fanout.reconcile();
    expect(openControlRelayStreamMock).not.toHaveBeenCalled();
  });
});
