import { EventEmitter } from "node:events";
import type { MuxChannel } from "./ssh-agent-mux.js";
import {
  AGENT_CHANNEL_MAX_BUFFERED_BYTES,
  AGENT_CHANNEL_MAX_HEAD_BYTES,
  AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES,
  type ChannelStreamAcceptHead,
} from "../shared/agent-channel.js";

// Issue #2571 — a WebSocket-shaped view of ONE mux channel of the outbound
// agent channel. The streams that used to be primary-dialed WebSockets
// (terminal attach, events, the control relay, ssh-agent) are written against
// the `ws` surface; this carries them over the channel without touching their
// logic. Both ends use it: the primary opens a channel and waits for the
// agent's accept head (`expectHead`), the agent wraps a peer-opened channel
// whose accept head it has already queued.
//
// Wire format after the head line, in both directions: a sequence of
// `[flags:1][length:4 BE][payload]` messages. Flag bit 0 = binary (the text /
// binary distinction survives because attach depends on it); flag bit 1 = a
// FAILURE NOTICE — the payload is a small JSON `{code, reason}`, consumed by
// this transport and never handed to the stream's consumers. Flow control is
// the channel's own credit window; `bufferedAmount` is what is queued behind
// it, so a stalled link is visible to the callers' existing backpressure
// checks and is bounded (AGENT_CHANNEL_MAX_BUFFERED_BYTES) instead of growing.

const FRAME_HEADER_BYTES = 5;
const WRITE_CHUNK_BYTES = 32 * 1024;
const CLOSE_NORMAL = 1000;
const CLOSE_ABNORMAL = 1006;

/** The flags byte of one channel message: bit 0 = binary, bit 1 = a failure
 *  notice (the payload is JSON `{code, reason}`, not stream data). */
const FLAG_BINARY = 1;
const FLAG_FAILURE = 2;

/** The failure code for a message past the channel's per-message cap. */
export const CHANNEL_FAILURE_TOO_LARGE = "message-too-large";

/** How long a failure notice may wait for the peer's window before the
 *  channel closes without it. A peer that drains gives the window back in
 *  milliseconds; one that never drains must not hold the stream open for
 *  good, so the notice is given a bound and the stream ends without it. */
export const CHANNEL_FAILURE_NOTICE_TIMEOUT_MS = 5_000;

/**
 * A stream that failed for a reason the far end must hear about.
 *
 * The channel carries the reason IN BAND: a stream that cannot carry a
 * message says so with a failure notice before it dies, and the far end
 * raises this on its own socket. Without it the far end only sees the
 * stream close, and the user gets a bare disconnect instead of the reason
 * (#3402).
 */
export class ChannelStreamFailure extends Error {
  /** What failed: {@link CHANNEL_FAILURE_TOO_LARGE} for a message past the
   *  channel's per-message cap. */
  readonly code: string;

  constructor(code: string, reason: string) {
    super(reason);
    this.name = "ChannelStreamFailure";
    this.code = code;
  }
}

/** The failure a notice frame carries, or a generic one when the notice is
 *  unreadable: the stream is over either way. */
function failureFromNotice(payload: Buffer): ChannelStreamFailure {
  try {
    const parsed = JSON.parse(payload.toString("utf8")) as { code?: unknown; reason?: unknown };
    if (typeof parsed.code === "string") {
      const reason = typeof parsed.reason === "string" ? parsed.reason : parsed.code;
      return new ChannelStreamFailure(parsed.code, reason);
    }
  } catch {
    // An unreadable notice is still a failure — not a reason to keep going.
  }
  return new ChannelStreamFailure("channel-failed", "the peer failed the stream");
}

/**
 * One queued piece of the framed queue: a frame's header or its payload.
 *
 * The kind matters: the peer parses FRAMES, so anything that has to reach it
 * mid-stream — the failure notice — may only go on a frame boundary, and a
 * frame that is already half on the wire has to finish first. `written` is how
 * much of the piece is already on the wire.
 */
interface QueuedPart {
  bytes: Buffer;
  /** True for a frame's header, false for its payload. */
  header: boolean;
  written: number;
}

export type ChannelSocketData = string | Buffer | ArrayBuffer | Buffer[];

export class ChannelSocket extends EventEmitter {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState: number;
  /** Set from the accept head: this stream re-establishes one that the lost
   * channel carried before (#2571). Meaningful once "open" has fired. */
  resumed = false;

  /** True when the peer READS the failure notice (flag bit 1).
   *
   *  It is negotiated per stream, in the heads: the primary's open head says
   *  it can read one, the agent's accept head says the same back. A peer
   *  that predates the notice never sets it, so a notice is never sent to a
   *  peer that would read it as ordinary stream data (#3402). */
  notices = false;

  /** The head line (raw bytes, written before any frame). */
  private headQueue: Buffer[] = [];
  /** The framed messages, in order: each frame's header and its payload. */
  private queue: QueuedPart[] = [];
  private queuedBytes = 0;
  /** The failure notice waiting for a frame boundary (null = none). */
  private notice: Buffer | null = null;
  /** Bytes of the failure notice not yet on the wire. */
  private noticeBytes = 0;
  /** The deadline on a notice that is waiting for the peer's window. */
  private noticeTimer: NodeJS.Timeout | null = null;
  private parseBuffer: Buffer = Buffer.alloc(0);
  private headBuffer: Buffer | null;
  private closeEmitted = false;

  private channel!: MuxChannel;
  private bound = false;

  /** `expectHead`: the primary side, which opens the channel and waits for the
   * agent's accept head (CONNECTING until then). Otherwise the socket is OPEN. */
  constructor(opts: { expectHead: boolean }) {
    super();
    this.headBuffer = opts.expectHead ? Buffer.alloc(0) : null;
    this.readyState = opts.expectHead ? this.CONNECTING : this.OPEN;
  }

  /** Attaches the mux channel; split from the constructor because the primary
   * hands the socket out before `openChannel()` resolves. A socket closed in
   * the meantime closes the channel as soon as it arrives. */
  bind(channel: MuxChannel): void {
    this.channel = channel;
    this.bound = true;
    channel.onDrain(() => this.pump());
    channel.onClose(() => {
      if (this.readyState === this.CONNECTING) {
        this.emitError(new Error("outbound channel lost before the stream was accepted"));
      }
      this.finish(CLOSE_ABNORMAL, "channel closed");
    });
    if (this.readyState === this.CLOSED) channel.close();
    else this.pump();
  }

  /** The connection could not be opened at all: unreachable, not rejected. */
  failToOpen(err: Error): void {
    this.emitError(err);
    if (this.bound) this.channel.close();
    this.finish(CLOSE_ABNORMAL, err.message);
  }

  private emitError(err: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  get bufferedAmount(): number {
    return this.queuedBytes;
  }

  // --- feeding (the owner wires channel.onData / onEof to these) -------------

  ingest(chunk: Buffer): void {
    this.channel.acknowledgeConsumed(chunk.length);
    if (this.readyState === this.CLOSED) return;
    let rest = chunk;
    if (this.headBuffer !== null) {
      const nl = chunk.indexOf(0x0a);
      this.headBuffer = Buffer.concat([this.headBuffer, nl === -1 ? chunk : chunk.subarray(0, nl)]);
      if (this.headBuffer.length > AGENT_CHANNEL_MAX_HEAD_BYTES) return this.fail("head too large");
      if (nl === -1) return;
      const raw = this.headBuffer.toString("utf8");
      this.headBuffer = null;
      rest = chunk.subarray(nl + 1);
      if (!this.handleAccept(raw)) return;
    }
    if (rest.length === 0) return;
    this.parseBuffer =
      this.parseBuffer.length === 0 ? rest : Buffer.concat([this.parseBuffer, rest]);
    this.drainMessages();
  }

  /** The peer half-closed: a stream has no half-close meaning, so it ends. */
  ingestEof(): void {
    this.close();
  }

  private handleAccept(raw: string): boolean {
    let head: ChannelStreamAcceptHead;
    try {
      head = JSON.parse(raw) as ChannelStreamAcceptHead;
      if (!Number.isInteger(head.status)) throw new Error("bad status");
    } catch {
      this.fail("malformed stream accept head");
      return false;
    }
    if (head.status !== 200) {
      // The agent refused the stream: a rejection, not an unreachable host.
      this.readyState = this.CLOSING;
      const res = Object.assign(new EventEmitter(), {
        statusCode: head.status,
        statusMessage: head.message ?? "",
        resume: () => undefined,
      });
      this.emit("unexpected-response", { method: "GET" }, res);
      this.finish(CLOSE_NORMAL, head.message ?? "rejected");
      this.channel.close();
      return false;
    }
    this.resumed = head.resumed === true;
    // The agent reads the failure notice only when it advertised it (#3402).
    this.notices = head.notices === true;
    this.readyState = this.OPEN;
    this.emit("open");
    return true;
  }

  private drainMessages(): void {
    while (this.readyState === this.OPEN && this.parseBuffer.length >= FRAME_HEADER_BYTES) {
      const flags = this.parseBuffer[0]!;
      const length = this.parseBuffer.readUInt32BE(1);
      if (length > AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES) return this.failTooLarge(false);
      if (this.parseBuffer.length < FRAME_HEADER_BYTES + length) return;
      const payload = Buffer.from(
        this.parseBuffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length),
      );
      this.parseBuffer = this.parseBuffer.subarray(FRAME_HEADER_BYTES + length);
      if ((flags & FLAG_FAILURE) !== 0) {
        // The peer is telling us why the stream is over. The notice is
        // consumed here — it is never handed to the stream's consumers.
        this.emitError(failureFromNotice(payload));
        this.close();
        return;
      }
      this.emit("message", payload, (flags & FLAG_BINARY) === 1);
    }
  }

  // --- the ws surface ---------------------------------------------------------

  send(data: ChannelSocketData, opts?: { binary?: boolean }): void {
    if (this.readyState !== this.OPEN) return;
    const payload = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : typeof data === "string"
          ? Buffer.from(data, "utf8")
          : Buffer.from(data);
    const isBinary = opts?.binary ?? typeof data !== "string";
    if (payload.length > AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES) {
      // The message cannot cross the channel. Say so IN BAND first — the far
      // end names the cap for the user instead of reporting a bare
      // disconnect — and only then let the stream die (#3402).
      this.failTooLarge(true);
      return;
    }
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header[0] = isBinary ? FLAG_BINARY : 0;
    header.writeUInt32BE(payload.length, 1);
    this.enqueue({ bytes: header, header: true, written: 0 });
    if (payload.length > 0) this.enqueue({ bytes: payload, header: false, written: 0 });
    this.pump();
    // The peer is not draining: free the queue rather than let it grow.
    if (this.queuedBytes > AGENT_CHANNEL_MAX_BUFFERED_BYTES) this.terminate();
  }

  /** Bytes written before the stream proper (the agent's accept head). */
  sendRaw(bytes: Buffer): void {
    // The head has its own queue: it is what the peer parses before any
    // frame, so it must not be reordered by what follows it.
    this.headQueue.push(bytes);
    this.queuedBytes += bytes.length;
    this.pump();
  }

  close(): void {
    if (this.readyState === this.CLOSED) return;
    if (this.noticeBytes > 0) {
      // A notice is on its way: the peer must hear WHY before the stream
      // ends, so the close waits for it — bounded by the notice deadline,
      // which ends the stream either way. Without this the caller's own
      // teardown would drop the notice with the queue.
      return;
    }
    this.closeNow();
  }

  /** Ends the stream, like {@link close}. A notice that is still on its way
   *  defers the close (bounded by the notice deadline) — the peer is told
   *  WHY the stream died, which is the point of the notice. */
  terminate(): void {
    this.close();
  }

  // --- internals --------------------------------------------------------------

  /** Ends the stream now: the channel closes and the socket reports it. */
  private closeNow(): void {
    if (this.readyState === this.CLOSED) return;
    if (this.bound) this.channel.close();
    this.finish(CLOSE_NORMAL, "");
  }

  private enqueue(part: QueuedPart): void {
    this.queue.push(part);
    this.queuedBytes += part.bytes.length;
  }

  /**
   * Tells the peer why the stream is about to die: one small message the far
   * end turns back into an error on this socket.
   *
   * It is written BEFORE the stream closes (the close carries no reason), so
   * the far end can name the cause instead of reporting a bare disconnect.
   *
   * The notice is a FRAME, so it goes on a frame boundary: the peer parses
   * frames, and a notice spliced into the payload of the frame that is
   * already half on the wire would be read as that frame's data — the peer
   * would never see a frame at all, and the panel would get the bare
   * disconnect this fixes. So the notice waits for the frame in flight to
   * finish, and then goes AHEAD of the frames the peer has not started yet
   * (the queued data is worthless now — the stream is dying — and the send
   * window is normally exhausted while video streams, which is the very case
   * this is about, so a notice queued behind the backlog would never reach
   * the wire). It still goes after the head line, which the peer parses
   * first.
   */
  private queueFailureNotice(code: string, reason: string): void {
    const body = Buffer.from(JSON.stringify({ code, reason }), "utf8");
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header[0] = FLAG_FAILURE;
    header.writeUInt32BE(body.length, 1);
    const notice = Buffer.concat([header, body]);
    // NOT spliced into the queue: the pump writes it on the next frame
    // boundary, so it can never land inside a frame.
    this.notice = notice;
    this.noticeBytes = notice.length;
    this.queuedBytes += notice.length;
  }

  /**
   * The deadline on a notice that is waiting for the peer's window: a peer
   * that never drains must not hold the stream open for good.
   */
  private armNoticeDeadline(): void {
    if (this.noticeTimer) return;
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      // The peer never drained: the stream ends without the notice.
      this.closeNow();
    }, CHANNEL_FAILURE_NOTICE_TIMEOUT_MS);
    this.noticeTimer.unref?.();
  }

  /**
   * True when the wire is at a frame boundary: the peer has finished a frame
   * (or has not started one), so a frame written now is read as a frame.
   *
   * A header that is only partly on the wire, or a payload whose header is
   * already on the wire, means the peer is still INSIDE a frame: the notice
   * has to wait for that frame to finish.
   */
  private atFrameStart(): boolean {
    const part = this.queue[0];
    if (!part) return true;
    return part.header && part.written === 0;
  }

  /** Writes one chunk of the head line; false when the window is shut. */
  private writeHeadChunk(): boolean {
    const head = this.headQueue[0]!;
    const n = Math.min(WRITE_CHUNK_BYTES, head.length, this.channel.sendWindow);
    if (n <= 0) return false;
    this.channel.send(head.subarray(0, n));
    this.queuedBytes -= n;
    if (n === head.length) this.headQueue.shift();
    else this.headQueue[0] = head.subarray(n);
    return true;
  }

  /** Writes one chunk of the queued part at the head of the queue; false when
   *  the window is shut. */
  private writePartChunk(part: QueuedPart): boolean {
    const n = Math.min(
      WRITE_CHUNK_BYTES,
      part.bytes.length - part.written,
      this.channel.sendWindow,
    );
    if (n <= 0) return false;
    this.channel.send(part.bytes.subarray(part.written, part.written + n));
    part.written += n;
    this.queuedBytes -= n;
    if (part.written >= part.bytes.length) this.queue.shift();
    return true;
  }

  /** Writes one chunk of the failure notice; false when the window is shut —
   *  the notice then waits for it, bounded by the notice deadline. */
  private writeNoticeChunk(): boolean {
    const notice = this.notice!;
    const at = notice.length - this.noticeBytes;
    const n = Math.min(WRITE_CHUNK_BYTES, this.noticeBytes, this.channel.sendWindow);
    if (n <= 0) return false;
    this.channel.send(notice.subarray(at, at + n));
    this.noticeBytes -= n;
    this.queuedBytes -= n;
    if (this.noticeBytes === 0) {
      // The peer knows why the stream is over; the channel can close.
      this.close();
    }
    return true;
  }

  private pump(): void {
    while (this.bound && !this.channel.closed) {
      // The head line first: it is what the peer parses before any frame.
      if (this.headQueue.length > 0) {
        if (!this.writeHeadChunk()) return;
        continue;
      }
      // The failure notice is a frame, so it goes on a frame boundary — and
      // ahead of the frames the peer has not started yet.
      if (this.noticeBytes > 0 && this.atFrameStart()) {
        if (!this.writeNoticeChunk()) return;
        continue;
      }
      const part = this.queue[0];
      if (!part) return;
      if (!this.writePartChunk(part)) return;
    }
  }

  private fail(message: string): void {
    this.emitError(new Error(message));
    this.close();
  }

  /**
   * Fails the stream because a message was past the channel's per-message
   * cap.
   *
   * `tellPeer` says whether the peer can hear the reason: it can when it
   * advertised the failure notice in the stream's heads (a peer that predates
   * the notice would read the frame as ordinary stream data, so it is never
   * sent one). The notice goes on the next frame boundary — ahead of the
   * frames the peer has not started — and the socket stays CLOSING (later
   * data frames are dropped) until the notice is on the wire; only then does
   * the channel close. The peer knows either way: it sent the message that
   * did not fit, or it was told.
   */
  private failTooLarge(tellPeer: boolean): void {
    const failure = new ChannelStreamFailure(CHANNEL_FAILURE_TOO_LARGE, "message too large");
    if (!tellPeer || !this.notices) {
      this.emitError(failure);
      this.close();
      return;
    }
    // The notice is queued FIRST: it is what the peer needs, and it must be
    // on its way before anything can close the socket underneath it.
    this.queueFailureNotice(CHANNEL_FAILURE_TOO_LARGE, "message too large");
    this.readyState = this.CLOSING;
    this.emitError(failure);
    this.pump();
    // The window may be shut (the ordinary video state); the notice waits
    // for it, with a bound so a peer that never drains cannot hold it. Only
    // when it is still pending: the pump usually writes the whole notice and
    // closes the socket right there, and a timer on a closed socket is dead
    // state.
    if (this.noticeBytes > 0) this.armNoticeDeadline();
  }

  private finish(code: number, reason: string): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.readyState = this.CLOSED;
    this.headQueue = [];
    this.queue = [];
    this.queuedBytes = 0;
    this.notice = null;
    this.noticeBytes = 0;
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.emit("close", code, Buffer.from(reason));
  }
}
