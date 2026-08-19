import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import type { SocketLike } from "../services/socket-channel.js";
import { MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from "../services/pty-manager.js";
// ResizeMessage/ExitedMessage physically live in src/shared/ws-protocol.ts
// (imported by the frontend from the same file too — see TerminalPane.tsx's
// own import) as TerminalWSMessage's two arms. ResizeMessage used to be a
// module-private (non-exported) `interface` declared here; ExitedMessage
// never had a named type at all — this was a bare `{ type: "exited" }`
// object literal. Both are now exported from here for the first time (no
// prior importer to preserve), purely so a reader of this file can jump
// straight to the canonical definition instead of one more hop through
// ws-protocol.ts.
import type { ResizeMessage, ExitedMessage, GeometryMessage } from "../shared/ws-protocol.js";

export type { ResizeMessage, ExitedMessage, GeometryMessage };

function isResizeMessage(value: unknown): value is ResizeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "resize" &&
    typeof (value as { cols?: unknown }).cols === "number" &&
    typeof (value as { rows?: unknown }).rows === "number"
  );
}

const BACKPRESSURE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface AttachSessionParams {
  id: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
}

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
  { id, cwd, command, cols, rows }: AttachSessionParams,
): void {
  // Captured before getOrCreate, which spawns-and-marks-alive any
  // not-yet-tracked or dead session — this is the only place that still
  // reflects whether we're reattaching to a client that was already running.
  const wasAlive = app.pty.get(id)?.isAlive ?? false;
  const session = app.pty.getOrCreate({ id, cwd, command, cols, rows });

  app.log.info(
    { sessionId: id, cwd, command, alreadyAlive: session.isAlive },
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
  const backlog = session.getScrollback();
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

  const unsubscribeData = session.onData((chunk) => {
    if (socket.readyState !== socket.OPEN) return;
    // Backpressure: bufferedAmount is how much this client hasn't
    // acknowledged yet (a stalled connection, an overwhelmed mobile
    // link). Drop new output past this threshold rather than letting
    // the queue — and this process's memory — grow unbounded for one
    // slow subscriber; the scrollback ring buffer (pty-manager.ts)
    // still holds the last 256KB regardless, so a reconnect (or this
    // same connection catching back up) replays cleanly rather than
    // needing every dropped byte replayed in order.
    if (socket.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) return;
    socket.send(chunk);
  });

  const unsubscribeExit = session.onExit(() => {
    if (socket.readyState === socket.OPEN) {
      const exitedMessage: ExitedMessage = { type: "exited" };
      socket.send(JSON.stringify(exitedMessage));
    }
  });

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      // RawData is Buffer | ArrayBuffer | Buffer[]; narrow each arm
      // explicitly since Buffer.from() can't take the union directly.
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      session.write(buf.toString("utf8"));
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
    // Unrecognized control frames (including a since-removed message type)
    // are dropped silently rather than erroring the socket.
  });

  socket.on("close", () => {
    unsubscribeData();
    unsubscribeExit();
    // Deliberately not killing the session — it keeps running on the
    // host until the Node process itself shuts down (ptyPlugin's onClose)
    // or an explicit DELETE /api/sessions/:id (or, for an agent, the
    // equivalent internal terminate call from the primary).
    app.log.info({ sessionId: id }, "terminal ws detached (session kept alive)");
  });
}

/**
 * The remote counterpart to attachSocketToSession above: opens an upstream
 * WS to the owning agent's `/internal/ws/attach` and pipes bytes both ways
 * — not a free pass-through (issue #26's design plan §6):
 *   - browser→agent: forward every frame raw (binary input, JSON resize).
 *   - agent→browser: forward raw but replicate attachSocketToSession's own
 *     `bufferedAmount` backpressure drop, and keep reading the upstream
 *     socket regardless so a slow browser tab never stalls the agent.
 *   - close/error: agent side closing closes the browser (the frontend's
 *     own reconnect/backoff then takes over); browser closing closes the
 *     agent side; a failed upstream open closes the browser with a logged
 *     reason rather than hanging the upgrade.
 * The primary (not the agent, which has no DB) owns `lastAttachedAt` —
 * already written by the caller before this is invoked.
 */
export function proxyToRemoteAttach(
  app: FastifyInstance,
  browserSocket: SocketLike,
  hostId: string,
  opts: AttachSessionParams,
): void {
  const closeBrowser = () => {
    if (browserSocket.readyState === browserSocket.OPEN) browserSocket.close();
  };

  let upstream: ReturnType<ReturnType<typeof getRemoteHostClient>["openAttach"]>;
  try {
    upstream = getRemoteHostClient(app, hostId).openAttach(opts);
  } catch (err) {
    app.log.error({ err, hostId, sessionId: opts.id }, "failed to open remote terminal attach");
    closeBrowser();
    return;
  }

  const closeUpstream = () => {
    if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) {
      upstream.close();
    }
  };

  // Registered unconditionally, not inside upstream's "open" handler: the
  // upstream connect can take up to REQUEST_TIMEOUT_MS, and gating these on
  // "open" meant keystrokes typed during that window were silently dropped
  // (the forwarding check below already no-ops until upstream is OPEN), and
  // a browser tab closed before the upstream even opened never registered
  // closeUpstream at all — leaking that connection. Same backpressure drop
  // as the agent->browser direction below, applied to this direction too —
  // a slow/misbehaving agent must not let this browser->agent buffer grow
  // unbounded.
  browserSocket.on("message", (data, isBinary) => {
    if (upstream.readyState !== upstream.OPEN) return;
    if (upstream.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) return;
    upstream.send(data, { binary: isBinary });
  });
  browserSocket.on("close", closeUpstream);

  // Also unconditional (not nested in "open"): if the upstream socket
  // itself closes/errors before ever opening — a connection reset, the
  // agent dropping mid-handshake — closeBrowser must still run. Only the
  // "message" handler stays inside "open", since messages can't arrive
  // before that anyway.
  upstream.on("close", closeBrowser);
  upstream.on("error", (err) => {
    app.log.error({ err, hostId, sessionId: opts.id }, "remote terminal ws upstream error");
    closeBrowser();
  });

  upstream.once("open", () => {
    app.log.info({ hostId, sessionId: opts.id }, "remote terminal ws attached");

    upstream.on("message", (data, isBinary) => {
      if (browserSocket.readyState !== browserSocket.OPEN) return;
      if (browserSocket.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) return;
      browserSocket.send(data, { binary: isBinary });
    });
  });
  upstream.once("unexpected-response", (_req, res) => {
    app.log.error(
      { hostId, sessionId: opts.id, statusCode: res.statusCode },
      "agent rejected remote terminal attach",
    );
    closeBrowser();
  });
}

export interface AttachResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Phase 4 (#186) — the DB-aware counterpart to attachSocketToSession: does
 * the row/status lookup, `lastAttachedAt` write, and local-vs-remote host
 * dispatch in one call, returning a typed failure instead of throwing.
 *
 * /ws/terminal's own `preValidation` hook (below) intentionally does the
 * SAME status checks itself, ahead of this function — that's not
 * duplication to remove, it's what lets an invalid sessionId fail the WS
 * *upgrade* with a real HTTP 400/404 (the whole reason preValidation exists:
 * "before the upgrade completes... instead of an upgrade that immediately
 * closes"), which this function has no way to do since it runs after the
 * fact either way. /ws/terminal's connection handler still calls this
 * function for the actual attach dispatch, so preValidation's checks and
 * this function's checks can never drift apart into two different sets of
 * rules — they're the same code, just reached from two different points in
 * two different callers' lifecycles:
 *  - /ws/terminal: preValidation gates the upgrade; by the time this runs,
 *    success is already guaranteed (barring an extremely narrow TOCTOU
 *    window no more likely than before this refactor).
 *  - control-socket.ts's `sessions.attach` op: has no upgrade step to gate
 *    at all — this function's own return value IS the op's only chance to
 *    reply with a real error for an invalid/killed/exited session id.
 */
export function resolveAndAttach(
  app: FastifyInstance,
  socket: SocketLike,
  { sessionId, cols, rows }: { sessionId: number; cols: number; rows: number },
): AttachResult {
  // /ws/terminal's preValidation already guarantees this (see the doc
  // comment above), but control-socket.ts's `sessions.attach` op has no
  // upgrade step to gate at — without this, a non-numeric sessionId over
  // the socket becomes NaN and falls through to the DB lookup below,
  // surfacing as a confusing 404 "No session NaN" instead of a clean 400.
  if (!Number.isInteger(sessionId)) {
    return { ok: false, status: 400, error: "sessionId must be an integer" };
  }
  const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  if (!row) return { ok: false, status: 404, error: `No session ${sessionId}` };
  if (row.status === "killed") {
    return { ok: false, status: 400, error: `Session ${sessionId} was killed` };
  }
  // "exited" (session-reconciler.ts) means the program already ended on its
  // own and the master is gone — same reasoning as "killed": reattaching
  // would otherwise silently bootstrap a fresh program under this id (the
  // exact M2-era gap this status exists to close).
  if (row.status === "exited") {
    return { ok: false, status: 400, error: `Session ${sessionId} exited` };
  }

  const [project] = app.db.select().from(projects).where(eq(projects.id, row.projectId)).all();
  // B9 — currently unreachable given the DB's notNull FK + `foreign_keys =
  // ON` (a session row always has a real project), but every sibling lookup
  // in this codebase (routes/sessions.ts) guards a possibly-empty select
  // before dereferencing it, and this function is also reached from
  // control-socket.ts's `sessions.attach` op with no preValidation at all —
  // defense-in-depth against an uncatchable TypeError inside a WS handler
  // after the upgrade has already completed, where there's no HTTP response
  // left to fail cleanly. Checked before the lastAttachedAt write below so a
  // request that's about to fail never mutates the row first.
  if (!project) {
    return { ok: false, status: 404, error: `No project ${row.projectId}` };
  }
  app.db
    .update(sessions)
    .set({ lastAttachedAt: new Date() })
    .where(eq(sessions.id, sessionId))
    .run();

  const attachOpts: AttachSessionParams = {
    id: String(sessionId),
    cwd: row.cwd ?? project.cwd,
    command: row.command,
    cols,
    rows,
  };

  if (project.hostId === LOCAL_HOST_ID) {
    attachSocketToSession(app, socket, attachOpts);
  } else {
    proxyToRemoteAttach(app, socket, project.hostId, attachOpts);
  }
  return { ok: true };
}

export async function terminalRoute(app: FastifyInstance) {
  app.get(
    "/ws/terminal",
    {
      websocket: true,
      // Runs before the WS upgrade completes (@fastify/websocket respects
      // the normal Fastify request lifecycle up to onRequest/preValidation),
      // so an unknown or killed sessionId gets a real HTTP error response
      // instead of an upgrade that immediately closes.
      preValidation: async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        const sessionId = Number(query.sessionId);
        if (!Number.isInteger(sessionId)) {
          return reply.badRequest("sessionId query param is required");
        }

        const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
        if (!row) return reply.notFound(`No session ${sessionId}`);
        if (row.status === "killed") {
          return reply.badRequest(`Session ${sessionId} was killed`);
        }
        // "exited" (session-reconciler.ts) means the program already ended
        // on its own and the master is gone — same reasoning as "killed":
        // reattaching would otherwise silently bootstrap a fresh program
        // under this id (the exact M2-era gap this status exists to close).
        if (row.status === "exited") {
          return reply.badRequest(`Session ${sessionId} exited`);
        }
      },
    },
    (socket, req) => {
      const query = req.query as Record<string, string | undefined>;
      const sessionId = Number(query.sessionId);
      const cols = Number(query.cols) || 80;
      const rows = Number(query.rows) || 24;

      // preValidation above already confirmed this session and its project
      // exist and are attachable — resolveAndAttach re-checks the same
      // status rules (see its own doc comment for why that's by design, not
      // duplication) and does the actual row/project lookup + attach
      // dispatch. The upgrade has already completed by this point, so a
      // failure here (only reachable via a narrow TOCTOU race with
      // preValidation — e.g. the session was killed in between) can't be
      // reported as an HTTP error anymore; close the socket rather than
      // leaving it open with nothing ever wired up to it.
      const result = resolveAndAttach(app, socket, { sessionId, cols, rows });
      if (!result.ok) {
        app.log.warn(
          { sessionId, status: result.status, error: result.error },
          "terminal ws attach failed after upgrade, closing",
        );
        socket.close();
      }
    },
  );
}
