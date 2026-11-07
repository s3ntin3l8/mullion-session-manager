// Attach a WebSocket to a live PTY session: scrollback replay, live
// data/exit streaming with backpressure, and input/resize handling.
//
// It lives in a service rather than in src/routes/terminal.ts because it is
// the SHARED core behind two callers — the primary's own `/ws/terminal` route
// and an "agent" role's DB-less `/internal/ws/attach` (issue #26) — and the
// agent-side path lives in a service too (services/internal-streams.ts), so
// the route could not keep owning it without a service importing a route
// (issue #2413's subject).
//
// It has no DB dependency — only `app.pty` — which is what lets it serve
// both callers: the primary's route resolves `cwd`/`command` from the DB
// first, while the agent role receives them directly as query params.

import { StringDecoder } from "node:string_decoder";
import type { FastifyInstance } from "fastify";
import type { SocketLike } from "./socket-channel.js";
import type { AttachSessionParams } from "./session-adopt.js";
import { MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from "./pty-manager.js";
import type {
  ResizeMessage,
  ExitedMessage,
  GeometryMessage,
  ResyncMessage,
  ResyncRequestMessage,
} from "../shared/ws-protocol.js";

function isResyncRequestMessage(value: unknown): value is ResyncRequestMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "resync-request"
  );
}

function isResizeMessage(value: unknown): value is ResizeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "resize" &&
    typeof (value as { cols?: unknown }).cols === "number" &&
    typeof (value as { rows?: unknown }).rows === "number"
  );
}

export const BACKPRESSURE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
// Issue #1520 — once a connection has dropped a chunk, it stays "dirty"
// (forwarding nothing) until its send buffer falls back under this, at which
// point a resync (control frame + fresh scrollback replay) is sent.
export const RESYNC_DRAIN_BYTES = 256 * 1024;
export const RESYNC_POLL_INTERVAL_MS = 100;
/**
 * Spawn/attach a local PtyManager session and wire a WS socket to it:
 * scrollback replay, live data/exit streaming with backpressure, and
 * input/resize handling. This function has no DB dependency — only
 * `app.pty` — which is what lets it serve as the shared core behind two
 * callers: the primary's own `/ws/terminal` route below (which resolves
 * `cwd`/`command` from the DB first) and an "agent" role's DB-less
 * `/internal/ws/attach` (issue #26, routes/internal.ts), which receives
 * them directly as query params instead.
 */
export function attachSocketToSession(
  app: FastifyInstance,
  socket: SocketLike,
  { id, cwd, command, cols, rows, env }: AttachSessionParams,
): void {
  // Captured before getOrCreate, which spawns-and-marks-alive any
  // not-yet-tracked or dead session — this is the only place that still
  // reflects whether we're reattaching to a client that was already running.
  const wasAlive = app.pty.get(id)?.isAlive ?? false;
  const session = app.pty.getOrCreate({ id, cwd, command, cols, rows, env });

  const backlog = session.getScrollback();
  app.log.info(
    { sessionId: id, cwd, command, alreadyAlive: session.isAlive, backlogBytes: backlog.length },
    "terminal ws attached",
  );

  // The requested cols/rows above may have been floored by
  // clampTerminalSize (MIN_TERMINAL_COLS/ROWS, pty-manager.ts) — echo the
  // post-clamp size the session actually applied so the frontend's xterm
  // grid never silently drifts from the PTY it's attached to (issue: small
  // panes ignoring input). Defined here (needs `session`, `socket`) but sent
  // AFTER the scrollback backlog below, not before it — every existing
  // consumer of this socket (the frontend's own WS message handler, and this
  // file's own test suite) assumes the very first frame is that backlog;
  // sending this first would silently break that invariant for a change this
  // fix doesn't need to make. Sent once there, and again after every later
  // resize() below.
  const sendGeometry = () => {
    if (socket.readyState !== socket.OPEN) return;
    // minCols/minRows: the constant floor every session's geometry is
    // clamped to (see GeometryMessage's own doc comment for why the
    // frontend needs this as a stable narrow-pane font-fit target, distinct
    // from `session.size` above which changes on every resize).
    const geometryMessage: GeometryMessage = {
      type: "geometry",
      ...session.size,
      minCols: MIN_TERMINAL_COLS,
      minRows: MIN_TERMINAL_ROWS,
    };
    socket.send(JSON.stringify(geometryMessage));
  };

  // Replay whatever this session produced while unwatched. In the common
  // case (browser tab closed, Node process never restarted) this alone
  // reconstructs the screen correctly, with no dtach-level reattach
  // involved at all — see pty-manager.ts.
  if (backlog.length > 0) socket.send(backlog);
  sendGeometry();

  // A fresh spawn/respawn already nudges via attachClient() (pty-manager.ts).
  // A reattach to an already-alive client — the common case for a plain
  // browser refresh with Node still running — never respawns, so the
  // scrollback replay above can sit there garbled (e.g. a full-screen TUI's
  // alt-screen setup evicted from the ring buffer) until a real resize
  // happens to come in. Force the same repaint here instead of waiting for
  // one.
  if (wasAlive) session.requestRedraw();

  // Issue #1520 — set on the first chunk dropped for backpressure. Until the
  // buffer drains, nothing more is forwarded (a half-delivered stream is
  // worse than none: later chunks would land mid-escape-sequence), then
  // sendResync() replaces whatever the client has with a fresh replay.
  let dirty = false;
  let drainTimer: ReturnType<typeof setInterval> | undefined;
  const sendResync = () => {
    const resyncMessage: ResyncMessage = { type: "resync" };
    socket.send(JSON.stringify(resyncMessage));
    const fresh = session.getScrollback();
    if (fresh.length > 0) socket.send(fresh);
    sendGeometry();
    session.requestRedraw();
  };
  const stopDrainWatch = () => {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = undefined;
  };
  const startDrainWatch = () => {
    drainTimer = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return stopDrainWatch();
      if (socket.bufferedAmount > RESYNC_DRAIN_BYTES) return;
      stopDrainWatch();
      dirty = false;
      sendResync();
    }, RESYNC_POLL_INTERVAL_MS);
    drainTimer.unref();
  };

  const unsubscribeData = session.onData((chunk) => {
    if (socket.readyState !== socket.OPEN) return;
    if (dirty) return;
    // Backpressure: bufferedAmount is how much this client hasn't
    // acknowledged yet (a stalled connection, an overwhelmed mobile
    // link). Drop new output past this threshold rather than letting
    // the queue — and this process's memory — grow unbounded for one
    // slow subscriber; the scrollback ring buffer (pty-manager.ts)
    // still holds the last 256KB regardless, so a reconnect (or this
    // same connection catching back up) replays cleanly rather than
    // needing every dropped byte replayed in order.
    if (socket.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) {
      dirty = true;
      startDrainWatch();
      return;
    }
    socket.send(chunk);
  });

  const unsubscribeExit = session.onExit(() => {
    if (socket.readyState === socket.OPEN) {
      const exitedMessage: ExitedMessage = session.attachIncompatible
        ? { type: "exited", reason: "incompatible" }
        : { type: "exited" };
      socket.send(JSON.stringify(exitedMessage));
    }
  });

  // Per-socket: a multi-byte UTF-8 char split across two binary frames must
  // be reassembled, not decoded to U+FFFD per frame.
  const inputDecoder = new StringDecoder("utf8");
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      // RawData is Buffer | ArrayBuffer | Buffer[]; narrow each arm
      // explicitly since Buffer.from() can't take the union directly.
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      const text = inputDecoder.write(buf);
      if (text.length > 0) session.write(text);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      app.log.warn({ sessionId: id }, "dropped malformed control message");
      return;
    }

    if (isResizeMessage(parsed)) {
      session.resize(parsed.cols, parsed.rows);
      sendGeometry();
      return;
    }
    // Sent by a primary proxying a remote-host attach (proxyToRemoteAttach).
    // While dirty, the drain watch's own resync is already pending and will
    // double as the requester's ack, so don't send a second one mid-stream.
    if (isResyncRequestMessage(parsed)) {
      if (!dirty) sendResync();
      return;
    }
    // Unrecognized control frames (including a since-removed message type)
    // are dropped silently rather than erroring the socket.
  });

  socket.on("close", () => {
    stopDrainWatch();
    unsubscribeData();
    unsubscribeExit();
    // Deliberately not killing the session — it keeps running on the
    // host until the Node process itself shuts down (ptyPlugin's onClose)
    // or an explicit DELETE /api/sessions/:id (or, for an agent, the
    // equivalent internal terminate call from the primary).
    app.log.info({ sessionId: id }, "terminal ws detached (session kept alive)");
  });
}
