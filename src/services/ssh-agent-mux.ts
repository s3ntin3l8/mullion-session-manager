import type net from "node:net";
import type { WebSocket as NodeWebSocket, RawData } from "ws";

// Issue #820 — the transport `/ws/agent-bridge` (laptop -> primary) and
// `/internal/ws/ssh-agent` (primary -> agent) both run over: many
// concurrent logical channels (one per accepted SSH-agent-protocol client
// connection — `ssh`, `ssh-add`, and every one of `ansible --forks=N`'s
// simultaneous connections) multiplexed onto ONE WebSocket.
//
// Deliberately NOT `pipeWsFrames` (ws-pipe.ts) or `SocketChannel`
// (socket-channel.ts):
//   - `pipeWsFrames` is exactly two sockets, one relationship, and it DROPS
//     frames once `upstream.bufferedAmount` crosses a threshold
//     (`WS_BACKPRESSURE_MAX_BUFFERED_BYTES`). That's fine for a terminal or
//     an HMR websocket, where a dropped frame is a garbled render the user
//     can refresh. It is not fine for the SSH agent wire protocol: an agent
//     message is length-prefixed and a client reads a *specific* number of
//     bytes for a *specific* reply — losing one frame doesn't garble a
//     render, it desyncs the stream for the rest of the connection's life.
//   - `SocketChannel` multiplexes many streams onto one `net.Socket` (the
//     control socket), which is the closest existing precedent for "many
//     channels, one connection" but has no flow control of its own either
//     (relies on the OS-buffered `net.Socket.write` callback per stream,
//     fine for a local IPC pipe, not for a channel that can genuinely stall
//     for seconds behind a slow/asleep laptop).
//
// So this module implements real, per-channel, credit-based flow control —
// deliberately mirroring the SSH transport protocol's own channel window
// (RFC 4254 §5.2), which is a fitting shape for a module whose entire job
// is carrying SSH agent traffic: each channel starts with a fixed receive
// window; every DATA frame the peer sends consumes window; when the local
// consumer has actually drained what it already received (not merely
// "received", but drained downstream — see `pipeNetSocketToChannel`'s
// `net.Socket.write` callback), a WINDOW_ADJUST frame replenishes it. A
// channel whose peer has exhausted its window is paused at the true
// source (the accepted `net.Socket`/named pipe), not silently dropped.

/** Initial and replenishment-threshold channel window, in bytes. Chosen
 * independently of, and much smaller than, `WS_BACKPRESSURE_MAX_BUFFERED_
 * BYTES` (4 MiB, ws-pipe.ts) — that constant bounds ONE WebSocket's total
 * buffered bytes across every multiplexed channel, whereas this bounds ONE
 * channel's own window, so the two aren't meant to match: large enough
 * that a single `ssh-add -l` round trip never blocks on a window refill,
 * small enough that one stalled channel can't buffer unbounded memory
 * while waiting for its peer.
 *
 * NOT currently enforced (Hermes review, PR #853, round 4): a channel's
 * window bounds what the PEER may send US, not what WE buffer into the
 * shared underlying WebSocket — `sendFrame` never checks
 * `socket.bufferedAmount` before calling `socket.send()`. Under a
 * genuinely stalled network with many channels simultaneously saturated
 * (an `ansible --forks=N` fan-out), up to `maxChannels * CHANNEL_
 * WINDOW_BYTES` (256 * 256 KiB ≈ 64 MiB by default) of unsent frames could
 * sit in that one WS's send buffer — bounded by these constants, so not a
 * leak, but well past `WS_BACKPRESSURE_MAX_BUFFERED_BYTES`'s own 4 MiB
 * figure despite this module's design intent. Flagged rather than fixed
 * here, per Hermes's own recommendation to revisit once PR2+ actually
 * wires this module up to a real WebSocket in routes. */
export const CHANNEL_WINDOW_BYTES = 256 * 1024;

/** A WINDOW_ADJUST is sent as soon as the consumed-since-last-adjust total
 * reaches this fraction of the window, rather than only once the window
 * hits zero — keeps a busy channel's effective throughput close to
 * `CHANNEL_WINDOW_BYTES` per round trip instead of full-stop/full-refill. */
const WINDOW_ADJUST_THRESHOLD_BYTES = CHANNEL_WINDOW_BYTES / 2;

/** Default cap on concurrently open channels per `MuxConnection`. Well
 * above any single `ansible --forks=N` fan-out in practice, but bounded so
 * a runaway or malicious peer can't open unbounded channels and exhaust
 * memory. Overridable per connection (`MuxConnectionOptions.maxChannels`). */
export const DEFAULT_MAX_CHANNELS = 256;

const PING_INTERVAL_MS = 15_000;
/** A missed PONG within this window after a PING tears the connection down
 * — mirrors the liveness contract `remote-event-subscriber.ts`'s own
 * connect-timeout enforces, just for an already-open connection rather than
 * a still-connecting one. */
const PONG_TIMEOUT_MS = 10_000;

/** A pending `openChannel()` that gets no `OpenAck`/`OpenFail` within this
 * window is rejected and its `pendingOpens` entry freed (Hermes review, PR
 * #853, round 4). Without this, a peer that stays alive for liveness PONGs
 * but silently drops (or never processes) an Open frame — dead code, a
 * bug, or deliberately hostile — permanently consumes one `maxChannels`
 * budget slot and one channel id per dropped open, with no way to recover
 * it short of tearing down the whole connection. Every OTHER
 * malicious-peer surface in this module is already bounded (inbound-id
 * collision rejected, window credit clamped, peer channel cap enforced);
 * this closes the one that wasn't. Scaled off `PONG_TIMEOUT_MS` rather
 * than an unrelated constant, since both represent "how long to wait for
 * a specific reply before assuming something's wrong." */
const OPEN_ACK_TIMEOUT_MS = PONG_TIMEOUT_MS;

const enum FrameType {
  Open = 1,
  OpenAck = 2,
  OpenFail = 3,
  Data = 4,
  WindowAdjust = 5,
  Eof = 6,
  Close = 7,
  Ping = 8,
  Pong = 9,
}

/** Wire layout, all integers big-endian:
 *   [1 byte type][4 bytes channelId]<type-specific payload>
 * Open/OpenAck/OpenFail/Eof/Close/Ping/Pong carry no payload beyond the
 * header (Ping/Pong use channelId 0, which is never a real channel id).
 * WindowAdjust: +4 bytes byteCount. Data: the remainder of the frame is the
 * raw SSH-agent-protocol bytes, unmodified — never JSON/base64-wrapped,
 * so a data frame costs exactly 5 bytes of overhead. */
const HEADER_BYTES = 5;

function encodeHeader(type: FrameType, channelId: number): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_BYTES);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(channelId, 1);
  return buf;
}

function encodeWindowAdjust(channelId: number, byteCount: number): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_BYTES + 4);
  buf.writeUInt8(FrameType.WindowAdjust, 0);
  buf.writeUInt32BE(channelId, 1);
  buf.writeUInt32BE(byteCount, 5);
  return buf;
}

function encodeData(channelId: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeHeader(FrameType.Data, channelId), payload]);
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

type ParsedFrame =
  | { type: FrameType.Open | FrameType.OpenAck | FrameType.OpenFail; channelId: number }
  | { type: FrameType.Eof | FrameType.Close; channelId: number }
  | { type: FrameType.Ping | FrameType.Pong; channelId: number }
  | { type: FrameType.WindowAdjust; channelId: number; byteCount: number }
  | { type: FrameType.Data; channelId: number; payload: Buffer };

/** Returns `null` for anything too short or of an unrecognized type — a
 * malformed frame is dropped, never thrown: this runs synchronously inside
 * the WS socket's own "message" event, so an uncaught throw here would take
 * down the whole process, not just this one connection (same reasoning as
 * `SocketChannel.send`'s JSON.parse try/catch). */
function decodeFrame(raw: Buffer): ParsedFrame | null {
  if (raw.length < HEADER_BYTES) return null;
  const type = raw.readUInt8(0) as FrameType;
  const channelId = raw.readUInt32BE(1);
  switch (type) {
    case FrameType.Open:
    case FrameType.OpenAck:
    case FrameType.OpenFail:
    case FrameType.Eof:
    case FrameType.Close:
    case FrameType.Ping:
    case FrameType.Pong:
      return { type, channelId };
    case FrameType.WindowAdjust:
      if (raw.length < HEADER_BYTES + 4) return null;
      return { type, channelId, byteCount: raw.readUInt32BE(HEADER_BYTES) };
    case FrameType.Data:
      return { type, channelId, payload: raw.subarray(HEADER_BYTES) };
    default:
      return null;
  }
}

export interface MuxChannel {
  readonly id: number;
  /** Bytes currently permitted to send before the peer's window is
   * exhausted. Send-side flow control: check before `send()`, or use the
   * `"drain"` event to resume once it's replenished. */
  readonly sendWindow: number;
  /** `true` once CLOSE has been sent or received on this channel — NOT set
   * by EOF. EOF is a half-close: `eof()`/`onEof` fire independently of
   * `closed`, and nothing here forces a channel closed just because one
   * side has EOF'd; only an explicit CLOSE does. */
  readonly closed: boolean;
  /** Sends raw bytes on this channel. Caller is responsible for respecting
   * `sendWindow`/`"drain"` — unlike `pipeWsFrames`, this module never
   * silently drops a frame that would exceed it; that's the caller's
   * backpressure signal to pause its own upstream source instead. Throws
   * if `chunk.length` would exceed the remaining `sendWindow` or the
   * channel is already closed, since sending past the negotiated window is
   * a caller bug, not a runtime condition to swallow. */
  send(chunk: Buffer): void;
  /** Signals no more data will be sent on this channel (half-close). */
  eof(): void;
  /** Fully closes this channel — idempotent, safe to call from either
   * side or after the underlying connection is already gone. */
  close(): void;
  onData(listener: (chunk: Buffer) => void): void;
  onEof(listener: () => void): void;
  onClose(listener: () => void): void;
  /** Fired when `sendWindow` grows from 0 (or grows at all after having
   * been too small for a pending write) — the resume signal for a paused
   * upstream source, mirroring `net.Socket`'s own `"drain"`. */
  onDrain(listener: () => void): void;
  /** The receive-side half of window flow control: tell the peer
   * `byteCount` bytes of what it sent have now actually been drained
   * downstream (not merely received off the wire — see
   * `pipeNetSocketToChannel`), so it may grow its `sendWindow` back. A
   * consumer that reads `onData` but never calls this will permanently
   * exhaust the peer's window after `CHANNEL_WINDOW_BYTES` of traffic. */
  acknowledgeConsumed(byteCount: number): void;
}

export interface MuxConnectionOptions {
  maxChannels?: number;
  /** Which parity this side allocates its own channel ids from — REQUIRED,
   * with no default, and the two ends of a connection must be given
   * opposite values. This is the fix for a real bug caught in review
   * (Hermes, PR #853): with both sides independently allocating from a
   * single shared id space starting at 1, two sides' simultaneous
   * `openChannel()` calls could pick the SAME id, and whichever side's
   * `OpenAck` arrived second would silently overwrite the other's
   * already-accepted inbound channel in its own `channels` map — orphaning
   * it (its `onChannel` consumer, and whatever `pipeNetSocketToChannel`
   * wired to it, would still exist but receive nothing further) while
   * misrouting the peer's Data frames onto an unrelated new channel.
   * Deliberately made required (not defaulted to e.g. `"odd"`) so this
   * can't regress by omission the way the shared-namespace bug did in the
   * first place — a caller MUST consciously assign complementary parities
   * to the two ends, typically tied to a role that already exists at the
   * call site (e.g. "odd" for the side that dials out as the WS client,
   * "even" for the side that accepts the WS connection). */
  channelIdParity: "even" | "odd";
}

export interface MuxConnection {
  /** Opens a new channel and resolves once the peer OpenAcks it. Rejects on
   * OpenFail (peer at its own channel cap, or otherwise refusing), on
   * connection close/error while pending, or if this side has hit
   * `maxChannels` locally without asking the peer at all.
   *
   * Safe to call concurrently from both peers on the same `MuxConnection`
   * (e.g. simultaneous fan-out from each end at once): the two ends'
   * self-chosen ids can never collide, because each allocates only from
   * its own configured `channelIdParity` (odd vs. even) — a structural
   * guarantee, not a caller convention. An earlier version of this module
   * shared one id namespace between both ends with no parity separation,
   * which meant two sides' simultaneous opens could pick the same id and
   * one side would silently overwrite its own already-accepted inbound
   * channel when the resulting `OpenAck` arrived, orphaning it while
   * misrouting the peer's subsequent `Data` frames onto an unrelated new
   * channel. Caught in review (Hermes) before this PR merged; fixed by the
   * parity split, not by hoping every caller happens to satisfy a
   * single-opener convention. */
  openChannel(): Promise<MuxChannel>;
  /** Fired for every peer-initiated channel this side accepts (i.e. did not
   * already reject for being at `maxChannels`) — the OpenAck has already
   * been sent by the time this fires. */
  onChannel(listener: (channel: MuxChannel) => void): void;
  /** Fired once, when the underlying WebSocket closes or a liveness
   * PING goes unanswered — after this, every open channel has already had
   * its own `onClose` fired too. */
  onClose(listener: () => void): void;
  /** Closes every open channel and the underlying WebSocket. Idempotent. */
  close(): void;
}

/**
 * Invokes a consumer-supplied listener (`onData`/`onEof`/`onClose`/
 * `onDrain`/`onChannel`), swallowing any throw. Every one of those
 * listener arrays is invoked synchronously from inside a WS `"message"`
 * event dispatch — an uncaught throw from consumer code there would
 * propagate straight out of that handler and crash the whole process,
 * taking every OTHER multiplexed channel/connection down with it (Hermes
 * review, PR #853, round 3), exactly the outcome `decodeFrame`'s own
 * "never throw from inside an event handler" rule elsewhere in this file
 * exists to prevent — that rule had only ever been applied to this
 * module's OWN parsing code, not to dispatch into caller-supplied
 * callbacks. Swallowed here, not re-thrown or logged: this module has no
 * logger dependency by design (pure primitive, no routes/auth wired up
 * yet — see the header comment), and a listener that throws is a bug in
 * the CALLER, which is responsible for noticing via its own
 * `close()`/`onClose` if that's the appropriate reaction — not something
 * this module can diagnose or recover from on the caller's behalf.
 */
function invokeListener<Args extends unknown[]>(
  listener: (...args: Args) => void,
  ...args: Args
): void {
  try {
    listener(...args);
  } catch {
    // intentionally swallowed — see doc comment above
  }
}

class ChannelImpl implements MuxChannel {
  closed = false;
  private sendWindowBytes: number;
  /** Bytes received but not yet acknowledged back to the peer via
   * WINDOW_ADJUST — see `WINDOW_ADJUST_THRESHOLD_BYTES`. */
  private unacknowledgedBytes = 0;
  private dataListeners: Array<(chunk: Buffer) => void> = [];
  private eofListeners: Array<() => void> = [];
  private closeListeners: Array<() => void> = [];
  private drainListeners: Array<() => void> = [];

  constructor(
    readonly id: number,
    // Doubles as the ceiling `handleWindowAdjust` clamps accumulated
    // `sendWindowBytes` against — see that method's own comment for why a
    // cap is needed at all.
    private readonly maxSendWindow: number,
    private readonly sendFrame: (frame: Buffer) => void,
    // Called exactly once, from `close()` only (never from
    // `closeLocally()`, which fires when the connection is already tearing
    // every channel down and clearing `channels` wholesale itself) — lets
    // the owning `createMuxConnection` prune this channel from its
    // `channels` map. Without this, a channel closed locally (the ORDINARY
    // way a channel ends: `pipeNetSocketToChannel`'s own `net.Socket`
    // "close" handler calls `channel.close()` on every normal client
    // disconnect) would stay in the map forever, permanently shrinking the
    // connection's remaining channel budget until `maxChannels` is
    // exhausted and every further open — local or peer-initiated — is
    // refused, even with zero channels genuinely open. Caught in review
    // before this PR was allowed to be the foundation for the routes/auth
    // work that build on it.
    private readonly onLocalClose: (id: number) => void,
  ) {
    this.sendWindowBytes = maxSendWindow;
  }

  get sendWindow(): number {
    return this.sendWindowBytes;
  }

  send(chunk: Buffer): void {
    if (this.closed) throw new Error(`ssh-agent-mux: send() on closed channel ${this.id}`);
    if (chunk.length > this.sendWindowBytes) {
      throw new Error(
        `ssh-agent-mux: send() of ${chunk.length} bytes exceeds channel ${this.id}'s ` +
          `remaining window of ${this.sendWindowBytes} — caller must respect sendWindow/onDrain`,
      );
    }
    this.sendWindowBytes -= chunk.length;
    this.sendFrame(encodeData(this.id, chunk));
  }

  eof(): void {
    if (this.closed) return;
    this.sendFrame(encodeHeader(FrameType.Eof, this.id));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendFrame(encodeHeader(FrameType.Close, this.id));
    this.onLocalClose(this.id);
    for (const listener of this.closeListeners) invokeListener(listener);
  }

  /** Local-close on peer/connection teardown — does NOT send a Close frame
   * (there is nowhere left to send it to). Distinct from `close()` so a
   * caller that already knows the peer is gone doesn't write to a dead or
   * closing WebSocket. */
  closeLocally(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) invokeListener(listener);
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
  }

  onEof(listener: () => void): void {
    this.eofListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  onDrain(listener: () => void): void {
    this.drainListeners.push(listener);
  }

  /** @internal — dispatch from `MuxConnectionImpl`'s frame handler only. */
  handleData(chunk: Buffer): void {
    for (const listener of this.dataListeners) invokeListener(listener, chunk);
  }

  /** @internal */
  handleEof(): void {
    for (const listener of this.eofListeners) invokeListener(listener);
  }

  /** @internal */
  handleWindowAdjust(byteCount: number): void {
    // Clamped to `maxSendWindow`, not accepted unchecked (Hermes review,
    // PR #853, round 2): an honest peer never legitimately grants more
    // cumulative outstanding credit than the window it originally offered
    // — every WindowAdjust it sends corresponds 1:1 to bytes it has
    // actually drained, so total outstanding credit can't exceed
    // `maxSendWindow` from a well-behaved peer. A corrupt or malicious
    // peer isn't bound by that, though, and nothing here previously capped
    // it: `sendWindowBytes += byteCount` with an attacker-controlled
    // `byteCount` could inflate this side's own belief about how much it's
    // allowed to send far past any real buffer size, defeating the exact
    // memory-hardening posture `CHANNEL_WINDOW_BYTES`'s own doc comment
    // describes ("small enough that one stalled channel can't buffer
    // unbounded memory") the moment something acts on the inflated value.
    this.sendWindowBytes = Math.min(this.sendWindowBytes + byteCount, this.maxSendWindow);
    // Fires unconditionally on any well-formed adjustment (Hermes review,
    // PR #853, round 1): a prior `if (wasExhausted || sendWindowBytes > 0)`
    // guard here was dead logic — a well-formed WINDOW_ADJUST always adds
    // > 0 bytes, so the window is provably > 0 afterward regardless of the
    // `wasExhausted` branch, making the condition always true. Harmless
    // (`pipeNetSocketToChannel`'s `flushPending` already no-ops when
    // there's nothing queued), just not doing what it visually claimed to.
    for (const listener of this.drainListeners) invokeListener(listener);
  }

  /** Called by the receiving side once `chunk` has actually been drained
   * downstream (see `pipeNetSocketToChannel`) — accumulates toward
   * `WINDOW_ADJUST_THRESHOLD_BYTES` and emits a WINDOW_ADJUST frame once
   * crossed. Deliberately NOT called the moment a DATA frame arrives:
   * acknowledging on receipt rather than on drain would let a channel whose
   * downstream consumer (e.g. a stalled named pipe write on the laptop)
   * can't keep up still tell the peer "send more", defeating the entire
   * point of window-based flow control. */
  acknowledgeConsumed(byteCount: number): void {
    if (this.closed) return;
    this.unacknowledgedBytes += byteCount;
    if (this.unacknowledgedBytes >= WINDOW_ADJUST_THRESHOLD_BYTES) {
      const toAcknowledge = this.unacknowledgedBytes;
      this.unacknowledgedBytes = 0;
      this.sendFrame(encodeWindowAdjust(this.id, toAcknowledge));
    }
  }
}

/**
 * Wraps an already-open `ws` WebSocket (either side — the laptop helper's
 * client connection to `/ws/agent-bridge`, or the primary's own client
 * connection to an agent's `/internal/ws/ssh-agent`) as a `MuxConnection`.
 * The two ends run the identical protocol — which side happens to be the WS
 * client vs. server is irrelevant here, that distinction is
 * `/ws/agent-bridge`/`/internal/ws/ssh-agent`'s auth/routing concern, not
 * this module's — EXCEPT for `opts.channelIdParity`, which the caller must
 * set to opposite values on the two ends (see its own doc for why).
 */
export function createMuxConnection(
  socket: NodeWebSocket,
  opts: MuxConnectionOptions,
): MuxConnection {
  const maxChannels = opts.maxChannels ?? DEFAULT_MAX_CHANNELS;
  const channels = new Map<number, ChannelImpl>();
  const pendingOpens = new Map<
    number,
    { resolve: (ch: MuxChannel) => void; reject: (err: Error) => void }
  >();
  const channelListeners: Array<(channel: MuxChannel) => void> = [];
  const closeListeners: Array<() => void> = [];
  // The two ends' allocators only ever produce disjoint ids (odd vs. even),
  // which is what actually prevents the collision described on
  // `MuxConnectionOptions.channelIdParity` — starting each side's counter
  // at a different offset and stepping by 2 (rather than, say, both
  // starting at 1 and hoping convention keeps them apart) makes the two
  // allocators structurally unable to agree on a number, not just unlikely
  // to in practice.
  const startChannelId = opts.channelIdParity === "even" ? 2 : 1;
  let nextChannelId = startChannelId;
  let closed = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  function sendFrame(frame: Buffer): void {
    // A frame produced after the socket has started closing (e.g. a
    // channel's own close() racing the connection's own teardown) is
    // simply swallowed — every channel is force-closed locally in
    // `teardown()` regardless, so there is no reply to lose.
    if (socket.readyState !== socket.OPEN) return;
    socket.send(frame);
  }

  function teardown(): void {
    if (closed) return;
    closed = true;
    if (pingTimer !== null) clearInterval(pingTimer);
    if (pongTimeoutTimer !== null) clearTimeout(pongTimeoutTimer);
    for (const { reject } of pendingOpens.values()) {
      reject(new Error("ssh-agent-mux: connection closed while channel open was pending"));
    }
    pendingOpens.clear();
    for (const channel of channels.values()) channel.closeLocally();
    channels.clear();
    for (const listener of closeListeners) invokeListener(listener);
  }

  // Removes a locally-closed channel from `channels` — see `ChannelImpl`'s
  // constructor doc for why this must exist at all (without it, every
  // ordinary, locally-initiated channel close permanently shrinks the
  // connection's remaining budget instead of freeing it back up).
  function removeChannel(id: number): void {
    channels.delete(id);
  }

  function allocateChannelId(): number {
    // Steps by 2, not 1 — stays within this side's own parity
    // (`startChannelId`'s odd/even-ness) for the connection's entire
    // lifetime, which is the actual mechanism that makes the two ends'
    // independently-chosen ids disjoint (see `channelIdParity`'s doc).
    // Wraps back to `startChannelId` rather than growing unbounded — fine
    // even for an extremely long-lived connection, since a wrapped id can
    // only collide with a still-open channel if over 2 billion channels of
    // this side's own parity were opened without ever fully draining
    // `channels`, which `maxChannels` (at most a few hundred concurrently)
    // makes unreachable in practice.
    //
    // Checks the candidate BEFORE advancing, not after — an earlier
    // version of this loop advanced unconditionally on every iteration
    // including the first, so the very first id was never actually used
    // and every allocation skipped one value. Caught in review; verified
    // the fix with five sequential allocations producing 1, 3, 5, 7, 9
    // (odd parity) rather than 3, 5, 7, 9, 11.
    let id = nextChannelId;
    while (channels.has(id) || pendingOpens.has(id)) {
      id = id >= 0xfffffffe ? startChannelId : id + 2;
    }
    nextChannelId = id >= 0xfffffffe ? startChannelId : id + 2;
    return id;
  }

  function openChannel(): Promise<MuxChannel> {
    if (closed) return Promise.reject(new Error("ssh-agent-mux: connection already closed"));
    if (channels.size + pendingOpens.size >= maxChannels) {
      return Promise.reject(new Error(`ssh-agent-mux: local channel cap (${maxChannels}) reached`));
    }
    const id = allocateChannelId();
    return new Promise<MuxChannel>((resolve, reject) => {
      // See OPEN_ACK_TIMEOUT_MS's own doc for why this exists at all.
      // Wrapping resolve/reject (rather than reading them back out of
      // `pendingOpens` from inside the timer) keeps "clear the timer" and
      // "settle the promise" atomic through every settlement path —
      // handleMessage's OpenAck/OpenFail branches, and teardown()'s own
      // bulk-reject on connection close — without each of those needing to
      // know this timer exists.
      const timeoutTimer = setTimeout(() => {
        pendingOpens.delete(id);
        reject(
          new Error(
            `ssh-agent-mux: no OpenAck/OpenFail for channel ${id} within ` +
              `${OPEN_ACK_TIMEOUT_MS}ms — peer may have dropped the Open frame`,
          ),
        );
      }, OPEN_ACK_TIMEOUT_MS);
      timeoutTimer.unref?.();
      pendingOpens.set(id, {
        resolve: (channel) => {
          clearTimeout(timeoutTimer);
          resolve(channel);
        },
        reject: (err) => {
          clearTimeout(timeoutTimer);
          reject(err);
        },
      });
      sendFrame(encodeHeader(FrameType.Open, id));
    });
  }

  function handleMessage(data: RawData, isBinary: boolean): void {
    if (!isBinary) return; // this protocol is binary-only; a stray text frame is not ours
    const frame = decodeFrame(toBuffer(data));
    if (frame === null) return;

    if (frame.type === FrameType.Ping) {
      sendFrame(encodeHeader(FrameType.Pong, 0));
      return;
    }
    if (frame.type === FrameType.Pong) {
      if (pongTimeoutTimer !== null) {
        clearTimeout(pongTimeoutTimer);
        pongTimeoutTimer = null;
      }
      return;
    }

    if (frame.type === FrameType.Open) {
      // Combined with pendingOpens, not channels.size alone (Hermes
      // review, PR #853, round 3) — symmetric with openChannel()'s own
      // local check just below, which already counts both. Without this,
      // a peer-initiated Open could push channels.size to maxChannels
      // while this side ALSO has outstanding local opens pending,
      // exceeding the connection's true combined budget until those
      // resolve.
      if (channels.size + pendingOpens.size >= maxChannels) {
        sendFrame(encodeHeader(FrameType.OpenFail, frame.channelId));
        return;
      }
      // `channelIdParity` only prevents id collisions between two HONEST
      // peers' own allocators — it says nothing about what id a peer
      // actually puts in an Open frame, which is entirely peer-chosen and
      // unvalidated (Hermes review, PR #853, round 3). A malformed or
      // malicious peer can pick any id, including one already used by an
      // existing accepted channel or one this side has an outbound open
      // pending on — without this guard, `channels.set()` below would
      // silently overwrite that entry, orphaning its consumer and
      // misrouting subsequent Data frames onto the new channel, the exact
      // failure class the parity split was introduced to prevent (just
      // reachable here via a dishonest peer instead of an honest race).
      if (channels.has(frame.channelId) || pendingOpens.has(frame.channelId)) {
        sendFrame(encodeHeader(FrameType.OpenFail, frame.channelId));
        return;
      }
      const channel = new ChannelImpl(
        frame.channelId,
        CHANNEL_WINDOW_BYTES,
        sendFrame,
        removeChannel,
      );
      channels.set(frame.channelId, channel);
      sendFrame(encodeHeader(FrameType.OpenAck, frame.channelId));
      for (const listener of channelListeners) invokeListener(listener, channel);
      return;
    }

    if (frame.type === FrameType.OpenAck) {
      const pending = pendingOpens.get(frame.channelId);
      if (pending === undefined) return; // unknown/already-resolved id — ignore, don't throw
      pendingOpens.delete(frame.channelId);
      const channel = new ChannelImpl(
        frame.channelId,
        CHANNEL_WINDOW_BYTES,
        sendFrame,
        removeChannel,
      );
      channels.set(frame.channelId, channel);
      pending.resolve(channel);
      return;
    }

    if (frame.type === FrameType.OpenFail) {
      const pending = pendingOpens.get(frame.channelId);
      if (pending === undefined) return;
      pendingOpens.delete(frame.channelId);
      pending.reject(new Error(`ssh-agent-mux: peer refused channel ${frame.channelId}`));
      return;
    }

    // Every remaining type is channel-scoped and requires an already-open
    // channel; an id that doesn't (or no longer) resolve is a frame for a
    // channel this side already closed locally — dropped, not an error,
    // since the peer's own teardown is inherently racy with this side's.
    const channel = channels.get(frame.channelId);
    if (channel === undefined) return;

    switch (frame.type) {
      case FrameType.Data:
        channel.handleData(frame.payload);
        return;
      case FrameType.WindowAdjust:
        channel.handleWindowAdjust(frame.byteCount);
        return;
      case FrameType.Eof:
        channel.handleEof();
        return;
      case FrameType.Close:
        channels.delete(frame.channelId);
        channel.closeLocally();
        return;
    }
  }

  socket.on("message", handleMessage);
  socket.on("close", teardown);
  socket.on("error", teardown);

  // Liveness: a stalled TCP connection (laptop sleep, network drop without
  // a clean FIN) can leave a WebSocket reporting OPEN indefinitely with no
  // other signal. One PING per interval; a PONG that doesn't arrive within
  // `PONG_TIMEOUT_MS` terminates the connection outright — mirroring
  // `remote-event-subscriber.ts`'s own connect-timeout-then-terminate
  // shape, just applied to an already-open connection's ongoing liveness
  // rather than its initial handshake.
  pingTimer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    sendFrame(encodeHeader(FrameType.Ping, 0));
    if (pongTimeoutTimer !== null) clearTimeout(pongTimeoutTimer);
    pongTimeoutTimer = setTimeout(() => {
      socket.terminate();
      teardown();
    }, PONG_TIMEOUT_MS);
    pongTimeoutTimer.unref?.();
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();

  return {
    openChannel,
    onChannel(listener) {
      channelListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    close() {
      if (closed) return;
      // Give every still-open channel a chance to tell its peer it's
      // closing (rather than jumping straight to closeLocally via
      // teardown) before tearing the whole connection down.
      for (const channel of channels.values()) channel.close();
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        socket.close();
      }
      teardown();
    },
  };
}

/**
 * Pipes an accepted `net.Socket` (a real client's connection to the
 * `<SESSIONS_DIR>/ssh-agent.sock` unix socket, or — on the laptop helper —
 * the socket/named-pipe connection opened *to* 1Password's own agent
 * endpoint) through a `MuxChannel`, with real two-way backpressure in both
 * directions:
 *
 *   - socket -> channel: paused (`socket.pause()`) the instant `send()`
 *     would exceed the channel's remaining `sendWindow`, resumed on
 *     `onDrain`. Never buffers unboundedly and never drops a chunk — it
 *     waits.
 *   - channel -> socket: `channel.acknowledgeConsumed()` is called from
 *     `net.Socket.write`'s own completion callback, i.e. only once the
 *     chunk has actually been accepted by the OS on this side, not merely
 *     received off the wire. A downstream `write()` that itself pushes
 *     back (returns `false`) still gets acknowledged once its callback
 *     fires — `net.Socket.write`'s callback firing IS "drained enough to
 *     accept more" by definition, so no separate `"drain"` listener is
 *     needed here.
 */
export function pipeNetSocketToChannel(socket: net.Socket, channel: MuxChannel): void {
  let socketEnded = false;
  // At most one chunk is ever "in flight" waiting on window here, because
  // `socket.pause()` below guarantees no further `"data"` events fire until
  // `socket.resume()` is called — so a single slot (rather than a queue)
  // and a single, pipe-lifetime `onDrain` listener are both sufficient.
  // (An earlier version of this function registered a fresh `onDrain`
  // listener per overflow episode and never removed it — each one kept
  // firing forever, including re-`send()`ing an already-sent chunk on a
  // later, unrelated window adjustment. Caught in review before merge.)
  //
  // A single queued chunk larger than `CHANNEL_WINDOW_BYTES` would never
  // become sendable even at a fully-replenished window, permanently
  // stalling this channel. Not reachable with a real `net.Socket`, whose
  // own internal read buffering caps a single `"data"` chunk well under
  // that (default `highWaterMark` is 64 KiB, `CHANNEL_WINDOW_BYTES` is
  // 256 KiB) — flagged here rather than defended against in code, since a
  // source that violates that would need a change to this function anyway.
  let pendingChunk: Buffer | null = null;

  function flushPending(): void {
    if (pendingChunk === null) return;
    if (channel.closed || socketEnded) {
      pendingChunk = null;
      return;
    }
    if (pendingChunk.length > channel.sendWindow) return; // still not enough room yet
    const chunk = pendingChunk;
    pendingChunk = null;
    channel.send(chunk);
    socket.resume();
  }
  channel.onDrain(flushPending);

  socket.on("data", (chunk: Buffer) => {
    if (channel.closed) return;
    // `socket.pause()` (below) is supposed to make this event impossible
    // while a chunk is already queued — a real `net.Socket` guarantees it.
    // Contained to THIS channel/socket, not thrown (Hermes review, PR
    // #853, round 2): this runs synchronously inside the socket's own
    // "data" dispatch, and `decodeFrame`'s own comment elsewhere in this
    // file establishes the rule that an uncaught throw here would crash
    // the whole process — every OTHER multiplexed channel along with it —
    // not just this one connection. An earlier version of this guard threw
    // unconditionally, contradicting that rule; closing/destroying just
    // this pair is the fix, mirroring exactly how the "error" handler
    // below already reacts to a broken source. Silently overwriting
    // `pendingChunk` instead (dropping the already-queued bytes) was
    // rejected for the same reason as always in this file — that's the
    // exact per-connection frame-dropping failure mode this module exists
    // to avoid — so "contain, don't drop and don't crash" is the only
    // remaining option for a condition that should be unreachable anyway.
    if (pendingChunk !== null) {
      // Cleared, not just left set (Hermes review, PR #853, round 4 nit):
      // harmless as-is, since the channel is closing right below and
      // `flushPending` bails out on `channel.closed` regardless — but
      // leaving a stale chunk sitting in a supposedly-closed pipe's state
      // makes this branch depend on that OTHER guard to stay safe instead
      // of being correct on its own.
      pendingChunk = null;
      if (!channel.closed) channel.close();
      if (!socket.destroyed) socket.destroy();
      return;
    }
    if (chunk.length > channel.sendWindow) {
      socket.pause();
      pendingChunk = chunk;
      return;
    }
    channel.send(chunk);
  });
  socket.on("end", () => {
    socketEnded = true;
    if (!channel.closed) channel.eof();
  });
  socket.on("close", () => {
    if (!channel.closed) channel.close();
  });
  socket.on("error", () => {
    if (!channel.closed) channel.close();
  });

  channel.onData((chunk) => {
    if (socket.destroyed) return;
    const byteLength = chunk.length;
    socket.write(chunk, () => channel.acknowledgeConsumed(byteLength));
  });
  channel.onEof(() => {
    if (!socket.destroyed) socket.end();
  });
  channel.onClose(() => {
    if (!socket.destroyed) socket.destroy();
  });
}

// A single direction of pipeChannelToChannel. Exported (in addition to
// pipeChannelToChannel itself) so ssh-agent-relay.ts can reuse this exact
// backpressure-respecting shape for the one direction that stays
// unfiltered (a real agent's reply traffic), while composing the other
// direction with SignOnlyFilter instead of calling this function directly.
// Kept separate from pipeNetSocketToChannel's own pause/resume shape
// rather than reusing it, because a MuxChannel has no `pause()`: unlike a
// `net.Socket`, WE (the receiving side) don't control whether `source`'s
// peer sends more data, only whether WE tell them they're allowed to (via
// acknowledgeConsumed). That's actually a cleaner backpressure primitive
// than pause/resume — simply withholding acknowledgeConsumed on `source`
// until `dest` can accept the data IS the backpressure signal, propagating
// all the way back to source's peer through its own window accounting —
// but it does mean `source.onData` can fire again before we've caught up
// (the peer's own remaining send window, decremented when IT sent, isn't
// contingent on our acknowledgement), so this needs a real queue, not
// pipeNetSocketToChannel's single-slot design. The queue can never exceed
// one channel-window's worth of bytes (CHANNEL_WINDOW_BYTES): `source`'s
// peer can only ever have that much outstanding-unacknowledged data by
// construction, since further sends are gated on window we deliberately
// aren't replenishing yet.
export function pipeChannelDirection(source: MuxChannel, dest: MuxChannel): void {
  const pending: Buffer[] = [];

  function flush(): void {
    while (pending.length > 0) {
      const next = pending[0];
      if (dest.closed || next.length > dest.sendWindow) return;
      pending.shift();
      dest.send(next);
      source.acknowledgeConsumed(next.length);
    }
  }

  source.onData((chunk) => {
    if (dest.closed) return;
    pending.push(chunk);
    flush();
  });
  dest.onDrain(flush);
  source.onEof(() => {
    if (!dest.closed) dest.eof();
  });
  source.onClose(() => {
    if (!dest.closed) dest.close();
  });
}

/**
 * Relays two already-open channels to each other, raw and unfiltered in
 * both directions — the "no policy" building block PR5's fan-out/relay
 * logic (ssh-agent-relay.ts) composes with `SignOnlyFilter` for the
 * direction that actually needs filtering, and uses as-is for the other
 * (a real agent's own replies, which are always relayed unfiltered — see
 * ssh-agent-filter.ts's own header comment on why). Symmetric: which
 * channel is `a` vs. `b` has no bearing on behavior.
 */
export function pipeChannelToChannel(a: MuxChannel, b: MuxChannel): void {
  pipeChannelDirection(a, b);
  pipeChannelDirection(b, a);
}
