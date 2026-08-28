import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMuxConnection,
  pipeChannelToChannel,
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
    // A real `net.Socket` never emits "data" while paused — enforced here
    // (rather than left as an unchecked assumption) so a regression in
    // `pipeNetSocketToChannel`'s pause/resume handling would show up as a
    // test failure instead of silently passing, per review: this fake
    // previously let a test call `emit("data", ...)` regardless of
    // `paused`, which meant it could not have caught the exact
    // dropped-chunk bug this module exists to avoid.
    if (event === "data" && this.paused) {
      throw new Error(
        'FakeNetSocket: "data" emitted while paused — violates net.Socket\'s contract',
      );
    }
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
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(b as never, { channelIdParity: "even" });

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
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(b as never, { channelIdParity: "even" });
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
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(b as never, { channelIdParity: "even" });
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
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      createMuxConnection(b as never, { channelIdParity: "even" });
      const clientChannel = await connA.openChannel();

      expect(() => clientChannel.send(Buffer.alloc(CHANNEL_WINDOW_BYTES + 1))).toThrow(
        /exceeds channel/,
      );
    });

    it("contains a throwing consumer listener to just that dispatch — does not propagate out of handleData and crash the process (regression: Hermes review, PR #853, round 3)", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(b as never, { channelIdParity: "even" });
      let serverChannel: MuxChannel | null = null;
      connB.onChannel((ch) => (serverChannel = ch));
      const clientChannel = await connA.openChannel();

      serverChannel!.onData(() => {
        throw new Error("consumer bug");
      });
      const secondListenerCalls: Buffer[] = [];
      serverChannel!.onData((chunk) => secondListenerCalls.push(chunk));

      // The throwing listener must not prevent a LATER listener on the
      // same event from still running, and must not throw out of send()
      // itself (which is what would happen if the dispatch propagated the
      // consumer's error all the way back through the WS "message"
      // handler).
      expect(() => clientChannel.send(Buffer.from("hello"))).not.toThrow();
      expect(secondListenerCalls[0]?.toString()).toBe("hello");
    });
  });

  describe("window-based flow control", () => {
    it("exhausts the send window, then replenishes it via WINDOW_ADJUST once the peer acknowledges consumption", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(b as never, { channelIdParity: "even" });
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

    it("clamps accumulated sendWindow to the channel's original window, refusing to trust an over-large WINDOW_ADJUST from a malicious or corrupt peer (regression: Hermes review, PR #853, round 2 — sendWindowBytes += byteCount was previously accepted unchecked)", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      createMuxConnection(b as never, { channelIdParity: "even" });
      const clientChannel = await connA.openChannel();

      // A well-behaved peer would only ever grant up to CHANNEL_WINDOW_BYTES
      // of cumulative credit — this simulates one that doesn't, by
      // delivering a raw WINDOW_ADJUST frame directly (bypassing
      // acknowledgeConsumed's own honest accounting entirely) claiming an
      // absurdly large byteCount.
      const hostileAdjust = Buffer.alloc(9);
      hostileAdjust.writeUInt8(5, 0); // WindowAdjust
      hostileAdjust.writeUInt32BE(clientChannel.id, 1);
      hostileAdjust.writeUInt32BE(0xffffffff, 5);
      a.receive(hostileAdjust);

      expect(clientChannel.sendWindow).toBe(CHANNEL_WINDOW_BYTES);
      expect(() => clientChannel.send(Buffer.alloc(CHANNEL_WINDOW_BYTES))).not.toThrow();
      expect(clientChannel.sendWindow).toBe(0);
    });
  });

  describe("channel cap", () => {
    it("rejects a peer-initiated OPEN past the responder's maxChannels with OpenFail", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      createMuxConnection(b as never, { maxChannels: 1, channelIdParity: "even" });

      await connA.openChannel(); // fills the responder's one slot
      await expect(connA.openChannel()).rejects.toThrow(/peer refused channel/);
    });

    it("rejects locally without sending anything once this side's own maxChannels is reached", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { maxChannels: 1, channelIdParity: "odd" });
      createMuxConnection(b as never, { channelIdParity: "even" });

      await connA.openChannel();
      const sentBefore = a.sent.length;
      await expect(connA.openChannel()).rejects.toThrow(/local channel cap/);
      expect(a.sent.length).toBe(sentBefore); // no Open frame was even sent
    });

    it("counts pendingOpens toward the accept-side maxChannels check too, not just channels.size (regression: Hermes review, PR #853, round 3 — asymmetric with openChannel()'s own local check, which already counted both)", () => {
      const b = new FakeSocket(); // no real peer wired up — nothing ever acks this side's own open
      const connB = createMuxConnection(b as never, { maxChannels: 1, channelIdParity: "even" });

      const neverResolves = connB.openChannel(); // one outstanding LOCAL pending open (id 2, even parity)
      void neverResolves.catch(() => {});
      expect(b.sent).toHaveLength(1); // just that outbound Open frame so far

      // channels.size(0) + pendingOpens.size(1) already equals
      // maxChannels(1) — a peer-initiated Open must be refused even
      // though channels.size ALONE is still 0.
      b.receive(Buffer.from([1, 0, 0, 0, 99])); // simulated peer Open, arbitrary distinct id
      expect(b.sent).toHaveLength(2);
      expect(frameType(b.sent[1])).toBe(3); // OpenFail
    });

    it("rejects a peer-initiated OPEN whose id collides with an already-accepted channel — does not silently overwrite it (regression: Hermes review, PR #853, round 3 — channelIdParity only prevents collisions between two HONEST allocators, not an arbitrary id a dishonest peer chooses)", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(b as never, { channelIdParity: "even" });
      let firstServerChannel: MuxChannel | null = null;
      connB.onChannel((ch) => {
        firstServerChannel ??= ch;
      });
      const clientChannel = await connA.openChannel();
      expect(firstServerChannel).not.toBeNull();

      const dataOnFirst: Buffer[] = [];
      firstServerChannel!.onData((chunk) => dataOnFirst.push(chunk));

      const bSentBefore = b.sent.length;
      // A duplicate/malicious raw Open frame reusing the SAME id,
      // delivered directly — bypasses connA's own honest allocator
      // (which would never reuse a still-open id) to simulate a
      // dishonest peer choosing an arbitrary id.
      a.send(Buffer.from([1, 0, 0, 0, clientChannel.id]));
      expect(b.sent.length).toBe(bSentBefore + 1);
      expect(frameType(b.sent[b.sent.length - 1])).toBe(3); // OpenFail

      // The ORIGINAL channel must still be the live one on connB's side —
      // not silently replaced by a second ChannelImpl for the same id.
      clientChannel.send(Buffer.from("still-works"));
      expect(dataOnFirst[0]?.toString()).toBe("still-works");
    });

    it("rejects a peer-initiated OPEN whose id collides with this side's own outstanding pending open", async () => {
      const a = new FakeSocket();
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      let resolved = false;
      void connA
        .openChannel()
        .then(() => {
          resolved = true;
        })
        .catch(() => {});

      const sentBefore = a.sent.length;
      // Colliding Open, reusing the same id connA is currently awaiting
      // its own OpenAck for (its first allocation, id 1 under odd parity).
      a.receive(Buffer.from([1, 0, 0, 0, 1]));
      expect(a.sent.length).toBe(sentBefore + 1);
      expect(frameType(a.sent[a.sent.length - 1])).toBe(3); // OpenFail

      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false); // the pending local open must be untouched, not corrupted
    });

    it("defaults to DEFAULT_MAX_CHANNELS when maxChannels is unspecified", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" }); // no explicit maxChannels
      createMuxConnection(b as never, { channelIdParity: "even" }); // also default — must accept all of them as peer opens

      for (let i = 0; i < DEFAULT_MAX_CHANNELS; i++) {
        await connA.openChannel();
      }
      await expect(connA.openChannel()).rejects.toThrow(
        new RegExp(`local channel cap \\(${DEFAULT_MAX_CHANNELS}\\) reached`),
      );
    });

    it("frees its slot back up when a channel is closed locally, so the connection doesn't permanently exhaust maxChannels through ordinary use (regression: an earlier version never removed a locally-closed channel from the connection's tracking map)", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { maxChannels: 3, channelIdParity: "odd" });
      createMuxConnection(b as never, { maxChannels: 3, channelIdParity: "even" });

      // Open-and-close, one at a time, well under the cap each time — the
      // ordinary lifecycle every real `ssh`/`ssh-add`/ansible-fork
      // connection goes through via `pipeNetSocketToChannel`'s own
      // net.Socket "close" handler.
      for (let i = 0; i < 10; i++) {
        const channel = await connA.openChannel();
        channel.close();
      }

      // If closed channels were never freed, the 4th cumulative open would
      // already have failed — this proves the budget doesn't deplete.
      const stillOpen = await connA.openChannel();
      expect(stillOpen.closed).toBe(false);
    });
  });

  describe("malformed/unknown frames", () => {
    it("drops a too-short frame and an unrecognized frame type without throwing", () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      createMuxConnection(a as never, { channelIdParity: "odd" });

      expect(() => b.send(Buffer.from([1, 2, 3]))).not.toThrow(); // shorter than HEADER_BYTES
      expect(() => b.send(Buffer.from([99, 0, 0, 0, 0]))).not.toThrow(); // unrecognized type
    });

    it("ignores a non-binary (text) message — this protocol is binary-only", () => {
      const a = new FakeSocket();
      createMuxConnection(a as never, { channelIdParity: "odd" });
      expect(() => a.receive(Buffer.from("not a frame"), false)).not.toThrow();
    });

    it("reassembles a fragmented message delivered as Buffer[] (`ws`'s RawData union)", () => {
      // Unlinked — this only tests that an incoming frame split across
      // multiple Buffers (as `ws` can deliver for a fragmented WS message)
      // is correctly reassembled before decoding, exercising
      // `toBuffer()`'s `Array.isArray` branch directly.
      const a = new FakeSocket();
      let opened: MuxChannel | null = null;
      createMuxConnection(a as never, { channelIdParity: "odd" }).onChannel((ch) => (opened = ch));

      const openFrame = Buffer.from([1, 0, 0, 0, 42]); // type=Open, channelId=42
      a.receive([openFrame.subarray(0, 2), openFrame.subarray(2)]);

      expect(opened).not.toBeNull();
      expect(opened!.id).toBe(42);
      expect(a.sent).toHaveLength(1); // the OpenAck it replied with
    });
  });

  describe("concurrent bidirectional opens", () => {
    it("never collides on ids when both peers call openChannel() before either side's OpenAck has arrived (regression: Hermes review, PR #853 — a shared, non-parity-separated id space let two simultaneous opens pick the same id, silently overwriting one side's already-accepted inbound channel)", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(b as never, { channelIdParity: "even" });

      const aInbound: MuxChannel[] = [];
      const bInbound: MuxChannel[] = [];
      connA.onChannel((ch) => aInbound.push(ch));
      connB.onChannel((ch) => bInbound.push(ch));

      // Both sides open a channel "at the same time" — with these fakes'
      // synchronous delivery, each openChannel() call fully round-trips
      // (Open -> OpenAck) before the next line runs, but each side's
      // allocator was seeded independently at construction time (both
      // would start at id 1 under the pre-fix scheme), which is exactly
      // the condition that used to collide.
      const fromA = await connA.openChannel();
      const fromB = await connB.openChannel();

      // Every channel — both self-opened and peer-accepted, on both
      // sides — must be distinct objects with distinct ids. Under the old
      // bug, `fromA`'s id (1) would equal the id `connB`'s independent
      // allocator (also starting at 1) picked for `fromB`, and one of
      // the two connections would have silently overwritten an entry in
      // its own `channels` map.
      expect(fromA.id).not.toBe(fromB.id);
      expect(aInbound).toHaveLength(1); // A accepted B's inbound open
      expect(bInbound).toHaveLength(1); // B accepted A's inbound open
      expect(aInbound[0].id).toBe(fromB.id);
      expect(bInbound[0].id).toBe(fromA.id);

      // Both channels actually work — data sent on one is NOT silently
      // swallowed by an orphaned/overwritten channel object.
      const receivedOnB: Buffer[] = [];
      bInbound[0].onData((chunk) => receivedOnB.push(chunk));
      fromA.send(Buffer.from("via-a"));
      expect(receivedOnB[0]?.toString()).toBe("via-a");

      const receivedOnA: Buffer[] = [];
      aInbound[0].onData((chunk) => receivedOnA.push(chunk));
      fromB.send(Buffer.from("via-b"));
      expect(receivedOnA[0]?.toString()).toBe("via-b");
    });

    it("allocates strictly odd ids on one side and strictly even ids on the other, never overlapping across many allocations", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(b as never, { channelIdParity: "even" });

      const idsFromA: number[] = [];
      for (let i = 0; i < 5; i++) {
        idsFromA.push((await connA.openChannel()).id);
      }
      const idsFromB: number[] = [];
      for (let i = 0; i < 5; i++) {
        idsFromB.push((await connB.openChannel()).id);
      }

      expect(idsFromA.every((id) => id % 2 === 1)).toBe(true);
      expect(idsFromB.every((id) => id % 2 === 0)).toBe(true);
      expect(idsFromA).toEqual([1, 3, 5, 7, 9]);
      expect(idsFromB).toEqual([2, 4, 6, 8, 10]);
    });
  });

  describe("MuxConnection.close()", () => {
    it("closes every open channel, sends Close frames, and closes the socket", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(b as never, { channelIdParity: "even" });
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
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      createMuxConnection(b as never, { channelIdParity: "even" });
      const clientChannel = await connA.openChannel();
      const closeSpy = vi.fn();
      clientChannel.onClose(closeSpy);

      a.close();
      expect(clientChannel.closed).toBe(true);
      expect(closeSpy).toHaveBeenCalledOnce();
    });

    it("rejects any still-pending openChannel() when the connection closes", async () => {
      const a = new FakeSocket(); // deliberately unlinked — the Open frame goes nowhere
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      const pending = connA.openChannel();
      a.close();
      await expect(pending).rejects.toThrow(/connection closed while channel open was pending/);
    });
  });

  describe("openChannel() ack timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects a pending open that never gets an OpenAck/OpenFail, and frees its budget slot for a later open (regression: Hermes review, PR #853, round 4 — a peer that silently drops an Open frame used to leak one maxChannels slot and one channel id forever)", async () => {
      const a = new FakeSocket(); // deliberately unlinked — simulates a peer that drops the Open frame
      const connA = createMuxConnection(a as never, { maxChannels: 1, channelIdParity: "odd" });

      const pending = connA.openChannel();
      let rejected: Error | null = null;
      pending.catch((err: Error) => {
        rejected = err;
      });

      vi.advanceTimersByTime(10_000); // OPEN_ACK_TIMEOUT_MS
      await Promise.resolve();
      await Promise.resolve();

      expect(rejected).not.toBeNull();
      expect(rejected!.message).toMatch(/no OpenAck\/OpenFail for channel .* within 10000ms/);

      // The budget slot must be genuinely freed — with maxChannels: 1,
      // this would still be rejected with "local channel cap" if the
      // timed-out entry were still counted. `a` stays unlinked, so this
      // second open never resolves either — only its own IMMEDIATE,
      // synchronous rejection path (the local-cap check) is under test
      // here, not its eventual outcome.
      const secondOpen = connA.openChannel();
      let secondRejectedReason: string | null = null;
      secondOpen.catch((err: Error) => {
        secondRejectedReason = err.message;
      });
      await Promise.resolve();
      await Promise.resolve();
      // Either still genuinely pending (null — the expected outcome) or,
      // if it did reject, not for "local channel cap" specifically.
      expect(
        secondRejectedReason === null || !secondRejectedReason.includes("local channel cap"),
      ).toBe(true);
    });

    it("does not fire the timeout once a real OpenAck arrives in time", async () => {
      const a = new FakeSocket();
      const b = new FakeSocket();
      link(a, b);
      const connA = createMuxConnection(a as never, { channelIdParity: "odd" });
      createMuxConnection(b as never, { channelIdParity: "even" });

      const pending = connA.openChannel(); // resolves synchronously via the linked FakeSocket
      await expect(pending).resolves.toBeTruthy();

      // Advancing well past the timeout afterward must be a no-op — the
      // timer should already have been cleared on resolution.
      expect(() => vi.advanceTimersByTime(20_000)).not.toThrow();
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
      createMuxConnection(a as never, { channelIdParity: "odd" });

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
      const conn = createMuxConnection(a as never, { channelIdParity: "odd" });
      conn.onClose(closeSpy);

      vi.advanceTimersByTime(15_000); // triggers the PING
      vi.advanceTimersByTime(10_000); // PONG_TIMEOUT_MS elapses with no reply
      expect(a.terminated).toBe(true);
      expect(closeSpy).toHaveBeenCalledOnce();
    });

    it("replies to an incoming PING with a PONG", () => {
      const a = new FakeSocket();
      createMuxConnection(a as never, { channelIdParity: "odd" });
      a.receive(Buffer.from([8, 0, 0, 0, 0])); // peer's Ping, channelId 0
      expect(a.sent).toHaveLength(1);
      expect(frameType(a.sent[0])).toBe(9); // Pong
    });
  });

  describe("pipeChannelToChannel", () => {
    // Two independent mux connections (X<->Y, P<->Q), each with one open
    // channel. pipeChannelToChannel(chanY, chanP) simulates a relay hop
    // (e.g. an agent-originated channel piped to a bridge-helper-facing
    // channel): whatever chanX sends arrives at chanY and gets relayed to
    // chanP -> chanQ, and vice versa.
    async function setupRelay() {
      const wsX = new FakeSocket();
      const wsY = new FakeSocket();
      link(wsX, wsY);
      const connX = createMuxConnection(wsX as never, { channelIdParity: "odd" });
      const connY = createMuxConnection(wsY as never, { channelIdParity: "even" });
      let chanY: MuxChannel | null = null;
      connY.onChannel((ch) => (chanY = ch));
      const chanX = await connX.openChannel();

      const wsP = new FakeSocket();
      const wsQ = new FakeSocket();
      link(wsP, wsQ);
      const connP = createMuxConnection(wsP as never, { channelIdParity: "odd" });
      const connQ = createMuxConnection(wsQ as never, { channelIdParity: "even" });
      let chanQ: MuxChannel | null = null;
      connQ.onChannel((ch) => (chanQ = ch));
      const chanP = await connP.openChannel();

      pipeChannelToChannel(chanY!, chanP);
      return { chanX, chanY: chanY!, chanP, chanQ: chanQ! };
    }

    it("relays data in both directions across the two hops", async () => {
      const { chanX, chanQ } = await setupRelay();

      const atQ: Buffer[] = [];
      chanQ.onData((chunk) => atQ.push(chunk));
      chanX.send(Buffer.from("request"));
      expect(atQ[0]?.toString()).toBe("request");

      const atX: Buffer[] = [];
      chanX.onData((chunk) => atX.push(chunk));
      chanQ.send(Buffer.from("response"));
      expect(atX[0]?.toString()).toBe("response");
    });

    it("propagates eof() across both hops without closing", async () => {
      const { chanX, chanQ } = await setupRelay();
      const eofSpy = vi.fn();
      chanQ.onEof(eofSpy);
      chanX.eof();
      expect(eofSpy).toHaveBeenCalledOnce();
      expect(chanQ.closed).toBe(false);
    });

    it("propagates close() across both hops", async () => {
      const { chanX, chanQ } = await setupRelay();
      const closeSpy = vi.fn();
      chanQ.onClose(closeSpy);
      chanX.close();
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(chanQ.closed).toBe(true);
    });

    it("respects the destination channel's backpressure — queues rather than exceeding sendWindow, and delivers everything once drained", async () => {
      const { chanX, chanP, chanQ } = await setupRelay();
      const atQ: Buffer[] = [];
      chanQ.onData((chunk) => atQ.push(chunk));

      // A first full-window chunk fits chanP's window exactly, so the
      // relay forwards it onward in the very same synchronous call and
      // immediately acknowledges chanY for it — crossing
      // WINDOW_ADJUST_THRESHOLD_BYTES right away, which replenishes
      // chanX's window before this call even returns. It's chanP's window
      // (not chanX's) that's left exhausted afterward.
      const chunk1 = Buffer.alloc(CHANNEL_WINDOW_BYTES, 1);
      chanX.send(chunk1);
      expect(chanP.sendWindow).toBe(0);
      expect(chanX.sendWindow).toBeGreaterThan(0);

      // A second full-window chunk exhausts chanX's window again — but
      // this time the relay can't forward it onward (chanP has no room
      // left), so it queues internally without acknowledging chanY, and
      // chanX's window stays exhausted this time.
      const chunk2 = Buffer.alloc(CHANNEL_WINDOW_BYTES, 2);
      chanX.send(chunk2);
      expect(chanX.sendWindow).toBe(0);
      expect(() => chanX.send(Buffer.alloc(1))).toThrow(/remaining window/);

      // Q "catches up" on chunk1 — flowing a WINDOW_ADJUST back to chanP,
      // whose onDrain flushes the queued chunk2 onward, which in turn
      // acknowledges chanY and flows a WINDOW_ADJUST back to chanX.
      chanQ.acknowledgeConsumed(CHANNEL_WINDOW_BYTES);
      expect(chanX.sendWindow).toBeGreaterThan(0);

      // Q catches up on chunk2 too, so chanP's window is fully free again
      // and a further send actually reaches Q instead of queuing behind
      // chunk2.
      chanQ.acknowledgeConsumed(CHANNEL_WINDOW_BYTES);

      chanX.send(Buffer.from("more"));
      const totalBytes = atQ.reduce((sum, chunk) => sum + chunk.length, 0);
      expect(totalBytes).toBe(2 * CHANNEL_WINDOW_BYTES + 4);
      expect(atQ.at(-1)?.toString()).toBe("more");
    });
  });

  describe("pipeNetSocketToChannel", () => {
    it("forwards data socket -> channel -> socket in both directions", async () => {
      const wsA = new FakeSocket();
      const wsB = new FakeSocket();
      link(wsA, wsB);
      const connA = createMuxConnection(wsA as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(wsB as never, { channelIdParity: "even" });
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

    it("contains a socket that violates the pause() contract to just its own channel — closes that channel/socket, does NOT throw (regression: Hermes review, PR #853, round 2 — an earlier version threw here, which would have crashed the whole process and every OTHER multiplexed channel with it)", async () => {
      const wsA = new FakeSocket();
      const wsB = new FakeSocket();
      link(wsA, wsB);
      const connA = createMuxConnection(wsA as never, { channelIdParity: "odd" });
      createMuxConnection(wsB as never, { channelIdParity: "even" });
      const clientChannel = await connA.openChannel();

      // Deliberately does NOT honor pause() — unlike FakeNetSocket, which
      // now enforces that contract and so can't be used to exercise a
      // violation of it. Simulates a non-conforming data source.
      const misbehaving = {
        destroyed: false,
        listeners: new Map<string, Array<(...args: never[]) => void>>(),
        on(event: string, listener: (...args: never[]) => void) {
          const arr = this.listeners.get(event) ?? [];
          arr.push(listener);
          this.listeners.set(event, arr);
          return this;
        },
        emit(event: string, ...args: unknown[]) {
          for (const l of this.listeners.get(event) ?? [])
            (l as (...a: unknown[]) => void)(...args);
        },
        pause() {},
        resume() {},
        write() {
          return true;
        },
        end() {},
        destroy() {
          this.destroyed = true;
        },
      };
      pipeNetSocketToChannel(misbehaving as never, clientChannel);

      misbehaving.emit("data", Buffer.alloc(CHANNEL_WINDOW_BYTES)); // exhausts the window, no overflow yet
      expect(() => misbehaving.emit("data", Buffer.alloc(1))).not.toThrow(); // overflow #1 — queued
      expect(() => misbehaving.emit("data", Buffer.alloc(1))).not.toThrow(); // overflow #2 while still queued — the violation

      expect(clientChannel.closed).toBe(true);
      expect(misbehaving.destroyed).toBe(true);
    });

    it("acknowledges consumption via the real net.Socket.write() completion callback, not merely on receipt — driving an actual WINDOW_ADJUST end to end through the pipe, with no manual acknowledgeConsumed() call", async () => {
      const wsA = new FakeSocket();
      const wsB = new FakeSocket();
      link(wsA, wsB);
      const connA = createMuxConnection(wsA as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(wsB as never, { channelIdParity: "even" });
      let serverChannel: MuxChannel | null = null;
      connB.onChannel((ch) => (serverChannel = ch));
      const clientChannel = await connA.openChannel();

      const netA = new FakeNetSocket();
      const netB = new FakeNetSocket();
      pipeNetSocketToChannel(netA as never, clientChannel);
      pipeNetSocketToChannel(netB as never, serverChannel!);

      // Push a full window's worth of data through the real pipe (no
      // direct channel.send() or acknowledgeConsumed() calls anywhere in
      // this test). FakeNetSocket.write() invokes its completion callback
      // synchronously (mirroring a real net.Socket write that completes
      // without backpressure), so the entire round trip — send, receive,
      // write-to-netB, acknowledgeConsumed, WINDOW_ADJUST, replenish A's
      // window — happens within this single emit() call; there is no
      // separately observable "window is exactly 0" moment to assert on.
      netA.emit("data", Buffer.alloc(CHANNEL_WINDOW_BYTES));
      expect(netB.written[0].length).toBe(CHANNEL_WINDOW_BYTES);

      // If the ack wiring were missing (e.g. acknowledging on receipt
      // instead of on write-drain, or not wired at all), A's window would
      // have stayed at 0 and no WINDOW_ADJUST would have been sent.
      expect(frameType(wsB.sent[wsB.sent.length - 1])).toBe(5); // WindowAdjust
      expect(clientChannel.sendWindow).toBeGreaterThan(0);
    });

    it("propagates net.Socket end/close/error to the channel (eof/close), and channel eof/close back to the net.Socket (end/destroy)", async () => {
      const wsA = new FakeSocket();
      const wsB = new FakeSocket();
      link(wsA, wsB);
      const connA = createMuxConnection(wsA as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(wsB as never, { channelIdParity: "even" });
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
      const connA = createMuxConnection(wsA as never, { channelIdParity: "odd" });
      createMuxConnection(wsB as never, { channelIdParity: "even" }); // answers the Open with an OpenAck
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
      const connA = createMuxConnection(wsA as never, { channelIdParity: "odd" });
      const connB = createMuxConnection(wsB as never, { channelIdParity: "even" });
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
