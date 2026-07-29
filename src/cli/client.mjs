import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// Phase 4 (#134, PR6) — the transport behind every `mullion` subcommand
// except `notify` (which speaks the hook socket directly, see core.mjs) and
// `mcp` (which execs dist/mcp/server.mjs as a separate process). Wire
// protocol is docs/socket-api.md's: NDJSON, line 1 is the handshake
// (`{"token":...}` or `{}`), every following line is either a request
// (`{id,op,body}`) answered by exactly one `{id,ok,status,result|error}`
// reply, or — for `sessions.attach`/`events.subscribe` — a multiplexed
// stream where additional `{id,type:...}` frames arrive unsolicited on the
// same `id` until the stream ends.

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Discovery order from the plan: an explicit override, then the sibling of
 * the hook socket in this process's own SESSIONS_DIR (set for every spawned
 * session), then the same XDG state-dir fallback hooks.ts/pty-manager.ts use
 * when SESSIONS_DIR is unset entirely (a bare operator shell outside any
 * session, e.g. from a systemd --user install with the default data dir). */
export function resolveSocketPath(env = process.env) {
  if (typeof env.MULLION_SOCKET_PATH === "string" && env.MULLION_SOCKET_PATH.length > 0) {
    return env.MULLION_SOCKET_PATH;
  }
  if (typeof env.SESSIONS_DIR === "string" && env.SESSIONS_DIR.length > 0) {
    return path.join(env.SESSIONS_DIR, "mullion.sock");
  }
  return path.join(os.homedir(), ".local", "state", "mullion", "sessions", "mullion.sock");
}

/** MULLION_AUTH_TOKEN (the operator's own credential, full scope) takes
 * priority over MULLION_HOOK_TOKEN (session scope) when both happen to be
 * set — in the common case they're mutually exclusive anyway, since
 * session-env.ts strips MULLION_AUTH_TOKEN from every spawned session's env.
 * Returns `{token, source}` rather than a bare string so `mullion config`
 * can report which env var actually supplied it (or that none did). */
export function resolveToken(env = process.env) {
  if (typeof env.MULLION_AUTH_TOKEN === "string" && env.MULLION_AUTH_TOKEN.length > 0) {
    return { token: env.MULLION_AUTH_TOKEN, source: "MULLION_AUTH_TOKEN" };
  }
  if (typeof env.MULLION_HOOK_TOKEN === "string" && env.MULLION_HOOK_TOKEN.length > 0) {
    return { token: env.MULLION_HOOK_TOKEN, source: "MULLION_HOOK_TOKEN" };
  }
  return { token: null, source: null };
}

export class MullionSocketError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "MullionSocketError";
    this.status = status;
  }
}

/**
 * One connection, many in-flight requests/streams multiplexed by `id` — same
 * shape the wire protocol itself uses. Every request has a safety-net
 * timeout (mirrors src/mcp/client.mjs's own posture of never hanging a CLI
 * invocation forever on a wedged connection), but unlike that class this one
 * DOES reject on failure: a CLI command needs to distinguish "op returned an
 * error" (print it, exit non-zero) from "got a result" without a bespoke
 * decision object per call site.
 */
export class MullionSocketClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    const env = opts.env ?? process.env;
    this.socketPath = opts.socketPath ?? resolveSocketPath(env);
    const resolved = resolveToken(env);
    this.token = opts.token ?? resolved.token;
    this.tokenSource = opts.token ? "explicit" : resolved.source;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    this.socket = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.streams = new Map();
    this._connectPromise = null;
    this._closed = false;
  }

  /** Resolves once the handshake line has been written — the handshake
   * itself has no ack (docs/socket-api.md), so a bad token only surfaces
   * once the connection is closed by the server or the first request times
   * out. Safe to call more than once; subsequent calls return the same
   * in-flight/completed connection. */
  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const failBeforeConnect = (err) => {
        reject(
          new Error(
            `cannot connect to control socket at ${this.socketPath}: ${err.code ?? err.message}. Is Mullion running?`,
          ),
        );
      };
      socket.once("error", failBeforeConnect);
      socket.once("connect", () => {
        socket.removeListener("error", failBeforeConnect);
        socket.on("error", (err) => this._onError(err));
        socket.on("close", () => this._onClose());
        socket.on("data", (chunk) => this._onData(chunk));
        socket.write(`${JSON.stringify(this.token ? { token: this.token } : {})}\n`);
        this.socket = socket;
        resolve(socket);
      });
    });
    return this._connectPromise;
  }

  _onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
      if (line.trim() === "") continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._route(msg);
    }
  }

  _route(msg) {
    const id = msg.id;
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new MullionSocketError(msg.status, msg.error ?? "request failed"));
      return;
    }
    const stream = this.streams.get(id);
    if (stream) stream._handle(msg);
  }

  _onError(err) {
    this.emit("error", err);
  }

  _onClose() {
    this._closed = true;
    const err = new Error("control socket connection closed");
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    for (const stream of this.streams.values()) stream._handleClose();
    this.streams.clear();
  }

  _send(message) {
    if (!this.socket || !this.socket.writable) {
      throw new Error("control socket connection is not open");
    }
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  /** One request, one reply — resolves with `result` on `ok:true`, rejects
   * with a MullionSocketError (carrying the REST-equivalent `status`) on
   * `ok:false`. Used by every non-streaming op. */
  async request(op, body) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for a reply to '${op}'`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ id, op, body });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Opens a multiplexed stream (`sessions.attach`/`events.subscribe`).
   * Returns a `ControlStream` whose `opened` promise resolves once the
   * stream is confirmed live — which, per the wire protocol, means either an
   * explicit `{ok:true}` ack (events.subscribe) OR the arrival of the first
   * unsolicited `{type:...}` frame with no ack at all (sessions.attach) —
   * and rejects if the server replies `{ok:false}` instead. Every frame
   * (including that first one) is also emitted on `"frame"` so a caller
   * never has to special-case "was this frame the opening signal."
   */
  async openStream(op, body) {
    await this.connect();
    const id = this.nextId++;
    const stream = new ControlStream(this, id, op);
    this.streams.set(id, stream);
    // Defense in depth against a caller that never checks `stream.opened`
    // at all: an unattached rejection would otherwise crash the whole
    // process on Node's unhandled-rejection default. Attaching this
    // no-op catch marks THIS attachment as handled without consuming the
    // rejection for anyone who separately does `await stream.opened` —
    // every `.then()`/`.catch()` on a promise gets the same outcome
    // independently.
    stream.opened.catch(() => {});
    try {
      this._send({ id, op, body });
    } catch (err) {
      this.streams.delete(id);
      stream._rejectOpen(err);
    }
    return stream;
  }

  close() {
    if (this.socket) this.socket.destroy();
    this._closed = true;
  }
}

class ControlStream extends EventEmitter {
  constructor(client, id, op) {
    super();
    this.client = client;
    this.id = id;
    this.op = op;
    this.closed = false;
    this._opened = false;
    this.opened = new Promise((resolve, reject) => {
      this._resolveOpen = resolve;
      this._rejectOpen = reject;
    });
  }

  _markOpen() {
    if (this._opened) return;
    this._opened = true;
    this._resolveOpen();
  }

  _handle(msg) {
    if (typeof msg.ok === "boolean") {
      if (msg.ok) {
        this._markOpen();
        return;
      }
      this.closed = true;
      this.client.streams.delete(this.id);
      const err = new MullionSocketError(msg.status, msg.error ?? "stream failed");
      // A failure before the stream ever opened is fully reported via the
      // rejected `opened` promise alone — also emitting "error" here would
      // make every caller that just does `await stream.opened` (without
      // separately attaching a same-tick "error" listener) crash on Node's
      // "unhandled 'error' event" special case, since EventEmitter throws
      // when nothing is listening. A post-open failure has no such promise
      // for a caller to be awaiting, so "error" is the only signal then.
      if (!this._opened) this._rejectOpen(err);
      else this.emit("error", err);
      return;
    }
    this._markOpen();
    this.emit("frame", msg);
    // "exited" (the remote program ended) and "closed" (the stream itself
    // ended with no sessions.detach — e.g. a multi-host proxied attach's
    // upstream connection failing, SocketChannel.close()'s own doc comment)
    // are both terminal from this client's point of view — docs/socket-api.md's
    // events/PTY-stream sections list "closed" specifically so a caller
    // doesn't wait forever on a dead remote stream.
    if (msg.type === "exited" || msg.type === "closed") {
      this.closed = true;
      this.client.streams.delete(this.id);
      this.emit("close");
    }
  }

  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    if (!this._opened) this._rejectOpen(new Error("connection closed before stream opened"));
    this.emit("close");
  }

  /** Sends a follow-up message on this same stream id (`sessions.input`,
   * `.resize`, `.detach`, `events.seen`, `.unsubscribe`) — these are
   * fire-and-forget on success (docs/socket-api.md), so no reply is awaited
   * here; a failure still arrives through the normal `_handle`/`"error"`
   * path above since it reuses this stream's own id. */
  send(op, body) {
    this.client._send({ id: this.id, op, body });
  }

  close(op) {
    if (this.closed) return;
    if (op) this.send(op);
    this.closed = true;
    this.client.streams.delete(this.id);
  }
}
