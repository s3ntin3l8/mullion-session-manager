// The pty-host master's logic, importable — pty-host.mjs is its command-line
// entry point (see that file's header for what pty-host is and why it
// exists). Split out so the backend's tests can drive a real master
// in-process rather than only through a child process.
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { FRAME_DATA, FRAME_RESIZE, createDeframer, encodeExit, encodeFrame } from "./protocol.mjs";

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

/** Resolves true when something accepts a connection on `endpoint`. */
export function isServing(endpoint) {
  return new Promise((resolve) => {
    const probe = net.connect(endpoint);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * `-n`: launches a detached master (`node <entry> --serve <endpoint> ...`)
 * and resolves with the exit status `-n` should report — 0 once the master
 * serves `endpoint`, 1 if the endpoint is already served, the master died
 * first, or it did not serve in time. Diagnostics go to `log`.
 */
export async function createSession(endpoint, program, args, opts) {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const readyTimeoutMs = opts.readyTimeoutMs ?? SERVE_READY_TIMEOUT_MS;
  if (await isServing(endpoint)) {
    // dtach refuses an in-use socket the same way.
    log(`pty-host: ${endpoint} is already in use`);
    return 1;
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

/**
 * `--serve`: be the master. Listens FIRST, so an endpoint that is already
 * taken never starts the program; then runs `program` in a pseudo-terminal
 * and serves it to every client that attaches. Calls `onExit(code)` when the
 * master is done — 1 when it could not serve or start the program, 0 once
 * the program has exited and the clients have been told.
 *
 * Returns `stop()`, which kills the program (its exit then ends the master).
 */
export function serve(endpoint, program, args, opts) {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const clients = new Set();
  let term = null;

  const server = net.createServer((socket) => {
    clients.add(socket);
    const drop = () => clients.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
    const onChunk = createDeframer((type, payload) => {
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

  server.once("error", (err) => {
    log(`pty-host: cannot serve ${endpoint}: ${err.message}`);
    opts.onExit(1);
  });

  server.listen(endpoint, () => {
    try {
      const pty = require("node-pty");
      term = pty.spawn(program, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (err) {
      log(`pty-host: cannot start ${program}: ${err.message}`);
      server.close();
      opts.onExit(1);
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
      server.close();
      setTimeout(() => opts.onExit(0), EXIT_FLUSH_MS);
    });
  });

  return {
    stop: () => {
      if (term) term.kill();
      else server.close();
    },
  };
}
