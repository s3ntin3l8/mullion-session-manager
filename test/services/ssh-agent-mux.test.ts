import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMuxConnection,
  pipeNetSocketToChannel,
  CHANNEL_WINDOW_BYTES,
  DEFAULT_MAX_CHANNELS,
  type MuxChannel,
} from "../../src/services/ssh-agent-mux.js";

// Minimal `ws`-shaped fake — the exact subset ssh-agent-mux.ts calls:
// on("message"|"close"|"error"), readyState/OPEN/CONNECTING, send(), close(),
// terminate(). Two instances `link()`ed together deliver `send()` on one
// side as a `"message"` event on the other, synchronously — sufficient for
// this module's frame protocol, which has no notion of network latency of
// its own.
class FakeSocket {
  readyState = 1;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  peer: FakeSocket | null = null;
  sent: Buffer[] = [];
  terminated = false;
  private listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }

  send(data: Buffer): void {
    this.sent.push(data);
    this.peer?.receive(data);
  }

  receive(data: Buffer | Buffer[], isBinary = true): void {
    this.emit("message", data, isBinary);
  }

  close(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit("close");
    this.peer?.peerClosed();
  }

  peerClosed(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.close();
  }
}

function link(a: FakeSocket, b: FakeSocket): void {
  a.peer = b;
  b.peer = a;
}

function frameType(buf: Buffer): number {
  return buf.readUInt8(0);
}

// Fake `net.Socket` — just enough surface for `pipeNetSocketToChannel`:
// pause/resume, "data"/"end"/"close"/"error" emission, write() with a
// completion callback (the signal `acknowledgeConsumed` hangs off of),
// destroyed/end().
class FakeNetSocket {
  destroyed = false;
  paused = false;
  written: Buffer[] = [];
  private listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  write(chunk: Buffer, cb?: () => void): boolean {
    this.written.push(chunk);
    cb?.();
    return true;
  }

  ended = false;
  // A real `net.Socket.end()` half-closes the WRITE side (sends a local
  // FIN out) — it does not, by itself, fire this socket's own `"end"`
  // event. `"end"` is a read-side event: it fires when the OTHER side's
  // FIN has been received. Self-emitting it here would be wrong and, in
  // this test's back-to-back-piped setup, created a real infinite loop
  // (netA.end() -> "end" -> channel.eof() -> peer channel's onEof ->
  // netB.end() -> "end" -> channel.eof() -> ... back to netA forever).
  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

describe("ssh-agent-mux", () => {
  describe("channel open/data/close", () => {
    it("opens a channel and delivers data both ways", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never);
      const connB = createMuxConnection(b as never);

      let serverChannel: MuxChannel | null = null;
      connB.onChannel((ch) => {
        serverChannel = ch;
      });

      const clientChannel = await connA.openChannel();
      expect(serverChannel).not.toBeNull();

      const received: Buffer[] = [];
      serverChannel!.onData((chunk) => received.push(chunk));
      clientChannel.send(Buffer.from("ssh-agent-hello"));
      expect(received).toHaveLength(1);
      expect(received[0].toString()).toBe("ssh-agent-hello");

      const echoed: Buffer[] = [];
      clientChannel.onData((chunk) => echoed.push(chunk));
      serverChannel!.send(Buffer.from("reply"));
      expect(echoed[0].toString()).toBe("reply");
    });

    it("propagates eof() to the peer's onEof, without closing the channel", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never);
      const connB = createMuxConnection(b as never);
      let serverChannel: MuxChannel | null = null;
      connB.onChannel((ch) => (serverChannel = ch));
      const clientChannel = await connA.openChannel();

      const eofSpy = vi.fn();
      serverChannel!.onEof(eofSpy);
      clientChannel.eof();
      expect(eofSpy).toHaveBeenCalledOnce();
      expect(serverChannel!.closed).toBe(false);
    });

    it("propagates close() to the peer's onClose and marks both sides closed", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never);
      const connB = createMuxConnection(b as never);
      let serverChannel: MuxChannel | null = null;
      connB.onChannel((ch) => (serverChannel = ch));
      const clientChannel = await connA.openChannel();

      const closeSpy = vi.fn();
      serverChannel!.onClose(closeSpy);
      clientChannel.close();
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(serverChannel!.closed).toBe(true);
      expect(clientChannel.closed).toBe(true);
    });

    it("send() throws rather than exceeding the negotiated window", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never);
      createMuxConnection(b as never);
      const clientChannel = await connA.openChannel();

      expect(() => clientChannel.send(Buffer.alloc(CHANNEL_WINDOW_BYTES + 1))).toThrow(
        /exceeds channel/,
      );
    });
  });

  describe("window-based flow control", () => {
    it("exhausts the send window, then replenishes it via WINDOW_ADJUST once the peer acknowledges consumption", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never);
      const connB = createMuxConnection(b as never);
      let serverChannel: MuxChannel | null = null;
      connB.onChannel((ch) => (serverChannel = ch));
      const clientChannel = await connA.openChannel();

      // Consume the entire window in one send — exactly at the boundary
      // (equal to, not exceeding, the window) is legal.
      clientChannel.send(Buffer.alloc(CHANNEL_WINDOW_BYTES));
      expect(clientChannel.sendWindow).toBe(0);
      expect(() => clientChannel.send(Buffer.alloc(1))).toThrow(/remaining window of 0/);

      const drainSpy = vi.fn();
      clientChannel.onDrain(drainSpy);

      // Below the ack threshold: no WINDOW_ADJUST frame yet, no drain.
      const beforeSentCount = b.sent.length;
      serverChannel!.acknowledgeConsumed(CHANNEL_WINDOW_BYTES / 2 - 1);
      expect(b.sent.length).toBe(beforeSentCount);
      expect(drainSpy).not.toHaveBeenCalled();

      // Crossing the threshold sends exactly one WINDOW_ADJUST frame and
      // fires the client's onDrain.
      serverChannel!.acknowledgeConsumed(2);
      expect(b.sent.length).toBe(beforeSentCount + 1);
      expect(frameType(b.sent[b.sent.length - 1])).toBe(5); // WindowAdjust
      expect(drainSpy).toHaveBeenCalledOnce();
      expect(clientChannel.sendWindow).toBeGreaterThan(0);
    });
  });

  describe("channel cap", () => {
    it("rejects a peer-initiated OPEN past the responder's maxChannels with OpenFail", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never);
      createMuxConnection(b as never, { maxChannels: 1 });

      await connA.openChannel(); // fills the responder's one slot
      await expect(connA.openChannel()).rejects.toThrow(/peer refused channel/);
    });

    it("rejects locally without sending anything once this side's own maxChannels is reached", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { maxChannels: 1 });
      createMuxConnection(b as never);

      await connA.openChannel();
      const sentBefore = a.sent.length;
      await expect(connA.openChannel()).rejects.toThrow(/local channel cap/);
      expect(a.sent.length).toBe(sentBefore); // no Open frame was even sent
    });

    it("defaults to DEFAULT_MAX_CHANNELS when unspecified", () => {
      expect(DEFAULT_MAX_CHANNELS).toBeGreaterThan(0);
    });
  });

  describe("malformed/unknown frames", () => {
    it("drops a too-short frame and an unrecognized frame type without throwing", () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      createMuxConnection(a as never);

      expect(() => b.send(Buffer.from([1, 2, 3]))).not.toThrow(); // shorter than HEADER_BYTES
      expect(() => b.send(Buffer.from([99, 0, 0, 0, 0]))).not.toThrow(); // unrecognized type
    });

    it("ignores a non-binary (text) message — this protocol is binary-only", () => {
      const a = new FakeSocket();
      createMuxConnection(a as never);
      expect(() => a.receive(Buffer.from("not a frame"), false)).not.toThrow();
    });

    it("reassembles a fragmented message delivered as Buffer[] (`ws`'s RawData union)", () => {
      // Unlinked — this only tests that an incoming frame split across
      // multiple Buffers (as `ws` can deliver for a fragmented WS message)
      // is correctly reassembled before decoding, exercising
      // `toBuffer()`'s `Array.isArray` branch directly.
      const a = new FakeSocket();
      let opened: MuxChannel | null = null;
      createMuxConnection(a as never).onChannel((ch) => (opened = ch));

      const openFrame = Buffer.from([1, 0, 0, 0, 42]); // type=Open, channelId=42
      a.receive([openFrame.subarray(0, 2), openFrame.subarray(2)]);

      expect(opened).not.toBeNull();
      expect(opened!.id).toBe(42);
      expect(a.sent).toHaveLength(1); // the OpenAck it replied with
    });
  });

  describe("MuxConnection.close()", () => {
    it("closes every open channel, sends Close frames, and closes the socket", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never);
      const connB = createMuxConnection(b as never);
      let serverChannel: MuxChannel | null = null;
      connB.onChannel((ch) => (serverChannel = ch));
      const clientChannel = await connA.openChannel();

      connA.close();
      expect(clientChannel.closed).toBe(true);
      expect(serverChannel!.closed).toBe(true);
      expect(a.readyState).toBe(a.CLOSED);

      // Idempotent — a second call must not throw or double-fire anything.
      expect(() => connA.close()).not.toThrow();
    });
  });

  describe("connection teardown", () => {
    it("force-closes every open channel locally (without sending frames) when the socket closes", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never);
      createMuxConnection(b as never);
      const clientChannel = await connA.openChannel();
      const closeSpy = vi.fn();
      clientChannel.onClose(closeSpy);

      a.close();
      expect(clientChannel.closed).toBe(true);
      expect(closeSpy).toHaveBeenCalledOnce();
    });

    it("rejects any still-pending openChannel() when the connection closes", async () => {
      const a = new FakeSocket(); // deliberately unlinked — the Open frame goes nowhere
      const connA = createMuxConnection(a as never);
      const pending = connA.openChannel();
      a.close();
      await expect(pending).rejects.toThrow(/connection closed while channel open was pending/);
    });
  });

  describe("liveness ping/pong", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sends a PING on interval and clears the timeout when a PONG arrives", () => {
      const a = new FakeSocket();
      createMuxConnection(a as never);

      vi.advanceTimersByTime(15_000);
      expect(a.sent).toHaveLength(1);
      expect(frameType(a.sent[0])).toBe(8); // Ping

      // Peer replies with Pong (channelId 0) before the timeout elapses.
      a.receive(Buffer.from([9, 0, 0, 0, 0]));
      // Advancing well past PONG_TIMEOUT_MS must NOT terminate the
      // connection, since the pong was received in time.
      vi.advanceTimersByTime(10_000);
      expect(a.terminated).toBe(false);
    });

    it("terminates the connection if no PONG arrives within the timeout", () => {
      const a = new FakeSocket();
      const closeSpy = vi.fn();
      const conn = createMuxConnection(a as never);
      conn.onClose(closeSpy);

      vi.advanceTimersByTime(15_000); // triggers the PING
      vi.advanceTimersByTime(10_000); // PONG_TIMEOUT_MS elapses with no reply
      expect(a.terminated).toBe(true);
      expect(closeSpy).toHaveBeenCalledOnce();
    });

    it("replies to an incoming PING with a PONG", () => {
      const a = new FakeSocket();
      createMuxConnection(a as never);
      a.receive(Buffer.from([8, 0, 0, 0, 0])); // peer's Ping, channelId 0
      expect(a.sent).toHaveLength(1);
      expect(frameType(a.sent[0])).toBe(9); // Pong
    });
  });

  describe("pipeNetSocketToChannel", () => {
    it("forwards data socket -> channel -> socket in both directions", async () => {
      const wsA = new FakeSocket();
      const wsB = new FakeSocket();
      link(wsA, wsB);
      const connA = createMuxConnection(wsA as never);
      const connB = createMuxConnection(wsB as never);
      let serverChannel: MuxChannel | null = null;
      connB.onChannel((ch) => (serverChannel = ch));
      const clientChannel = await connA.openChannel();

      const netA = new FakeNetSocket();
      const netB = new FakeNetSocket();
      pipeNetSocketToChannel(netA as never, clientChannel);
      pipeNetSocketToChannel(netB as never, serverChannel!);

      netA.emit("data", Buffer.from("request"));
      expect(netB.written[0].toString()).toBe("request");

      netB.emit("data", Buffer.from("response"));
      expect(netA.written[0].toString()).toBe("response");
    });

    it("propagates net.Socket end/close/error to the channel (eof/close), and channel eof/close back to the net.Socket (end/destroy)", async () => {
      const wsA = new FakeSocket();
      const wsB = new FakeSocket();
      link(wsA, wsB);
      const connA = createMuxConnection(wsA as never);
      const connB = createMuxConnection(wsB as never);
      let serverChannel: MuxChannel | null = null;
      connB.onChannel((ch) => (serverChannel = ch));
      const clientChannel = await connA.openChannel();

      const netA = new FakeNetSocket();
      const netB = new FakeNetSocket();
      pipeNetSocketToChannel(netA as never, clientChannel);
      pipeNetSocketToChannel(netB as never, serverChannel!);

      // socket "end" (half-close) -> channel.eof(), without fully closing
      // — which the peer's own pipe turns into net.Socket.end() on netB.
      netA.emit("end");
      expect(clientChannel.closed).toBe(false);
      expect(netB.ended).toBe(true);

      // socket "close" -> channel.close(), which propagates to the peer's
      // channel.onClose -> net.Socket.destroy() on the OTHER pipe.
      netA.emit("close");
      expect(clientChannel.closed).toBe(true);
      expect(serverChannel!.closed).toBe(true);
      expect(netB.destroyed).toBe(true);
    });

    it("closes the channel when the net.Socket errors", async () => {
      const wsA = new FakeSocket();
      const wsB = new FakeSocket();
      link(wsA, wsB);
      const connA = createMuxConnection(wsA as never);
      createMuxConnection(wsB as never); // answers the Open with an OpenAck
      const clientChannel = await connA.openChannel();
      const netA = new FakeNetSocket();
      pipeNetSocketToChannel(netA as never, clientChannel);

      netA.emit("error", new Error("boom"));
      expect(clientChannel.closed).toBe(true);
    });

    it("pauses the source socket on window exhaustion and resumes with exactly one send on drain — regression: a prior version leaked one onDrain listener per overflow episode, re-sending the same stale chunk on every later, unrelated window adjustment", async () => {
      const wsA = new FakeSocket();
      const wsB = new FakeSocket();
      link(wsA, wsB);
      const connA = createMuxConnection(wsA as never);
      const connB = createMuxConnection(wsB as never);
      let serverChannel: MuxChannel | null = null;
      connB.onChannel((ch) => (serverChannel = ch));
      const clientChannel = await connA.openChannel();

      const netA = new FakeNetSocket();
      pipeNetSocketToChannel(netA as never, clientChannel);
      const dataFrameCount = () => wsA.sent.filter((f) => frameType(f) === 4).length;
      // Acknowledging <128 KB (WINDOW_ADJUST_THRESHOLD_BYTES) sends nothing
      // back — using full-window-sized acks keeps this test exercising the
      // real threshold rather than a scaled-down stand-in for it.
      const ackServer = (n: number) => serverChannel!.acknowledgeConsumed(n);

      // Exhaust the window exactly (fits, no overflow yet).
      netA.emit("data", Buffer.alloc(CHANNEL_WINDOW_BYTES));
      expect(clientChannel.sendWindow).toBe(0);
      expect(dataFrameCount()).toBe(1);

      // One more chunk now overflows: pause + queue as the single pending
      // chunk, no Data frame sent for it yet.
      netA.emit("data", Buffer.alloc(1));
      expect(netA.paused).toBe(true);
      expect(dataFrameCount()).toBe(1);

      // Replenish — the queued chunk fits, so it sends exactly once and
      // the source resumes.
      ackServer(CHANNEL_WINDOW_BYTES);
      expect(dataFrameCount()).toBe(2);
      expect(netA.paused).toBe(false);

      // A second, later, unrelated ack must NOT re-fire the same
      // (already-flushed) pending chunk — this is exactly what the fixed
      // bug used to do, since the old code registered a fresh `onDrain`
      // listener per overflow episode and never removed it.
      ackServer(CHANNEL_WINDOW_BYTES);
      expect(dataFrameCount()).toBe(2);
    });
  });
});
