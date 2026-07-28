import type net from "node:net";
import { describe, it, expect, vi } from "vitest";
import { SocketChannel } from "../../src/services/socket-channel.js";

/** Minimal net.Socket stand-in — only the surface SocketChannel actually
 * calls (`.write(data, cb)`). `write`'s callback fires synchronously here
 * (a real socket would defer to the next tick), which is fine for these
 * tests since none of them assert on the in-flight (not-yet-flushed) window
 * itself, only cumulative behavior across multiple sends. */
function fakeSocket(deferFlush = false) {
  const lines: string[] = [];
  const pendingCallbacks: Array<() => void> = [];
  const socket = {
    write: vi.fn((data: string, cb: () => void) => {
      lines.push(data);
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
    channel.close();
    channel.send(Buffer.from("late"));
    expect(lines).toHaveLength(0);
  });

  it("close() is idempotent — a second call doesn't re-fire close listeners", () => {
    const { socket } = fakeSocket();
    const channel = new SocketChannel(socket, 8);
    const onClose = vi.fn();
    channel.on("close", onClose);
    channel.close();
    channel.close();
    expect(onClose).toHaveBeenCalledTimes(1);
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
});
