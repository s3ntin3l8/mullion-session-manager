import net from "node:net";
import type { IPty } from "node-pty";
import {
  FRAME_DATA,
  FRAME_EXIT,
  FRAME_VERSION,
  PROTOCOL_VERSION,
  createDeframer,
  decodeVersion,
  encodeFrame,
  encodeHello,
  encodeResize,
  masterCompatibility,
} from "../pty-host/protocol.mjs";

/** How much unsent input may wait for the master before more is dropped. */
export const MAX_INPUT_BACKLOG_BYTES = 8 * 1024 * 1024;

/**
 * The part of a node-pty process that a Session drives its attach client
 * through — output, exit, input, resize, detach. Narrowed to this surface so
 * an attach client does not have to BE a pseudo-terminal: on Windows it is a
 * connection to a pty-host master instead (issue #1728).
 */
export type AttachClient = Pick<IPty, "onData" | "write" | "resize" | "kill"> & {
  onExit: (listener: (event: AttachExit) => void) => { dispose(): void };
};

/**
 * How an attach client ended. `incompatible` is set when the master speaks a
 * protocol this build cannot (issue #2168): the session's program is still
 * running, it just cannot be attached - which the caller must not present as
 * the program having exited.
 */
export interface AttachExit {
  exitCode: number;
  signal?: number;
  incompatible?: { masterVersion: number; minClient: number };
}

type Listener<T> = (event: T) => void;

/** A minimal node-pty-style event: subscribing returns a disposable. */
function emitter<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    event: (listener: Listener<T>) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: (value: T) => {
      for (const listener of [...listeners]) listener(value);
    },
  };
}

/**
 * Attaches to the pty-host master serving `endpoint` (src/pty-host/) — the
 * Windows counterpart of spawning `dtach -a <socket>` under node-pty.
 *
 * In-process, not a second pseudo-terminal: nesting one ConPTY inside
 * another re-renders the inner terminal's output and garbles a TUI, so the
 * client is a plain connection that speaks the master's framed protocol.
 *
 * Behaves like the dtach attach client it replaces, as far as a Session can
 * tell:
 *   - output arrives through `onData`, as strings;
 *   - `onExit` fires exactly once — when the program exits (with its exit
 *     code), after `kill()` (0), or when the connection ends any other way
 *     (1, like `dtach -a` on a missing session): the endpoint cannot be
 *     reached, the master refused this client's token, or the master went
 *     away without reporting an exit. A refusal must never read as a clean
 *     exit — it is exactly the case of a live session behind a stale token;
 *   - `kill()` DETACHES. It closes this connection; the master and its
 *     program keep running, exactly as killing a `dtach -a` client does.
 *
 * The session `token` (pty-host-token.ts) is the first frame and the initial
 * size the second — both written here, before the connection opens, which
 * net.Socket queues in order ahead of anything written later. The size also
 * makes ConPTY repaint the screen for this client (see pty-host.mjs).
 *
 * Input is dropped, not queued, once more than MAX_INPUT_BACKLOG_BYTES is
 * waiting to be sent — the mirror of the master's own per-client cap, so a
 * stuck master cannot make the backend buffer without bound.
 */
export function attachPtyHost(
  endpoint: string,
  size: { cols: number; rows: number },
  token: string,
): AttachClient {
  const data = emitter<string>();
  const exit = emitter<AttachExit>();
  const socket = net.createConnection(endpoint);
  /** The program's exit code, once the master has reported it. */
  let exitCode: number | null = null;
  let exited = false;
  /** Whether WE ended the connection (kill() — a detach, not a failure). */
  let detached = false;
  /** Set when the master's VERSION frame says this build cannot talk to it. */
  let incompatible: AttachExit["incompatible"];

  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    exit.fire(incompatible ? { exitCode: code, incompatible } : { exitCode: code });
  };

  const onChunk = createDeframer((type, payload) => {
    if (incompatible) return;
    if (type === FRAME_DATA) data.fire(payload.toString("utf8"));
    else if (type === FRAME_EXIT && payload.length >= 4) exitCode = payload.readInt32BE(0);
    else if (type === FRAME_VERSION) {
      const verdict = masterCompatibility(decodeVersion(payload), PROTOCOL_VERSION);
      if (!verdict.compatible) {
        incompatible = { masterVersion: verdict.masterVersion, minClient: verdict.minClient };
        socket.destroy();
      }
    }
  });

  socket.write(encodeHello(token));
  socket.write(encodeResize(size.cols, size.rows));
  socket.on("data", (chunk: Buffer) => {
    try {
      onChunk(chunk);
    } catch {
      // A malformed frame from the master: treat the connection as lost.
      socket.destroy();
    }
  });
  // A program exit the master reported wins; then our own detach (0); any
  // other end — unreachable, refused, the master gone without an EXIT — is a
  // failed attach (1).
  socket.on("error", () => {});
  socket.on("close", () => finish(exitCode ?? (detached ? 0 : 1)));

  return {
    onData: data.event,
    onExit: exit.event,
    write: (input: string | Buffer) => {
      if (socket.destroyed || socket.writableLength >= MAX_INPUT_BACKLOG_BYTES) return;
      const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
      socket.write(encodeFrame(FRAME_DATA, bytes));
    },
    resize: (cols: number, rows: number) => {
      if (!socket.destroyed) socket.write(encodeResize(cols, rows));
    },
    kill: () => {
      detached = true;
      socket.destroy();
    },
  };
}
