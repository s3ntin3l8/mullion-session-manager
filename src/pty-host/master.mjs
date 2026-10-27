// The pty-host master's logic, importable — pty-host.mjs is its command-line
// entry point (see that file's header for what pty-host is and why it
// exists). Split out so the backend's tests can drive a real master
// in-process rather than only through a child process.
import net from "node:net";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { isPipePath } from "../cli/ipc-path.mjs";
import { restrictPipeToCurrentUser } from "../cli/pipe-acl.mjs";
import {
  FRAME_DATA,
  FRAME_HELLO,
  FRAME_RESIZE,
  TOKEN_ENV,
  createDeframer,
  encodeExit,
  encodeFrame,
} from "./protocol.mjs";

const require = createRequire(import.meta.url);

/** How long `-n` waits for the master to start serving before giving up. */
export const SERVE_READY_TIMEOUT_MS = 10_000;
const SERVE_READY_POLL_MS = 50;

/** How long the master lingers after its program exits, so the EXIT frames flush. */
const EXIT_FLUSH_MS = 200;

/**
 * How much unsent output the master holds for one client before it starts
 * DROPPING that client's output. A client that stops reading (a hung
 * backend, a stalled probe) must not make the master grow without bound —
 * dtach does not buffer for a stuck client either. The client loses a stretch
 * of output, never the session; Mullion keeps its own scrollback, and the
 * next attach repaints the screen.
 */
export const MAX_CLIENT_BACKLOG_BYTES = 8 * 1024 * 1024;

/** How long a new client has to present the session token before it is dropped. */
export const AUTH_TIMEOUT_MS = 5_000;

/**
 * `-n`'s exit status when the endpoint is ALREADY served by another master —
 * distinct from 1 (every other failure), because the caller has to tell the
 * two apart: only in this case is the master on the endpoint someone else's
 * (see scope/windows.ts's token handling after a failed launch).
 */
export const EXIT_ENDPOINT_IN_USE = 3;

/** How long one endpoint probe may take before it answers "unknown". */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * Asks `endpoint` whether anything serves it: "live" (something accepted),
 * "dead" (provably nothing — ECONNREFUSED on a unix socket, ENOENT on a pipe
 * or a missing socket file), or "unknown" (any other error, or no answer in
 * time). The same tri-state, and the same rule that only the dead codes prove
 * an endpoint free, as src/services/unix-socket.ts's probeSocket().
 */
export function probeEndpoint(endpoint, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const probe = net.connect(endpoint);
    const settle = (result) => {
      clearTimeout(timer);
      probe.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle("unknown"), timeoutMs);
    probe.once("connect", () => settle("live"));
    probe.once("error", (err) => {
      const dead = err.code === "ECONNREFUSED" || err.code === "ENOENT";
      settle(dead ? "dead" : "unknown");
    });
  });
}

/** Resolves true when something accepts a connection on `endpoint`. */
export async function isServing(endpoint) {
  return (await probeEndpoint(endpoint)) === "live";
}

/**
 * `-n`: launches a detached master (`node <entry> --serve <endpoint> ...`)
 * and resolves with the exit status `-n` should report — 0 once the master
 * serves `endpoint`, EXIT_ENDPOINT_IN_USE if another master already serves
 * it, 1 if the master died
 * first, or it did not serve in time. Diagnostics go to `log`.
 */
export async function createSession(endpoint, program, args, opts) {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const readyTimeoutMs = opts.readyTimeoutMs ?? SERVE_READY_TIMEOUT_MS;
  const before = await probeEndpoint(endpoint);
  if (before === "live") {
    // dtach refuses an in-use socket the same way.
    log(`pty-host: ${endpoint} is already in use`);
    return EXIT_ENDPOINT_IN_USE;
  }
  // PROVABLY not served: a unix socket file still at this path is stale (a
  // master killed outright never closed it) and would make the new master's
  // listen() fail. Only a dead answer proves that — an "unknown" (EACCES, a
  // timeout, ...) leaves the file alone. A named pipe leaves nothing behind.
  if (before === "dead" && !isPipePath(endpoint) && existsSync(endpoint)) {
    try {
      unlinkSync(endpoint);
    } catch {
      // The new master's own listen() will report it.
    }
  }
  const master = spawn(process.execPath, [opts.entry, "--serve", endpoint, program, ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  let exitedEarly = null;
  master.once("exit", (code) => {
    exitedEarly = code ?? -1;
  });
  master.once("error", (err) => {
    exitedEarly = -1;
    log(`pty-host: could not start the master: ${err.message}`);
  });
  master.unref();
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (await isServing(endpoint)) return 0;
    if (exitedEarly !== null) {
      log(`pty-host: the master exited (code ${exitedEarly}) before serving ${endpoint}`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, SERVE_READY_POLL_MS));
  }
  log(`pty-host: the master did not serve ${endpoint} within ${readyTimeoutMs}ms`);
  return 1;
}

/** Whether `offered` is `token`, without leaking how much of it matched. */
function tokenMatches(offered, token) {
  const a = Buffer.from(offered);
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `--serve`: be the master. Listens FIRST, so an endpoint that is already
 * taken never starts the program; then runs `program` in a pseudo-terminal
 * and serves it to every client that attaches. Calls `onExit(code)` exactly
 * once, when the master is done — 1 when it could not serve or start the
 * program (or has no token), 0 once the program has exited and the clients
 * have been told.
 *
 * **Every client must present the session token first** (a HELLO frame,
 * protocol.mjs). Until it has, it receives nothing and its frames are not
 * applied; a wrong token, any other first frame, or no HELLO within
 * AUTH_TIMEOUT_MS closes the connection. The endpoint's OS access control is
 * the first gate — a unix socket's mode, or on Windows the pipe's ACL,
 * narrowed to this user and SYSTEM once listening (#2065) — and the token is
 * the second, the same posture as
 * the hook and control sockets' handshake tokens. The token is the session
 * backend's (scope/windows.ts writes it where only this user can read it);
 * it is removed from the program's environment, so nothing the session runs
 * ever sees it.
 *
 * Returns `stop()`, which kills the program (its exit then ends the master).
 */
export function serve(endpoint, program, args, opts) {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    opts.onExit(code);
  };
  const token = opts.token;
  if (typeof token !== "string" || token.length === 0) {
    log(`pty-host: refusing to serve ${endpoint} without a session token (${TOKEN_ENV})`);
    finish(1);
    return { stop: () => {} };
  }

  /** Clients that have presented the token — the only ones that get output. */
  const clients = new Set();
  let term = null;

  const server = net.createServer((socket) => {
    let authed = false;
    const authTimer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    const drop = () => {
      clearTimeout(authTimer);
      clients.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
    const onChunk = createDeframer((type, payload) => {
      if (!authed) {
        if (type === FRAME_HELLO && tokenMatches(payload, token)) {
          authed = true;
          clearTimeout(authTimer);
          clients.add(socket);
        } else {
          socket.destroy();
        }
        return;
      }
      if (!term) return;
      if (type === FRAME_DATA) {
        term.write(payload.toString("utf8"));
      } else if (type === FRAME_RESIZE && payload.length >= 4) {
        term.resize(payload.readUInt16BE(0), payload.readUInt16BE(2));
      }
    });
    socket.on("data", (chunk) => {
      try {
        onChunk(chunk);
      } catch {
        // A malformed frame (protocol.mjs's size cap): this client is broken.
        socket.destroy();
      }
    });
  });

  // `on`, not `once`: a server error after the first would otherwise be an
  // uncaught exception that takes the master down and orphans its program.
  server.on("error", (err) => {
    log(`pty-host: cannot serve ${endpoint}: ${err.message}`);
    if (term) term.kill();
    else finish(1);
  });

  server.listen(endpoint, () => {
    // The token is the master's alone: nothing the session runs inherits it.
    const env = { ...process.env };
    delete env[TOKEN_ENV];
    // A pipe's DEFAULT access lets every local user open it read-only:
    // narrow it to this user and SYSTEM (#2065; a no-op for a unix socket).
    // Not awaited — the program starts alongside; until the ACL lands, the
    // token gate above is what stands between another user and the session.
    void restrictPipeToCurrentUser(endpoint, { env, log: (msg) => log(`pty-host: ${msg}`) });
    try {
      const pty = require("node-pty");
      term = pty.spawn(program, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env,
      });
    } catch (err) {
      log(`pty-host: cannot start ${program}: ${err.message}`);
      server.close();
      finish(1);
      return;
    }
    term.onData((data) => {
      const frame = encodeFrame(FRAME_DATA, Buffer.from(data, "utf8"));
      for (const client of clients) {
        // Whole frames only, so a client that catches up is never mid-frame.
        if (client.writableLength < MAX_CLIENT_BACKLOG_BYTES) client.write(frame);
      }
    });
    term.onExit(({ exitCode }) => {
      const frame = encodeExit(exitCode ?? -1);
      for (const client of clients) client.end(frame);
      // A clean close also removes a unix socket file; a pipe has none.
      server.close();
      setTimeout(() => finish(0), EXIT_FLUSH_MS);
    });
  });

  return {
    stop: () => {
      if (term) term.kill();
      else server.close();
    },
  };
}
