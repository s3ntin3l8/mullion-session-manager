import net from "node:net";
import type { IPty } from "node-pty";
import {
  FRAME_DATA,
  FRAME_EXIT,
  createDeframer,
  encodeFrame,
  encodeResize,
} from "../pty-host/protocol.mjs";

/**
 * The part of a node-pty process that a Session drives its attach client
 * through — output, exit, input, resize, detach. Narrowed to this surface so
 * an attach client does not have to BE a pseudo-terminal: on Windows it is a
 * connection to a pty-host master instead (issue #1728).
 */
export type AttachClient = Pick<IPty, "onData" | "onExit" | "write" | "resize" | "kill">;

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
 *     code), when the master goes away, when the endpoint cannot be reached
 *     at all (exit code 1, like `dtach -a` on a missing session), or after
 *     `kill()`;
 *   - `kill()` DETACHES. It closes this connection; the master and its
 *     program keep running, exactly as killing a `dtach -a` client does.
 *
 * The initial size is sent as the first frame, which also makes ConPTY
 * repaint the screen for this client — see pty-host.mjs's header.
 */
export function attachPtyHost(
  endpoint: string,
  size: { cols: number; rows: number },
): AttachClient {
  const data = emitter<string>();
  const exit = emitter<{ exitCode: number; signal?: number }>();
  const socket = net.createConnection(endpoint);
  let exitCode: number | null = null;
  let exited = false;

  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    exit.fire({ exitCode: code });
  };

  const onChunk = createDeframer((type, payload) => {
    if (type === FRAME_DATA) data.fire(payload.toString("utf8"));
    else if (type === FRAME_EXIT && payload.length >= 4) exitCode = payload.readInt32BE(0);
  });

  socket.on("connect", () => socket.write(encodeResize(size.cols, size.rows)));
  socket.on("data", (chunk: Buffer) => {
    try {
      onChunk(chunk);
    } catch {
      // A malformed frame from the master: treat the connection as lost.
      socket.destroy();
    }
  });
  // An unreachable endpoint (no session) reads as a failed attach — code 1,
  // the same thing `dtach -a` reports for a missing session.
  socket.on("error", () => {
    if (exitCode === null) exitCode = 1;
  });
  socket.on("close", () => finish(exitCode ?? 0));

  return {
    onData: data.event,
    onExit: exit.event,
    write: (input: string | Buffer) => {
      if (socket.destroyed) return;
      const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
      socket.write(encodeFrame(FRAME_DATA, bytes));
    },
    resize: (cols: number, rows: number) => {
      if (!socket.destroyed) socket.write(encodeResize(cols, rows));
    },
    kill: () => {
      socket.destroy();
    },
  };
}
