import type net from "node:net";

// Phase 4 (#186) — a minimal WS-shaped façade over ONE multiplexed NDJSON
// stream on the control socket (src/plugins/control-socket.ts), keyed by the
// request's own `id`. Exists so `attachSocketToSession`/`proxyToRemoteAttach`
// (routes/terminal.ts) — written once against a real `@fastify/websocket`
// WebSocket — work completely unmodified against this transport too: this
// class implements exactly the subset of the WS surface those functions
// actually call, nothing more.
//
// `SocketData`/`SocketLike` live here (the concrete implementation), not in
// routes/terminal.ts (a consumer) — terminal.ts imports them from this
// module instead, so services/ never depends on routes/.
//
// Framing: a raw PTY byte chunk becomes `{id, type:"data", b64}`; any other
// `send()` call is assumed to already be a JSON-encoded control message
// (e.g. `{"type":"exited"}`, matching /ws/terminal's own vocabulary) and is
// re-wrapped with this stream's `id` merged in, not re-interpreted.

/** Same shape `ws`'s own RawData union carries — `proxyToRemoteAttach`
 * forwards an upstream frame's payload verbatim, without knowing (or
 * needing to know) which of these it actually is. */
export type SocketData = string | Buffer | ArrayBuffer | Buffer[];

/** The exact subset of `@fastify/websocket`'s WebSocket surface
 * attachSocketToSession/proxyToRemoteAttach (routes/terminal.ts) actually
 * call — generalized (rather than importing the real `WebSocket` type) so
 * this class can stand in for a real WS connection without either function
 * knowing which transport it's actually talking to. A real
 * `@fastify/websocket` socket satisfies this structurally, unchanged. */
export interface SocketLike {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: SocketData, opts?: { binary?: boolean }): void;
  close(): void;
  on(
    event: "message",
    listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void,
  ): void;
  on(event: "close", listener: () => void): void;
}

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
    // The final arm is reached for both remaining SocketData members
    // (string | ArrayBuffer) — narrowed explicitly rather than cast, since
    // `Buffer.from`'s string and ArrayBuffer overloads mean different things
    // (a plain cast to one would silently paper over which is actually
    // running for a string input).
    const asBuffer = (): Buffer =>
      Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : typeof data === "string"
            ? Buffer.from(data, "utf8")
            : Buffer.from(data);
    const isBinary =
      opts?.binary ?? (Buffer.isBuffer(data) || Array.isArray(data) || data instanceof ArrayBuffer);

    let frame: Record<string, unknown>;
    if (isBinary) {
      frame = { id: this.id, type: "data", b64: asBuffer().toString("base64") };
    } else {
      // On the remote-host proxy path (proxyToRemoteAttach), this payload is
      // forwarded verbatim from another host's agent process — an untrusted
      // boundary, not this process's own serialized control vocabulary. A
      // malformed/corrupted/version-skewed frame must be dropped, not thrown:
      // this runs synchronously inside the upstream WS's own "message" event
      // dispatch, outside dispatch()'s try/catch (control-socket.ts), so an
      // uncaught throw here would crash the whole primary process, not just
      // this one stream.
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof data === "string" ? data : asBuffer().toString("utf8"));
      } catch {
        return;
      }
      frame = {
        ...(parsed as Record<string, unknown>),
        // Applied AFTER the spread — an untrusted remote frame that happens
        // to carry its own `id` field must never override this stream's real
        // multiplexing id (it would otherwise let a remote agent mislabel a
        // frame onto an unrelated stream on this same connection).
        id: this.id,
      };
    }
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

  /**
   * Ends this one stream — detaches attachSocketToSession's listeners via
   * its own `close` handler, without touching the underlying connection or
   * any other stream multiplexed on it. Idempotent.
   *
   * `notify` (default `true`) writes an unsolicited `{id,type:"closed"}`
   * frame on this stream's own id before firing local close listeners — the
   * signal a client needs to tell "this stream ended" apart from "still
   * attaching, just quiet" when nothing else says so. This matters most for
   * `proxyToRemoteAttach` (terminal.ts): an upstream (remote-host) failure
   * calls this via the generic `SocketLike.close()` interface with no
   * opportunity to reply on the *original* `sessions.attach` request (that
   * op sends no ack at all — the scrollback frame already used the one
   * data-frame signal it gets), so without this, a dead remote stream would
   * leave the client waiting forever with silently dropped input. Callers
   * that already communicate the outcome another way — `sessions.detach`'s
   * own `{ok:true}` reply, or the whole-connection teardown (the
   * underlying `net.Socket` is already unwritable there) — pass `false` to
   * skip the redundant/no-op write. Guarded by `socket.writable` regardless,
   * so a call after the connection itself has already gone away is always
   * safe.
   */
  close(notify = true): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    if (notify && this.socket.writable) {
      this.socket.write(`${JSON.stringify({ id: this.id, type: "closed" })}\n`);
    }
    for (const listener of this.closeListeners) listener();
  }
}
