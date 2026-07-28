import type net from "node:net";
import type { SocketData } from "../routes/terminal.js";

// Phase 4 (#186) — a minimal WS-shaped façade over ONE multiplexed NDJSON
// stream on the control socket (src/plugins/control-socket.ts), keyed by the
// request's own `id`. Exists so `attachSocketToSession`/`proxyToRemoteAttach`
// (routes/terminal.ts) — written once against a real `@fastify/websocket`
// WebSocket — work completely unmodified against this transport too: this
// class implements exactly the subset of the WS surface those functions
// actually call (see terminal.ts's exported `SocketLike` interface), nothing
// more.
//
// Framing: a raw PTY byte chunk becomes `{id, type:"data", b64}`; any other
// `send()` call is assumed to already be a JSON-encoded control message
// (e.g. `{"type":"exited"}`, matching /ws/terminal's own vocabulary) and is
// re-wrapped with this stream's `id` merged in, not re-interpreted.
export class SocketChannel {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState: number = this.OPEN;

  private messageListeners: Array<(data: Buffer, isBinary: boolean) => void> = [];
  private closeListeners: Array<() => void> = [];

  // Per-channel, not per-connection: several streams can share one
  // underlying net.Socket, and net.Socket.writableLength reflects the whole
  // connection's outstanding writes, not any one stream's — using that
  // directly would let one chatty session's output throttle an unrelated
  // session multiplexed on the same connection. Tracked via write()'s own
  // completion callback (bytes actually still queued to the OS), so it's a
  // real backpressure signal for this stream alone.
  private bufferedBytes = 0;

  constructor(
    private readonly socket: net.Socket,
    private readonly id: number,
  ) {}

  get bufferedAmount(): number {
    return this.bufferedBytes;
  }

  /**
   * `opts.binary`, when explicitly given, decides binary-vs-text framing —
   * NOT `Buffer.isBuffer(data)`. This matters specifically for
   * `proxyToRemoteAttach` (terminal.ts), which forwards a remote-host WS's
   * frames verbatim: `ws`'s default `binaryType` delivers a TEXT frame's
   * payload as a Buffer too, with `isBinary` as the only signal telling the
   * two apart — keying off buffer-ness alone would base64 a remote agent's
   * `{"type":"exited"}` as if it were PTY output. When `opts` is omitted
   * (every direct `attachSocketToSession` call site), this replicates the
   * real `ws` socket's own default behavior of inferring binary-ness from
   * the argument's type, since those call sites rely on exactly that
   * inference (a raw PTY Buffer with no explicit opts).
   */
  send(data: SocketData, opts?: { binary?: boolean }): void {
    if (this.readyState !== this.OPEN) return;
    // Same RawData-narrowing shape as attachSocketToSession's own "message"
    // handler (terminal.ts) — Buffer.from() can't take the union directly.
    const asBuffer = (): Buffer =>
      Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
    const isBinary =
      opts?.binary ?? (Buffer.isBuffer(data) || Array.isArray(data) || data instanceof ArrayBuffer);
    const frame = isBinary
      ? { id: this.id, type: "data", b64: asBuffer().toString("base64") }
      : {
          id: this.id,
          ...(JSON.parse(typeof data === "string" ? data : asBuffer().toString("utf8")) as Record<
            string,
            unknown
          >),
        };
    const line = `${JSON.stringify(frame)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    this.bufferedBytes += bytes;
    this.socket.write(line, () => {
      this.bufferedBytes -= bytes;
    });
  }

  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "message" | "close", listener: (...args: never[]) => void): void {
    if (event === "message") {
      this.messageListeners.push(listener as (data: Buffer, isBinary: boolean) => void);
    } else {
      this.closeListeners.push(listener as () => void);
    }
  }

  /** Delivers a client→server frame to whatever attached
   * (attachSocketToSession's own `socket.on("message", ...)`) — called by
   * control-socket.ts's `sessions.input`/`sessions.resize` op handlers, not
   * by this class itself. */
  emitMessage(data: Buffer, isBinary: boolean): void {
    for (const listener of this.messageListeners) listener(data, isBinary);
  }

  /** Ends this one stream — detaches attachSocketToSession's listeners via
   * its own `close` handler, without touching the underlying connection or
   * any other stream multiplexed on it. Idempotent. */
  close(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    for (const listener of this.closeListeners) listener();
  }
}
