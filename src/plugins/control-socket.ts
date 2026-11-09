import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { chmodSync, unlinkSync } from "node:fs";
import {
  parseControlMessage,
  parseControlHandshake,
  HANDSHAKE_TIMEOUT_MS,
  MAX_HANDSHAKE_BYTES,
  type ControlMessage,
} from "../services/control-protocol.js";
import { isAuthEnabled, configuredToken } from "../services/auth.js";
import { timingSafeTokenMatch } from "../services/crypto-utils.js";
import { WRITE_HARD_CEILING_BYTES } from "../services/socket-channel.js";
import { reclaimSocketPath } from "../services/unix-socket.js";
import { isPipePath } from "../cli/ipc-path.mjs";
import { restrictPipeToCurrentUser } from "../cli/pipe-acl.mjs";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import { resolveSessionHostId } from "../services/session-live-info.js";
import type { ConnectionState, ReplyPayload, Scope } from "./control-socket-core.js";
import { messageStates } from "./control-socket-support.js";
import { OPS } from "./control-socket-ops.js";

// The op table and its authoring helpers moved to control-socket-ops.ts, the
// shared request types to control-socket-core.ts (issue #2402); re-exported so
// no importer's path changes.
export {
  OPS,
  routeOp,
  pinned,
  unscoped,
  owned,
  type DeclaredResolver,
} from "./control-socket-ops.js";
export {
  type ConnectionState,
  buildQueryUrl,
  MAX_OPEN_CHANNELS,
  MAX_WAITS_PER_CONNECTION,
} from "./control-socket-core.js";

// Phase 4 (#185) — a general-purpose Unix control socket: the transport
// behind the `mullion` CLI (#134/#190) and any other local script that wants
// session/browser/event access without an HTTP base URL or bearer token.
// Modeled directly on src/plugins/hooks.ts's shape (reclaim-stale-socket →
// listen → chmod 0600 → decorate → onClose teardown, line-buffered NDJSON
// with a byte-cap) but a different protocol and a different auth principal
// — see docs/socket-api.md for the full wire-protocol writeup.
//
// Dispatch is deliberately NOT a hand-rolled reimplementation of each
// route's logic: every request/response op re-enters Fastify via
// app.inject() against the real REST route, so this socket inherits ajv
// validation, multi-host RemoteHostClient proxying, and every side effect
// (worktree cleanup, browser-binding bookkeeping, live-status merge) for
// free, with zero drift risk. "The socket is not a separate API — it's an
// alternative transport" (docs/roadmap.md's Phase 4 design note) is
// structural here, not just a stated intention.
//
// Registered only for the primary role: an "agent" process has no
// dbPlugin and none of the /api/* routes this dispatches into (see
// src/app.ts's role branch) — app.inject() against them would just 404.

// Larger than hooks.ts's 64 KiB cap: base64'd scrollback replay and
// screenshot payloads travel on this socket (added in later Phase 4 PRs),
// and SCROLLBACK_MAX_BYTES (scrollback-buffer.ts) is already 1 MiB before the
// ~33% base64 inflation — see docs/socket-api.md's framing section. Checked
// against Buffer.byteLength of the decoded buffer (not JS string.length,
// which counts UTF-16 code units and would let a line up to 2x this past
// for scrollback containing astral characters).
const MAX_LINE_BYTES = 2 * 1024 * 1024;

// A connection that never completes its line-1 handshake would otherwise
// hold an fd (and up to MAX_LINE_BYTES of buffered, unauthenticated input)
// indefinitely — bound it the same way an HTTP request has an implicit
// socket timeout. Exported for test/plugins/control-socket.test.ts, same
// reasoning as hooks.ts's own exported GATE_TIMEOUT_MS/PROMOTE_TIMEOUT_MS.
export { HANDSHAKE_TIMEOUT_MS };

// Issue #1517 — per-connection load bounds. One session-scoped client (the
// socket path is injected into every spawned session) must not be able to
// queue unbounded work or reply bytes in this process.
/** Max ops dispatched but not yet replied to on one connection; past it the
 * socket is paused and the remaining buffered lines wait. */
export const MAX_INFLIGHT_OPS = 32;
/** Once this many reply bytes are queued unwritten, stop reading requests
 * until the socket 'drain's. */
export const WRITE_HIGH_WATER_BYTES = 1024 * 1024;
export { WRITE_HARD_CEILING_BYTES };
/** Pre-handshake input is just `{"token":"..."}`; nothing legitimate needs
 * more than this before authenticating. */
export { MAX_HANDSHAKE_BYTES };
/** Global cap on simultaneously open connections (server.maxConnections). */
export const MAX_CONNECTIONS = 256;

function writeFrame(
  socket: net.Socket,
  message: { id: number | null } & Record<string, unknown>,
): void {
  if (!socket.writable) return;
  socket.write(`${JSON.stringify(message)}\n`);
  // A peer that never reads would otherwise let replies pile up in this
  // process's memory without bound (#1517) — drop it past the hard ceiling.
  if (socket.writableLength > WRITE_HARD_CEILING_BYTES) socket.destroy();
}

/**
 * Resolves the mandatory line-1 handshake to a connection scope. Two
 * accepted principals:
 *  - MULLION_AUTH_TOKEN (the operator's own credential) → "full" scope.
 *  - a live session's own MULLION_HOOK_TOKEN, resolved via the same
 *    app.pty.resolveToken() the hook socket uses → "session" scope, pinned
 *    to that session id.
 * When auth is disabled entirely, EVERY handshake is accepted at full
 * scope — not just an empty one — the 0600 socket mode is the only gate
 * then, same posture src/plugins/auth.ts's onRequest hook already takes for
 * plain HTTP (a Bearer header presented when MULLION_AUTH_TOKEN is unset
 * doesn't get rejected either; the whole gate is simply absent). Checked
 * first, before any token comparison: a stale or forged token presented in
 * this mode must not be treated any differently than no token at all —
 * otherwise a session whose hook token predates a Mullion restart (a real,
 * documented case — see pty-manager.ts's loadOrCreateHookToken) would get a
 * hard close instead of the same free access every other client in this
 * mode already has.
 *
 * Note: an OIDC-only deployment (OIDC configured, no MULLION_AUTH_TOKEN) has
 * no static full-scope secret to present here at all — only session-scoped
 * connections from inside an already-running session work. An operator who
 * wants `mullion ps` from a bare shell needs MULLION_AUTH_TOKEN configured,
 * which can coexist with OIDC.
 */
function resolveHandshake(
  app: FastifyInstance,
  token: string | null,
): { scope: Scope; sessionId: string | null } | null {
  if (!isAuthEnabled(app.config)) return { scope: "full", sessionId: null };
  if (token === null) return null;
  // Trimmed via configuredToken, same as every other credential path in
  // services/auth.ts (security audit finding AS2, found on this parallel
  // path in Hermes review) — comparing against the raw, untrimmed config
  // value here made a token with incidental surrounding whitespace
  // authenticate over HTTP (trimmed) but fail on this control socket
  // (untrimmed), a third inconsistent reading of "the configured token"
  // alongside the two AS2 already unified.
  const expected = configuredToken(app.config);
  // Issue #1059 — both sides are fixed-length (operator-configured
  // MULLION_AUTH_TOKEN vs inbound bearer); same fixed-length assumption as
  // auth.ts / internal.ts — see crypto-utils.ts for the full constraint.
  if (expected !== "" && timingSafeTokenMatch(token, expected)) {
    return { scope: "full", sessionId: null };
  }
  const sessionId = app.pty.resolveToken(token);
  if (sessionId !== undefined) return { scope: "session", sessionId };
  return null;
}

/** A connection carried by a host's control relay (#1656): already
 * authenticated by that host's agent, so it skips the handshake and is
 * pinned, for its lifetime, to `sessionId` as a session-scope connection. */
export interface RelayBinding {
  hostId: string;
  sessionId: string;
}

/** Why a relayed session may not act right now, or null: its row must still be
 * active and the session must be hosted by the relaying host — the one fact
 * that bounds what a compromised agent can claim to be. */
export function relayedSessionDenied(app: FastifyInstance, relay: RelayBinding): string | null {
  const row = app.db
    .select({ projectId: sessions.projectId, hostId: sessions.hostId, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, Number(relay.sessionId)))
    .get();
  if (!row || row.status !== "active") return "this session is no longer active";
  if (resolveSessionHostId(app, row) !== relay.hostId) {
    return "this session is not hosted by the relaying host";
  }
  return null;
}

/** How often a relayed connection's open streams re-check their session (#2125). */
export const RELAY_STREAM_RECHECK_MS = 30_000;

/**
 * Issue #2125 — a request is re-checked against the session's row each time, but a
 * stream outlives any one request: a session that is killed, or moved to another
 * host, while its `events.subscribe` / `sessions.attach` is open must stop being
 * served. Ends every open stream on `conn` with a `closed` frame carrying the
 * reason, and reports whether it did.
 */
export function closeDeniedRelayStreams(
  app: FastifyInstance,
  relay: RelayBinding,
  conn: ConnectionState,
): boolean {
  if (conn.openChannels.size === 0) return false;
  const denied = relayedSessionDenied(app, relay);
  if (denied === null) return false;
  for (const [id, channel] of [...conn.openChannels]) {
    conn.send({ id, type: "closed", reason: denied });
    channel.close(false);
  }
  conn.openChannels.clear();
  return true;
}

export function handleConnection(
  app: FastifyInstance,
  socket: net.Socket,
  openSockets: Set<net.Socket>,
  relay?: RelayBinding,
): void {
  openSockets.add(socket);
  socket.once("close", () => {
    openSockets.delete(socket);
    // Phase 4 (#186) — the whole connection going away must close every
    // still-open `sessions.attach` stream on it too (unsubscribing
    // attachSocketToSession's own data/exit listeners — see
    // SocketChannel.close()), the same way a real WS's own "close" event
    // would; nothing else ever does this for a connection that just drops
    // without an explicit sessions.detach first. notify: false — the
    // underlying net.Socket has already closed by the time this fires
    // (this IS its own "close" event), so a wire write is pointless;
    // clear() below removes every entry in one pass rather than relying on
    // each channel's own close listener to do it one at a time.
    if (conn) {
      for (const channel of conn.openChannels.values()) channel.close(false);
      conn.openChannels.clear();
    }
  });

  let buffer = "";
  // UTF-8 byte length of `buffer`, tracked incrementally so framing never
  // re-measures (or re-scans) the whole buffer per chunk (#1521).
  let bufferBytes = 0;
  // Everything before this index has already been searched for "\n".
  let scanFrom = 0;
  // A relayed connection arrives pre-authenticated (session scope, pinned to
  // the id the relaying agent validated); a local one waits for its handshake.
  let conn: ConnectionState | null = relay
    ? {
        send: (message) => writeFrame(socket, message),
        onClose: (listener) => {
          socket.once("close", listener);
          return () => socket.off("close", listener);
        },
        // The in-memory pair's server half: streaming ops (#2125) write their frames
        // to it exactly as to a net.Socket, and the mux carries them back.
        socket,
        scope: "session",
        sessionId: relay.sessionId,
        openChannels: new Map(),
        activeWaits: 0,
      }
    : null;
  if (relay) {
    const recheck = setInterval(() => {
      if (conn) closeDeniedRelayStreams(app, relay, conn);
    }, RELAY_STREAM_RECHECK_MS);
    recheck.unref();
    socket.once("close", () => clearInterval(recheck));
  }
  let inflight = 0;
  let paused = false;
  // Per-connection decoder, not a fresh Buffer.toString("utf8") per chunk —
  // a chunk boundary landing mid-multi-byte-character would otherwise
  // silently corrupt it (U+FFFD in, real bytes gone). Matters here more
  // than it would for hooks.ts's small NDJSON lines: this socket's cap is
  // 32x larger specifically so multi-chunk scrollback/screenshot payloads
  // (later Phase 4 PRs) fit, and those are guaranteed to span multiple TCP
  // reads.
  const decoder = new StringDecoder("utf8");

  const handshakeTimer = setTimeout(() => {
    app.log.warn("control connection never completed its handshake, closing");
    socket.destroy();
  }, HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref();
  if (relay) clearTimeout(handshakeTimer);

  const overloaded = () =>
    conn !== null &&
    (inflight >= MAX_INFLIGHT_OPS || socket.writableLength >= WRITE_HIGH_WATER_BYTES);

  // Reconciles the socket's paused state with current load and, when load has
  // cleared, resumes processing lines that were left buffered while paused.
  const setPaused = (next: boolean) => {
    if (paused === next) return;
    paused = next;
    if (next) socket.pause();
    else socket.resume();
  };
  const flow = () => {
    if (socket.destroyed) return;
    if (overloaded()) {
      setPaused(true);
      return;
    }
    setPaused(false);
    pump();
  };
  socket.on("drain", flow);

  const pump = () => {
    while (!socket.destroyed) {
      // Lines already buffered are NOT dispatched while overloaded — pausing
      // the socket alone would not stop the rest of a chunk already read.
      if (overloaded()) {
        setPaused(true);
        return;
      }
      const newlineIndex = buffer.indexOf("\n", scanFrom);
      if (newlineIndex === -1) {
        scanFrom = buffer.length;
        break;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      scanFrom = 0;
      const lineBytes = Buffer.byteLength(line, "utf8");
      bufferBytes -= lineBytes + 1;

      if (line.trim() === "") continue;

      // Guards a *terminated* line of any size — the remnant check after
      // this loop only catches an unterminated tail; a single TCP chunk
      // can legitimately contain one complete line larger than
      // MAX_LINE_BYTES (the newline just happens to arrive in the same
      // write), which would otherwise be extracted and dispatched with no
      // cap applied at all. Checked before any JSON.parse of the line —
      // parsing a deliberately oversized line is itself the expensive
      // operation this cap exists to avoid, so no id is recovered here.
      if (conn === null && lineBytes > MAX_HANDSHAKE_BYTES) {
        app.log.warn("control connection sent an oversized handshake line, closing");
        clearTimeout(handshakeTimer);
        socket.destroy();
        return;
      }
      if (lineBytes > MAX_LINE_BYTES) {
        writeFrame(socket, {
          id: null,
          ok: false,
          status: 400,
          error: "line exceeds the maximum message size",
        });
        continue;
      }

      if (conn === null) {
        const handshake = parseControlHandshake(line);
        if (handshake === null) {
          app.log.warn("malformed control-socket handshake, closing connection");
          clearTimeout(handshakeTimer);
          socket.destroy();
          return;
        }
        const resolved = resolveHandshake(app, handshake.token);
        if (resolved === null) {
          // Never log any prefix of the presented token (#1521): a session's
          // hook token is a live credential.
          const hint =
            handshake.token === null
              ? "no token presented"
              : `presented token of length ${handshake.token.length} did not match MULLION_AUTH_TOKEN or any live session`;
          app.log.warn(`control connection presented an invalid handshake, closing (${hint})`);
          clearTimeout(handshakeTimer);
          socket.destroy();
          return;
        }
        clearTimeout(handshakeTimer);
        conn = {
          send: (message) => writeFrame(socket, message),
          onClose: (listener) => {
            socket.once("close", listener);
            return () => socket.off("close", listener);
          },
          socket,
          scope: resolved.scope,
          sessionId: resolved.sessionId,
          openChannels: new Map(),
          activeWaits: 0,
        };
        continue;
      }

      const result = parseControlMessage(line);
      if (!result.ok) {
        writeFrame(socket, { id: result.id, ok: false, status: 400, error: result.error });
        continue;
      }

      if (relay) {
        // Per request, not per connection: the row can go inactive and the
        // session can be re-homed while a long-lived relayed connection idles.
        const denied = relayedSessionDenied(app, relay);
        if (denied !== null) {
          writeFrame(socket, { id: result.message.id, ok: false, status: 403, error: denied });
          continue;
        }
      }
      inflight++;
      dispatch(app, conn, result.message)
        .catch((err) => app.log.error({ err }, "dispatch failed"))
        .finally(() => {
          inflight--;
          flow();
        });
    }

    // Checked AFTER draining every complete line above, not on the raw
    // just-appended buffer — a single chunk can legitimately contain a
    // complete, valid line followed by an oversized, still-incomplete tail
    // (e.g. a handshake line immediately followed by a multi-megabyte
    // write with no terminator yet); that valid line must still be
    // processed rather than the whole connection being destroyed before
    // ever reading it. Only an unterminated remainder counts toward the cap.
    if (!socket.destroyed && bufferBytes > (conn === null ? MAX_HANDSHAKE_BYTES : MAX_LINE_BYTES)) {
      app.log.warn("control connection sent an oversized line without a terminator, closing");
      socket.destroy();
    }
  };

  socket.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    buffer += text;
    bufferBytes += Buffer.byteLength(text, "utf8");
    pump();
  });

  socket.on("error", (err) => {
    app.log.debug({ err }, "control connection error");
  });
}

export async function dispatch(
  app: FastifyInstance,
  conn: ConnectionState,
  message: ControlMessage,
): Promise<void> {
  // Own-property lookup: OPS is a plain object, so `OPS["toString"]` /
  // `"__proto__"` / `"constructor"` would otherwise resolve to an inherited
  // Object.prototype member with no `.scopes`, and the `.includes` below would
  // throw outside the try — an unhandled rejection that takes the process down.
  const spec = Object.hasOwn(OPS, message.op) ? OPS[message.op] : undefined;
  if (!spec) {
    conn.send({
      id: message.id,
      ok: false,
      status: 404,
      error: `unknown op: ${message.op}`,
    });
    return;
  }
  if (!spec.scopes.includes(conn.scope)) {
    conn.send({
      id: message.id,
      ok: false,
      status: 403,
      error: "not permitted for this connection's scope",
    });
    return;
  }

  const reply = (payload: ReplyPayload) => conn.send({ id: message.id, ...payload });
  try {
    await spec.handler({ app, conn, id: message.id, body: message.body, reply });
  } catch (err) {
    // Defense-in-depth: writeFrame() already guards on socket.writable, but a
    // handler throwing after the connection has gone away mid-flight is
    // exactly the moment writing a reply is most likely to itself fail —
    // this must never surface as an unhandled rejection from the `void
    // dispatch(...)` call site above.
    try {
      const message = err instanceof Error ? err.message : String(err);
      // A request that lands while the app is closing (a service restart)
      // is a shutdown, not a fault: say so rather than echo Fastify's text.
      // Keyed off Fastify's error code; its text is only a fallback.
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "FST_ERR_REOPENED_CLOSE_SERVER" || /has already been closed/.test(message)) {
        reply({ ok: false, status: 503, error: "the primary is shutting down" });
      } else {
        reply({ ok: false, status: 500, error: message });
      }
    } catch (sendErr) {
      app.log.debug({ sendErr }, "failed to send control-socket error reply");
    }
  }
}

export const controlSocketPlugin = fp(async (app: FastifyInstance) => {
  // An "agent" role process has no dbPlugin and none of the /api/* routes
  // this dispatches into (see src/app.ts's role branch) — app.inject()
  // against them would just 404, so there's nothing useful for this socket
  // to do there.
  if (app.config.MULLION_ROLE !== "primary") return;

  const socketPath = app.pty.controlSocketPath;

  // Removes a genuinely stale socket file (mirrors hooks.ts's own — a prior
  // process that exited without running this plugin's onClose leaves one
  // behind) but throws instead of unlinking if something IS still live at
  // this path — see unix-socket.ts's own doc comment for the incident this
  // prevents (this socket path is injected into every spawned session, so a
  // stray dev backend started from inside one inherits it and would
  // otherwise silently hijack the real listener).
  await reclaimSocketPath(socketPath);

  // Tracks every currently-open connection so onClose below can actually
  // sever them — server.close() alone only stops accepting *new*
  // connections, it never touches sockets already open (a gap that matters
  // more here than it might elsewhere: MULLION_SOCKET_PATH is injected into
  // every spawned session in a later Phase 4 PR, so a wedged same-uid agent
  // connection could otherwise hold this process open past graceful
  // shutdown indefinitely).
  const openSockets = new Set<net.Socket>();

  const server = net.createServer((socket) => handleConnection(app, socket, openSockets));
  server.maxConnections = MAX_CONNECTIONS;

  // bind() creates the socket file with 0777 & ~umask; a 077 umask for the
  // (synchronous) bind means it is never group/world-accessible, not even
  // between listen() and the chmod below (#1521). Restored immediately —
  // umask is process-wide. Unsupported in worker threads, hence the guard.
  let previousUmask: number | null = null;
  try {
    previousUmask = process.umask(0o077);
  } catch {
    previousUmask = null;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
      if (previousUmask !== null) process.umask(previousUmask);
      previousUmask = null;
    });
  } finally {
    if (previousUmask !== null) process.umask(previousUmask);
  }
  // 0600: filesystem perms are the first line of defense alongside the
  // handshake token above, same posture as hooks.ts's own hook socket
  // (including its named pipe, narrowed to this user and SYSTEM — #2065).
  if (!isPipePath(socketPath)) chmodSync(socketPath, 0o600);
  await restrictPipeToCurrentUser(socketPath, {
    log: (msg) => app.log.warn(`control-socket: ${msg}`),
  });

  app.decorate("controlServer", server);

  app.addHook("onClose", async () => {
    // Issue #2270 — the queue is created on first use (the app may already be listening
    // by then, when hooks can no longer be added), so it is stopped here.
    messageStates.get(app)?.queue.stop();
    for (const socket of openSockets) {
      // Issue #2271 — tell the peer WHY it is being dropped: this is the
      // id-less fatal frame the clients already fail every pending request
      // from (src/cli/client.mjs), here carrying a retryable reason instead
      // of a bare "connection closed".
      // end() flushes the frame before the FIN; destroy() right after write()
      // could discard it. The timer bounds a peer that never closes its side.
      socket.end(
        `${JSON.stringify({ id: null, ok: false, fatal: true, status: 503, error: "server-restarting" })}\n`,
      );
      setTimeout(() => socket.destroy(), 250).unref();
    }
    openSockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    try {
      if (!isPipePath(socketPath)) unlinkSync(socketPath);
    } catch {
      // Already gone is fine.
    }
  });
});

declare module "fastify" {
  interface FastifyInstance {
    controlServer: net.Server;
  }
}
