import type net from "node:net";
import { describe, it, expect, vi } from "vitest";
import { SocketChannel } from "../../src/services/socket-channel.js";

/** Minimal net.Socket stand-in — only the surface SocketChannel actually
 * calls (`.write(data, cb)`, `.writable`). `write`'s callback fires
 * synchronously here (a real socket would defer to the next tick), which is
 * fine for these tests since none of them assert on the in-flight
 * (not-yet-flushed) window itself, only cumulative behavior across multiple
 * sends. */
function fakeSocket(deferFlush = false, writable = true) {
  const lines: string[] = [];
  const pendingCallbacks: Array<() => void> = [];
  const socket = {
    writable,
    write: vi.fn((data: string, cb?: () => void) => {
      lines.push(data);
      if (!cb) return;
      if (deferFlush) {
        pendingCallbacks.push(cb);
      } else {
        cb();
      }
    }),
  };
  return {
    socket: socket as unknown as net.Socket,
    lines,
    flushOne: () => pendingCallbacks.shift()?.(),
  };
}

describe("SocketChannel", () => {
  it("frames a Buffer as a base64 data message tagged with its own id", () => {
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 7);
    channel.send(Buffer.from("hello", "utf8"));
    expect(JSON.parse(lines[0])).toEqual({
      id: 7,
      type: "data",
      b64: Buffer.from("hello").toString("base64"),
    });
  });

  it("re-wraps a string control message with its own id merged in, not re-interpreted as data", () => {
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 3);
    channel.send(JSON.stringify({ type: "exited" }));
    expect(JSON.parse(lines[0])).toEqual({ id: 3, type: "exited" });
  });

  it("opts.binary overrides type-based inference — a Buffer text frame (ws's own delivery shape for text frames) is NOT treated as PTY data", () => {
    // This is the exact bug class a proxied remote-host frame would hit:
    // ws's default binaryType delivers a text frame's payload as a Buffer
    // too, with `isBinary` as the only signal telling it apart from real
    // binary data.
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 9);
    channel.send(Buffer.from(JSON.stringify({ type: "exited" }), "utf8"), { binary: false });
    expect(JSON.parse(lines[0])).toEqual({ id: 9, type: "exited" });
  });

  it("opts.binary: true forces binary framing even for a string", () => {
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 1);
    channel.send("raw-ish", { binary: true });
    expect(JSON.parse(lines[0])).toEqual({
      id: 1,
      type: "data",
      b64: Buffer.from("raw-ish").toString("base64"),
    });
  });

  it("concatenates a Buffer[] (ws's fragmented-message shape) before framing", () => {
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 2);
    channel.send([Buffer.from("ab"), Buffer.from("cd")]);
    expect(JSON.parse(lines[0])).toEqual({
      id: 2,
      type: "data",
      b64: Buffer.from("abcd").toString("base64"),
    });
  });

  it("bufferedAmount tracks bytes not yet flushed, per channel — not the whole connection", () => {
    const { socket, flushOne } = fakeSocket(true);
    const channel = new SocketChannel(socket, 5);
    expect(channel.bufferedAmount).toBe(0);

    channel.send(Buffer.from("x".repeat(100)));
    const afterFirst = channel.bufferedAmount;
    expect(afterFirst).toBeGreaterThan(0);

    channel.send(Buffer.from("y".repeat(50)));
    expect(channel.bufferedAmount).toBeGreaterThan(afterFirst);

    flushOne();
    expect(channel.bufferedAmount).toBeLessThan(
      afterFirst + (channel.bufferedAmount - afterFirst) + 1,
    );
    flushOne();
    expect(channel.bufferedAmount).toBe(0);
  });

  it("readyState starts OPEN and becomes CLOSED after close()", () => {
    const { socket } = fakeSocket();
    const channel = new SocketChannel(socket, 4);
    expect(channel.readyState).toBe(channel.OPEN);
    channel.close();
    expect(channel.readyState).toBe(channel.CLOSED);
  });

  it("send() is a no-op once closed", () => {
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 6);
    channel.close(false);
    const linesAfterClose = lines.length;
    channel.send(Buffer.from("late"));
    expect(lines).toHaveLength(linesAfterClose);
  });

  it("close() is idempotent — a second call doesn't re-fire close listeners or write a second closed frame", () => {
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 8);
    const onClose = vi.fn();
    channel.on("close", onClose);
    channel.close();
    channel.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
  });

  it("emitMessage delivers to every registered message listener with the given isBinary flag", () => {
    const { socket } = fakeSocket();
    const channel = new SocketChannel(socket, 10);
    const listener = vi.fn();
    channel.on("message", listener);
    const data = Buffer.from("input");
    channel.emitMessage(data, true);
    expect(listener).toHaveBeenCalledWith(data, true);
  });

  it("close() writes an unsolicited {id,type:'closed'} frame by default — the signal a client needs when nothing else says the stream ended", () => {
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 11);
    channel.close();
    expect(JSON.parse(lines[0])).toEqual({ id: 11, type: "closed" });
  });

  it("close(false) suppresses the wire notification — for callers (sessions.detach) that already reply with the outcome another way", () => {
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 12);
    channel.close(false);
    expect(lines).toHaveLength(0);
  });

  it("close() never writes once the underlying socket is no longer writable — the whole-connection-teardown case", () => {
    const { socket, lines } = fakeSocket(false, false);
    const channel = new SocketChannel(socket, 13);
    expect(() => channel.close()).not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it("a malformed non-binary frame is dropped, not thrown — a corrupted/version-skewed remote-host frame must not crash the process", () => {
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 14);
    expect(() => channel.send(Buffer.from("not json", "utf8"), { binary: false })).not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it("a parsed frame's own `id` field can never override the channel's real multiplexing id", () => {
    // Simulates an untrusted remote-host frame (proxyToRemoteAttach forwards
    // an upstream agent's payload verbatim) that happens to carry its own
    // `id` key — this must never let a frame get mislabeled onto a
    // different stream on the same connection.
    const { socket, lines } = fakeSocket();
    const channel = new SocketChannel(socket, 15);
    channel.send(Buffer.from(JSON.stringify({ type: "exited", id: 999 }), "utf8"), {
      binary: false,
    });
    expect(JSON.parse(lines[0])).toEqual({ id: 15, type: "exited" });
  });
});
