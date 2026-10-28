import net from "node:net";
import { chmodSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  HANDSHAKE_TIMEOUT_MS,
  MAX_HANDSHAKE_BYTES,
  parseControlHandshake,
} from "./control-protocol.js";
import {
  encodeRelayHeader,
  MAX_RELAYED_CONNECTIONS,
  relayErrorFrame,
  RELAY_UNAVAILABLE_TIMEOUT_MS,
} from "./control-relay.js";
import { pipeNetSocketToChannel, type MuxChannel, type MuxConnection } from "./ssh-agent-mux.js";
import { reclaimSocketPath } from "./unix-socket.js";

// Issue #1656 — the agent half of the control relay: a local unix socket that
// speaks the control socket's NDJSON handshake, authenticates the session on
// THIS host (only the agent can resolve its session tokens), and carries the
// rest of the connection to the primary over a mux channel the primary's
// dial-in provides. Never full scope: a handshake without a live session's
// token is refused, whatever the primary's own auth settings are.

const MUX_POLL_MS = 100;

export interface ControlRelayAgentOptions {
  socketPath: string;
  /** The session id a presented hook token belongs to, or undefined. */
  resolveToken: (token: string) => string | undefined;
  /** The primary's current relay connection, or null while it is not dialled in. */
  getMux: () => MuxConnection | null;
  /** Tests only: shorten the wait for the primary to dial in. */
  unavailableTimeoutMs?: number;
  log?: {
    debug(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface ControlRelayAgentHandle {
  readonly socketPath: string;
  /** The primary's relay connection dropped: tell every relayed client, then
   * close it, so a pending `sessions.wait` fails loudly instead of hanging. */
  relayDown(reason: string): void;
  close(): Promise<void>;
}

function refuse(socket: net.Socket, status: number, error: string): void {
  if (socket.writable) socket.end(relayErrorFrame(status, error));
  else socket.destroy();
}

/**
 * The channel as `pipeNetSocketToChannel` sees it, except that when the
 * PRIMARY closes it while the local client is still connected, the client is
 * told why before its socket goes. A primary that shuts down gracefully
 * (a service restart) closes its channels one by one before it closes the
 * WebSocket, and the pipe destroys the local socket on each channel close, so
 * the "relay dropped" notice sent on the WebSocket's own close would reach
 * nobody. The pipe's close handler runs only after the frame is flushed.
 */
function notifyOnPeerClose(socket: net.Socket, channel: MuxChannel): MuxChannel {
  return {
    get id() {
      return channel.id;
    },
    get sendWindow() {
      return channel.sendWindow;
    },
    get closed() {
      return channel.closed;
    },
    send: (chunk) => channel.send(chunk),
    eof: () => channel.eof(),
    close: () => channel.close(),
    onData: (listener) => channel.onData(listener),
    onEof: (listener) => channel.onEof(listener),
    onDrain: (listener) => channel.onDrain(listener),
    acknowledgeConsumed: (count) => channel.acknowledgeConsumed(count),
    onClose: (listener) =>
      channel.onClose(() => {
        if (socket.destroyed || !socket.writable) {
          listener();
          return;
        }
        socket.end(
          relayErrorFrame(503, "relay-disconnected: the primary closed this relay connection"),
          listener,
        );
      }),
  };
}

export async function materializeControlRelaySocket(
  opts: ControlRelayAgentOptions,
): Promise<ControlRelayAgentHandle> {
  const openSockets = new Set<net.Socket>();
  /** Sockets that already have a channel: the ones relayDown() must notify. */
  const relayed = new Set<net.Socket>();
  const unavailableMs = opts.unavailableTimeoutMs ?? RELAY_UNAVAILABLE_TIMEOUT_MS;

  const waitForMux = async (): Promise<MuxConnection | null> => {
    const deadline = Date.now() + unavailableMs;
    for (;;) {
      const mux = opts.getMux();
      if (mux !== null) return mux;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, MUX_POLL_MS).unref());
    }
  };

  const onConnection = (socket: net.Socket) => {
    if (openSockets.size >= MAX_RELAYED_CONNECTIONS) {
      refuse(socket, 503, "too many relayed connections on this host");
      return;
    }
    openSockets.add(socket);
    socket.once("close", () => {
      openSockets.delete(socket);
      relayed.delete(socket);
    });
    socket.on("error", (err) => opts.log?.debug({ err }, "control-relay: local socket error"));

    const decoder = new StringDecoder("utf8");
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      opts.log?.warn({}, "control-relay: a local client never completed its handshake");
      socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref();

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        if (buffer.length > MAX_HANDSHAKE_BYTES) {
          clearTimeout(timer);
          socket.destroy();
        }
        return;
      }
      clearTimeout(timer);
      if (newline > MAX_HANDSHAKE_BYTES) {
        socket.destroy();
        return;
      }
      socket.off("data", onData);
      socket.pause();
      const line = decoder.write(buffer.subarray(0, newline));
      // Everything after the handshake line belongs to the first request.
      const rest = buffer.subarray(newline + 1);
      void start(socket, line, rest);
    };
    socket.on("data", onData);
  };

  const start = async (socket: net.Socket, line: string, rest: Buffer): Promise<void> => {
    const handshake = parseControlHandshake(line);
    const sessionId = handshake?.token ? opts.resolveToken(handshake.token) : undefined;
    if (sessionId === undefined) {
      opts.log?.warn({}, "control-relay: refusing a handshake with no live session token");
      refuse(socket, 401, "invalid or missing session token");
      return;
    }
    const mux = await waitForMux();
    if (mux === null) {
      refuse(
        socket,
        503,
        "relay-unavailable: the primary has not connected its control relay to this host",
      );
      return;
    }
    let channel: MuxChannel;
    try {
      channel = await mux.openChannel();
    } catch (err) {
      opts.log?.debug({ err }, "control-relay: could not open a relay channel");
      refuse(socket, 503, "relay-unavailable: could not open a channel to the primary");
      return;
    }
    if (socket.destroyed) {
      channel.close();
      return;
    }
    try {
      channel.send(encodeRelayHeader(sessionId));
    } catch (err) {
      // The channel closed in the same tick it was acknowledged.
      opts.log?.debug({ err }, "control-relay: the relay channel closed before the header");
      refuse(socket, 503, "relay-unavailable: the relay channel closed");
      return;
    }
    if (channel.closed) {
      // The primary closed it between the open and the header (a shutdown).
      refuse(socket, 503, "relay-disconnected: the primary closed this relay connection");
      return;
    }
    relayed.add(socket);
    if (rest.length > 0) socket.unshift(rest);
    pipeNetSocketToChannel(socket, notifyOnPeerClose(socket, channel));
    socket.resume();
  };

  await reclaimSocketPath(opts.socketPath);
  const server = net.createServer(onConnection);
  server.maxConnections = MAX_RELAYED_CONNECTIONS * 2;
  let previousUmask: number | null = null;
  try {
    previousUmask = process.umask(0o077);
  } catch {
    previousUmask = null;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
      if (previousUmask !== null) process.umask(previousUmask);
      previousUmask = null;
    });
  } finally {
    if (previousUmask !== null) process.umask(previousUmask);
  }
  chmodSync(opts.socketPath, 0o600);

  return {
    socketPath: opts.socketPath,
    relayDown(reason) {
      for (const socket of relayed) {
        if (socket.writable) {
          socket.end(relayErrorFrame(503, `relay-disconnected: ${reason}`));
        }
      }
      relayed.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of openSockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
