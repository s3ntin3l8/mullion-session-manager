import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket } from "ws";
import type { ConnectedAgentChannel } from "../plugins/agent-channel.js";
import { ChannelSocket } from "./channel-socket.js";
import { createRequestSink, type ChannelSink, type HostTransport } from "./agent-channel-tunnel.js";
import type { MuxChannel } from "./ssh-agent-mux.js";
import {
  AGENT_CHANNEL_MAX_HEAD_BYTES,
  AGENT_CHANNEL_STREAM_KINDS,
  type AgentChannelStreamKind,
  type ChannelStreamAcceptHead,
  type ChannelStreamOpenHead,
} from "../shared/agent-channel.js";

// Issue #2571 — the four streams over the outbound agent channel. One mux
// channel carries one stream: the primary sends an open head (`{stream,
// query, resumed}` + "\n"), the agent answers an accept head (`{status}` +
// "\n"), and from then on both sides exchange the framed WebSocket-shaped
// messages of services/channel-socket.ts. The agent runs the SAME handlers
// the inbound `/internal/ws/*` routes run (routes/internal-streams.ts), so
// validation and authorization do not fork. Contract: docs/agent-channel.md.
//
// Nothing here falls back to another transport: when the channel is down the
// stream fails as unreachable, and a refused stream is a rejection.

/** How long the primary waits for the agent's accept head. */
const STREAM_ACCEPT_TIMEOUT_MS = 30_000;

// --- primary side ----------------------------------------------------------

// Which stream identities this primary has opened over a host's channel, and
// the channel connection they were opened on. A later open on a DIFFERENT
// connection is a re-establishment after the link was lost: it is flagged
// `resumed` explicitly instead of looking like a first attach.
const openedStreams = new WeakMap<FastifyInstance, Map<string, number>>();

/** `identity` distinguishes streams of one kind (an attach's session id). */
export function openChannelStream(
  app: FastifyInstance,
  entry: ConnectedAgentChannel,
  kind: AgentChannelStreamKind,
  query: Record<string, string> | undefined,
  identity = "",
): NodeWebSocket {
  const socket = new ChannelSocket({ expectHead: true });
  let seen = openedStreams.get(app);
  if (!seen) openedStreams.set(app, (seen = new Map()));
  const key = `${entry.hostId}\0${kind}\0${identity}`;
  const resumed = seen.has(key) && seen.get(key) !== entry.connectedAt;
  seen.set(key, entry.connectedAt);

  const head: ChannelStreamOpenHead = {
    stream: kind,
    ...(query ? { query } : {}),
    ...(resumed ? { resumed: true } : {}),
  };
  const timer = setTimeout(() => {
    if (socket.readyState === socket.CONNECTING) {
      socket.failToOpen(new Error("timed out waiting for the agent to accept the stream"));
    }
  }, STREAM_ACCEPT_TIMEOUT_MS);
  timer.unref?.();
  socket.once("open", () => clearTimeout(timer));
  socket.once("close", () => clearTimeout(timer));

  // A preview WebSocket (Vite HMR) counts against its own cap, apart from the
  // HTTP preview forward's: open dev tabs hold their sockets for good, so they
  // must neither fill every stream slot (starving attach / events / relay) nor
  // eat the slots preview assets need.
  const openOpts =
    kind === "preview" || kind === "configured-preview" ? { previewWs: true } : { stream: true };
  entry.mux.openChannel(openOpts).then(
    (channel) => {
      socket.bind(channel);
      channel.onData((chunk) => socket.ingest(chunk));
      channel.onEof(() => socket.ingestEof());
      socket.sendRaw(Buffer.from(`${JSON.stringify(head)}\n`, "utf8"));
    },
    (err: unknown) => socket.failToOpen(err instanceof Error ? err : new Error(String(err))),
  );
  return socket as unknown as NodeWebSocket;
}

/** The query string of `/internal/ws/attach`, as the open head carries it. */
export function attachStreamQuery(opts: {
  id: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  projectId?: number;
  env?: Record<string, string>;
}): Record<string, string> {
  return {
    id: opts.id,
    cwd: opts.cwd,
    command: opts.command,
    cols: String(opts.cols),
    rows: String(opts.rows),
    ...(opts.projectId !== undefined ? { projectId: String(opts.projectId) } : {}),
    ...(opts.env !== undefined ? { env: JSON.stringify(opts.env) } : {}),
  };
}

/**
 * Picks the stream transport from negotiated support: the stream over the
 * host's outbound channel when it negotiated `channel-streams`; a stream that
 * fails as unreachable when it negotiated it and the channel is down (never the
 * advertised URL: a stream must not silently change transport); null for a
 * legacy peer, which keeps the inbound WebSocket.
 */
export function openStreamOnTransport(
  app: FastifyInstance | undefined,
  transport: HostTransport | undefined,
  kind: AgentChannelStreamKind,
  identity: string,
  query?: Record<string, string>,
): NodeWebSocket | null {
  if (!app || !transport || transport.kind === "inbound") return null;
  if (transport.kind === "channel-down") {
    return failedChannelStream(
      "outbound channel is not connected (not falling back to the advertised URL)",
    );
  }
  return openChannelStream(app, transport.channel, kind, query, identity);
}

/** A stream whose channel is down. Fails like an unreachable host would,
 * asynchronously so the caller can attach its listeners first. */
export function failedChannelStream(message: string): NodeWebSocket {
  const socket = new ChannelSocket({ expectHead: true });
  setImmediate(() => socket.failToOpen(new Error(message)));
  return socket as unknown as NodeWebSocket;
}

// --- agent side ------------------------------------------------------------

export interface AgentStreamHandlers {
  /** Returns why the attach must be refused, or null (the route's preValidation). */
  validateAttach(query: Record<string, string | undefined>): string | null;
  attach(socket: ChannelSocket, query: Record<string, string | undefined>): void;
  events(socket: ChannelSocket, query: { cursors?: string }): void;
  controlRelay(socket: ChannelSocket): void;
  sshAgent(socket: ChannelSocket): void;
  /** Returns why the preview WebSocket must be refused, or null (#2620). */
  validatePreview(query: Record<string, string | undefined>): string | null;
  preview(socket: ChannelSocket, query: Record<string, string | undefined>): void;
  validateConfiguredPreview(query: Record<string, string | undefined>): string | null;
  configuredPreview(socket: ChannelSocket, query: Record<string, string | undefined>): void;
}

function parseStreamHead(raw: string): ChannelStreamOpenHead | null {
  try {
    const head = JSON.parse(raw) as ChannelStreamOpenHead;
    if (typeof head !== "object" || head === null || typeof head.stream !== "string") return null;
    return head;
  } catch {
    return null;
  }
}

/** Query values must be strings; anything else is dropped, not coerced. */
function stringQuery(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

function acceptHead(status: number, message?: string, resumed?: boolean): Buffer {
  const head: ChannelStreamAcceptHead = {
    status,
    ...(message ? { message } : {}),
    ...(resumed ? { resumed: true } : {}),
  };
  return Buffer.from(`${JSON.stringify(head)}\n`, "utf8");
}

/**
 * Serves one peer-opened channel on the agent: reads the first line and hands
 * the channel to the stream it names, or to the request/response tunnel when
 * the line is a request head. The channel is owned by one set of listeners
 * (registered here, once) because a listener added while a chunk is being
 * dispatched would receive that same chunk again.
 */
export function serveChannel(
  app: FastifyInstance,
  channel: MuxChannel,
  authToken: string,
  handlers: AgentStreamHandlers,
  peerId?: string,
): void {
  let sink: ChannelSink | null = null;
  let pending = Buffer.alloc(0);
  let pendingEof = false;
  let refused = false;

  const startStream = (head: ChannelStreamOpenHead, rest: Buffer): ChannelSink | null => {
    const socket = new ChannelSocket({ expectHead: false });
    socket.bind(channel);
    const reject = (status: number, message: string): null => {
      socket.sendRaw(acceptHead(status, message));
      socket.close();
      return null;
    };
    if (!(AGENT_CHANNEL_STREAM_KINDS as readonly string[]).includes(head.stream)) {
      return reject(404, "unknown stream");
    }
    const query = stringQuery(head.query);
    if (head.stream === "attach") {
      const error = handlers.validateAttach(query);
      if (error !== null) return reject(400, error);
    } else if (head.stream === "preview") {
      const error = handlers.validatePreview(query);
      if (error !== null) return reject(400, error);
    } else if (head.stream === "configured-preview") {
      const error = handlers.validateConfiguredPreview(query);
      if (error !== null) return reject(400, error);
    }
    socket.sendRaw(acceptHead(200, undefined, head.resumed === true));
    try {
      if (head.stream === "attach") handlers.attach(socket, query);
      else if (head.stream === "events") handlers.events(socket, query);
      else if (head.stream === "control-relay") handlers.controlRelay(socket);
      else if (head.stream === "preview") handlers.preview(socket, query);
      else if (head.stream === "configured-preview") handlers.configuredPreview(socket, query);
      else handlers.sshAgent(socket);
    } catch (err) {
      app.log.warn({ err, stream: head.stream }, "[agent-channel] stream handler failed");
      socket.close();
      return null;
    }
    // The open head was never handed to ingest(), so its bytes are released here.
    if (rest.length > 0) socket.ingest(rest);
    return { data: (c) => socket.ingest(c), eof: () => socket.ingestEof() };
  };

  const decide = (): void => {
    const nl = pending.indexOf(0x0a);
    if (nl === -1) {
      if (pending.length > AGENT_CHANNEL_MAX_HEAD_BYTES) channel.close();
      return;
    }
    const head = parseStreamHead(pending.subarray(0, nl).toString("utf8"));
    if (head === null || !("stream" in head)) {
      // A request head (no `stream` key) or garbage: the tunnel parses and
      // answers it, including the 400 for a malformed one.
      sink = createRequestSink(app, channel, authToken, peerId);
      const all = pending;
      pending = Buffer.alloc(0);
      sink.data(all);
    } else {
      channel.acknowledgeConsumed(nl + 1);
      const rest = pending.subarray(nl + 1);
      pending = Buffer.alloc(0);
      sink = startStream(head, rest);
      if (sink === null) {
        refused = true;
        return;
      }
    }
    if (pendingEof) sink.eof();
  };

  channel.onData((chunk) => {
    if (sink) return sink.data(chunk);
    if (refused) return;
    pending = Buffer.concat([pending, chunk]);
    decide();
  });
  channel.onEof(() => {
    if (sink) return sink.eof();
    if (refused) return;
    pendingEof = true;
    // EOF before a complete head: the tunnel answers a malformed request.
    if (pending.length > 0 && pending.indexOf(0x0a) === -1) {
      sink = createRequestSink(app, channel, authToken, peerId);
      sink.data(pending);
      pending = Buffer.alloc(0);
      sink.eof();
    }
  });
}
