import path from "node:path";
import { Duplex } from "node:stream";

// Issue #1656 — the agent-to-primary control relay. A session on an agent host
// cannot reach the primary's control socket, so the agent serves a local
// `relay.sock` and carries each connection to the primary over a mux channel
// the PRIMARY dialled (`/internal/ws/control-relay`, the SSH-agent bridge's
// shape: an agent never dials out). This module is what both ends share.

/** The agent's local socket sessions on that host reach the primary through. */
export function controlRelaySocketPath(sessionsDir: string): string {
  return path.join(sessionsDir, "relay.sock");
}

/** How long a local client waits for the primary to be connected (it dials
 * in, so a freshly booted agent can be briefly unreachable) before it is told
 * the relay is unavailable, rather than hanging on a socket nothing serves. */
export const RELAY_UNAVAILABLE_TIMEOUT_MS = 5_000;

/** The most the relayed first line (the header) may be. */
export const MAX_RELAY_HEADER_BYTES = 4 * 1024;

/** Cap on simultaneously relayed connections per host, on both ends. */
export const MAX_RELAYED_CONNECTIONS = 64;

const RELAY_VERSION = 1;

/** The first line on a relay channel, written by the AGENT after it has
 * validated the session's token itself. It is the only place the session id
 * is set: the primary pins the connection to it and ignores any token or
 * session id in later frames. */
export function encodeRelayHeader(sessionId: string): Buffer {
  return Buffer.from(`${JSON.stringify({ relay: RELAY_VERSION, sessionId })}\n`, "utf8");
}

export function parseRelayHeader(line: string): { sessionId: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { relay, sessionId } = value as { relay?: unknown; sessionId?: unknown };
  if (relay !== RELAY_VERSION) return null;
  if (typeof sessionId !== "string" || !/^[1-9]\d{0,14}$/.test(sessionId)) return null;
  return { sessionId };
}

/** An error frame in the control socket's own reply shape, so a CLI/MCP client
 * reading the relay sees what it would see from the real socket. */
export function relayErrorFrame(status: number, error: string): Buffer {
  return Buffer.from(`${JSON.stringify({ id: null, ok: false, status, error })}\n`, "utf8");
}

const MAX_PAIR_CHUNK_BYTES = 64 * 1024;

class PairedHalf extends Duplex {
  peer!: PairedHalf;
  /** The write callback held back until the peer has drained what we pushed. */
  private held: (() => void) | null = null;

  override _read(): void {
    const release = this.peer.held;
    this.peer.held = null;
    release?.();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    // Delivered in socket-sized pieces: pipeNetSocketToChannel assumes a real
    // socket's chunks (<= 64 KiB) and can never send one larger than the mux
    // window, so a whole 2 MiB reply frame as one chunk would stall forever.
    let ok = true;
    for (let at = 0; at < chunk.length; at += MAX_PAIR_CHUNK_BYTES) {
      ok = this.peer.push(chunk.subarray(at, at + MAX_PAIR_CHUNK_BYTES)) && ok;
    }
    if (ok) cb();
    else this.held = () => cb();
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.peer.push(null);
    cb();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.held = null;
    if (!this.peer.destroyed) this.peer.destroy();
    cb(err);
  }
}

/**
 * Two connected in-memory sockets: what is written to one is read from the
 * other, with backpressure. The primary hands one end to the control
 * socket's own connection handler (so a relayed connection runs the exact
 * framing, limits and overload logic a local one does) and pipes the other
 * to the mux channel. Typed as `Duplex`; the handler only uses the stream
 * surface of a `net.Socket`.
 */
export function createDuplexPair(): [Duplex, Duplex] {
  const a = new PairedHalf();
  const b = new PairedHalf();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
