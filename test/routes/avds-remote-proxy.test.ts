import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { WebSocket as NodeWebSocket } from "ws";
import { proxyToRemoteAvdSocket, REMOTE_AVD_OPEN_TIMEOUT_MS } from "../../src/routes/avds.js";

class MockSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly CONNECTING = MockSocket.CONNECTING;
  readonly OPEN = MockSocket.OPEN;
  readonly CLOSED = MockSocket.CLOSED;

  readyState: number = MockSocket.OPEN;
  sendSpy = vi.fn();
  closeSpy = vi.fn();

  send(data: unknown, opts?: unknown) {
    if (opts !== undefined) this.sendSpy(data, opts);
    else this.sendSpy(data);
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

function fakeApp(): FastifyInstance {
  return { log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } } as unknown as FastifyInstance;
}

describe("proxyToRemoteAvdSocket", () => {
  let browser: MockSocket;
  let upstream: MockSocket;

  beforeEach(() => {
    browser = new MockSocket();
    upstream = new MockSocket();
    upstream.readyState = MockSocket.CONNECTING;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers messages sent while upstream is CONNECTING and flushes them on open", () => {
    proxyToRemoteAvdSocket(
      fakeApp(),
      browser as unknown as WebSocket,
      "agent-1",
      () => upstream as unknown as NodeWebSocket,
    );

    browser.emit("message", Buffer.from('{"type":"accept-licenses"}'), false);
    expect(upstream.sendSpy).not.toHaveBeenCalled();

    upstream.open();
    expect(upstream.sendSpy).toHaveBeenCalledWith(Buffer.from('{"type":"accept-licenses"}'), {
      binary: false,
    });
  });

  it("sends an error frame and closes when upstream does not open before timeout", () => {
    vi.useFakeTimers();
    proxyToRemoteAvdSocket(
      fakeApp(),
      browser as unknown as WebSocket,
      "agent-1",
      () => upstream as unknown as NodeWebSocket,
    );

    vi.advanceTimersByTime(REMOTE_AVD_OPEN_TIMEOUT_MS);

    expect(browser.sendSpy).toHaveBeenCalledWith(
      JSON.stringify({ type: "error", message: "Host agent-1 did not answer in time" }),
    );
    expect(browser.closeSpy).toHaveBeenCalled();
    expect(upstream.closeSpy).toHaveBeenCalled();
  });

  it("sends an error frame and closes when openUpstream throws synchronously", () => {
    proxyToRemoteAvdSocket(fakeApp(), browser as unknown as WebSocket, "agent-1", () => {
      throw new Error("boom");
    });

    expect(browser.sendSpy).toHaveBeenCalledWith(
      JSON.stringify({ type: "error", message: "Host agent-1 is unreachable" }),
    );
    expect(browser.closeSpy).toHaveBeenCalled();
  });

  it("closes upstream if browser disconnects before upstream finishes opening", () => {
    proxyToRemoteAvdSocket(
      fakeApp(),
      browser as unknown as WebSocket,
      "agent-1",
      () => upstream as unknown as NodeWebSocket,
    );

    browser.close();
    expect(upstream.closeSpy).toHaveBeenCalled();
  });

  it("reports an outdated agent when upstream answers unexpected-response 404", () => {
    const app = fakeApp();
    proxyToRemoteAvdSocket(
      app,
      browser as unknown as WebSocket,
      "agent-1",
      () => upstream as unknown as NodeWebSocket,
    );

    const resume = vi.fn();
    upstream.emit("unexpected-response", {}, { statusCode: 404, resume });

    expect(resume).toHaveBeenCalled();
    expect(browser.sendSpy).toHaveBeenCalledWith(
      JSON.stringify({
        type: "error",
        message: "Host agent-1 does not report AVDs — update its agent.",
      }),
    );
    expect(browser.closeSpy).toHaveBeenCalled();
    expect(upstream.closeSpy).toHaveBeenCalled();
    expect(app.log.error).not.toHaveBeenCalled();
  });

  it("reports generic socket refusal when upstream answers non-404 unexpected-response", () => {
    const app = fakeApp();
    proxyToRemoteAvdSocket(
      app,
      browser as unknown as WebSocket,
      "agent-1",
      () => upstream as unknown as NodeWebSocket,
    );

    upstream.emit("unexpected-response", {}, { statusCode: 502, resume: vi.fn() });

    expect(browser.sendSpy).toHaveBeenCalledWith(
      JSON.stringify({ type: "error", message: "Host agent-1 did not accept the AVD socket" }),
    );
    expect(browser.closeSpy).toHaveBeenCalled();
    expect(upstream.closeSpy).toHaveBeenCalled();
    expect(app.log.warn).toHaveBeenCalled();
  });
});
