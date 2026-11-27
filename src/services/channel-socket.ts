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
// `[flags:1][length:4 BE][payload]` messages, flags bit 0 = binary. The text /
// binary distinction survives because attach depends on it. Flow control is
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

  private queue: Buffer[] = [];
  private queuedBytes = 0;
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
    this.readyState = this.OPEN;
    this.emit("open");
    return true;
  }

  private drainMessages(): void {
    while (this.readyState === this.OPEN && this.parseBuffer.length >= FRAME_HEADER_BYTES) {
      const flags = this.parseBuffer[0]!;
      const length = this.parseBuffer.readUInt32BE(1);
      if (length > AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES) return this.failTooLarge();
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
      this.sendFailure(CHANNEL_FAILURE_TOO_LARGE, "message too large");
      return this.failTooLarge();
    }
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header[0] = isBinary ? FLAG_BINARY : 0;
    header.writeUInt32BE(payload.length, 1);
    this.enqueue(header);
    if (payload.length > 0) this.enqueue(payload);
    this.pump();
    // The peer is not draining: free the queue rather than let it grow.
    if (this.queuedBytes > AGENT_CHANNEL_MAX_BUFFERED_BYTES) this.terminate();
  }

  /** Bytes written before the stream proper (the agent's accept head). */
  sendRaw(bytes: Buffer): void {
    this.enqueue(bytes);
    this.pump();
  }

  close(): void {
    if (this.readyState === this.CLOSED) return;
    if (this.bound) this.channel.close();
    this.finish(CLOSE_NORMAL, "");
  }

  terminate(): void {
    this.close();
  }

  // --- internals --------------------------------------------------------------

  private enqueue(buf: Buffer): void {
    this.queue.push(buf);
    this.queuedBytes += buf.length;
  }

  /**
   * Tells the peer why the stream is about to die: one small message the far
   * end turns back into an error on this socket.
   *
   * It is written BEFORE the stream closes (the close carries no reason), so
   * the far end can name the cause instead of reporting a bare disconnect. It
   * rides the same queue as the data does, so a peer that is not draining
   * loses it with the rest of the stream.
   */
  private sendFailure(code: string, reason: string): void {
    const body = Buffer.from(JSON.stringify({ code, reason }), "utf8");
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header[0] = FLAG_FAILURE;
    header.writeUInt32BE(body.length, 1);
    this.enqueue(header);
    this.enqueue(body);
    this.pump();
  }

  private pump(): void {
    while (this.bound && this.queue.length > 0 && !this.channel.closed) {
      const head = this.queue[0]!;
      const n = Math.min(WRITE_CHUNK_BYTES, head.length, this.channel.sendWindow);
      if (n <= 0) return;
      this.channel.send(head.subarray(0, n));
      this.queuedBytes -= n;
      if (n === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(n);
    }
  }

  private fail(message: string): void {
    this.emitError(new Error(message));
    this.close();
  }

  /**
   * Fails the stream because a message was past the channel's per-message
   * cap. The peer knows either way: it sent the message that did not fit, or
   * it was told (see `sendFailure`).
   */
  private failTooLarge(): void {
    this.emitError(new ChannelStreamFailure(CHANNEL_FAILURE_TOO_LARGE, "message too large"));
    this.close();
  }

  private finish(code: number, reason: string): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.readyState = this.CLOSED;
    this.queue = [];
    this.queuedBytes = 0;
    this.emit("close", code, Buffer.from(reason));
  }
}
