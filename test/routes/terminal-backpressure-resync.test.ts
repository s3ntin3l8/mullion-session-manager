import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { SocketLike } from "../../src/services/socket-channel.js";
import { attachSocketToSession } from "../../src/routes/terminal.js";

// Issue #1520 — after a PTY chunk is dropped for backpressure, the local
// attach path must stop forwarding, then (once the buffer drains) send a
// {type:"resync"} frame + fresh scrollback + geometry and request a redraw.

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function setup() {
  let dataCb: (chunk: string) => void = () => {};
  const session = {
    isAlive: true,
    size: { cols: 80, rows: 24 },
    getScrollback: vi.fn(() => "SCROLLBACK"),
    requestRedraw: vi.fn(),
    onData: vi.fn((cb: (chunk: string) => void) => {
      dataCb = cb;
      return () => {};
    }),
    onExit: vi.fn(() => () => {}),
    write: vi.fn(),
    resize: vi.fn(),
  };
  const app = {
    pty: { get: () => session, getOrCreate: () => session },
    log: { info: vi.fn(), warn: vi.fn() },
  } as unknown as FastifyInstance;
  const socket = new FakeSocket();
  attachSocketToSession(app, socket as unknown as SocketLike, {
    id: "1",
    cwd: "/tmp",
    command: "bash",
    cols: 80,
    rows: 24,
  });
  socket.sent.length = 0;
  session.requestRedraw.mockClear();
  session.getScrollback.mockClear();
  return { session, socket, emit: (c: string) => dataCb(c) };
}

describe("attachSocketToSession backpressure resync (issue #1520)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops under backpressure, then resyncs once the buffer drains", () => {
    const { session, socket, emit } = setup();

    socket.bufferedAmount = 5 * 1024 * 1024;
    emit("dropped");
    expect(socket.sent).toEqual([]);

    // Still dirty: even after the buffer drains, no chunk is forwarded
    // mid-stream before the resync lands.
    socket.bufferedAmount = 0;
    emit("late");
    expect(socket.sent).toEqual([]);

    vi.advanceTimersByTime(150);
    expect(socket.sent).toHaveLength(3);
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: "resync" });
    expect(socket.sent[1]).toBe("SCROLLBACK");
    expect(JSON.parse(socket.sent[2] as string).type).toBe("geometry");
    expect(session.requestRedraw).toHaveBeenCalledTimes(1);

    emit("live again");
    expect(socket.sent[3]).toBe("live again");
  });

  it("waits while the buffer is still over the drain threshold", () => {
    const { socket, emit } = setup();
    socket.bufferedAmount = 5 * 1024 * 1024;
    emit("dropped");
    vi.advanceTimersByTime(1000);
    expect(socket.sent).toEqual([]);
  });

  it("stops watching when the socket closes", () => {
    const { socket, emit } = setup();
    socket.bufferedAmount = 5 * 1024 * 1024;
    emit("dropped");
    socket.close();
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(1000);
    expect(socket.sent).toEqual([]);
  });

  it("stops watching if the socket is no longer open when the timer fires", () => {
    const { socket, emit } = setup();
    socket.bufferedAmount = 5 * 1024 * 1024;
    emit("dropped");
    socket.readyState = 3;
    vi.advanceTimersByTime(1000);
    expect(socket.sent).toEqual([]);
  });

  it("replays scrollback in place on a resync-request from a remote primary (issue #1539)", () => {
    const { session, socket } = setup();
    socket.emit("message", Buffer.from(JSON.stringify({ type: "resync-request" })), false);
    expect(socket.sent).toHaveLength(3);
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: "resync" });
    expect(socket.sent[1]).toBe("SCROLLBACK");
    expect(JSON.parse(socket.sent[2] as string).type).toBe("geometry");
    expect(session.requestRedraw).toHaveBeenCalledTimes(1);
  });

  it("ignores a resync-request while its own drain-resync is pending", () => {
    const { socket, emit } = setup();
    socket.bufferedAmount = 5 * 1024 * 1024;
    emit("dropped");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "resync-request" })), false);
    expect(socket.sent).toEqual([]);
  });
});
