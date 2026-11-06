// The outbound agent channel's wire contract (issue #2450, epic #2230): the
// ONE place both ends read for the handshake shape, limits and close codes.
// The agent (daemon) dials the primary's `GET /ws/agent-channel`; the first
// frame is `{type:"auth", hostId, credential, protocol}`, the reply
// `{type:"ready", ...}` or `{type:"error", code, message}` followed by a close.
// After `ready` the socket carries the binary mux of services/ssh-agent-mux.ts.
// docs/agent-channel.md is the prose contract.

import {
  isProtocolCompatible,
  PROTOCOL_VERSION,
  type AgentProtocolInfo,
} from "./agent-protocol.js";

export const AGENT_CHANNEL_PATH = "/ws/agent-channel";

/** A peer that opens the socket but never sends its first frame is dropped. */
export const AGENT_CHANNEL_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Channels per connection; a peer's Open beyond this is refused (OpenFail). */
export const AGENT_CHANNEL_MAX_CHANNELS = 64;
/** Slots kept for request/response exchanges. Streams (attach, events, control
 * relay, ssh-agent, preview) live as long as their user, so waiting never frees
 * a slot for a request when streams hold them all. */
export const AGENT_CHANNEL_REQUEST_RESERVED_CHANNELS = AGENT_CHANNEL_MAX_CHANNELS / 2;
/** Most channels a connection holds once a stream is opened: a stream open
 * beyond this is refused, so at least `AGENT_CHANNEL_REQUEST_RESERVED_CHANNELS`
 * slots are never taken by streams. */
export const AGENT_CHANNEL_MAX_STREAM_CHANNELS =
  AGENT_CHANNEL_MAX_CHANNELS - AGENT_CHANNEL_REQUEST_RESERVED_CHANNELS;
/** Queued-but-unsent bytes at which a side closes the connection. */
export const AGENT_CHANNEL_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** Largest first frame accepted, so the handshake cannot be used to buffer. */
export const AGENT_CHANNEL_MAX_HANDSHAKE_BYTES = 16 * 1024;

/** Reconnect backoff: doubles from min to max with +-20% jitter. */
export const AGENT_CHANNEL_BACKOFF = { minMs: 1_000, maxMs: 60_000 } as const;
/** A rejected identity or protocol will not fix itself quickly: retry slowly. */
export const AGENT_CHANNEL_REJECTED_RETRY_MS = 5 * 60_000;
/** Superseded by a newer connection for the same host (two daemons sharing one
 * credential): redialing at once would kick the other side in a loop, so wait
 * this long, with the same +-20% jitter as the backoff so two clients drift
 * apart rather than moving in lockstep. */
export const AGENT_CHANNEL_SUPERSEDED_RETRY_MS = 5 * 60_000;
/** The primary warns when one host is superseded twice within this window. */
export const AGENT_CHANNEL_SUPERSEDE_WARN_WINDOW_MS = 60_000;

/** WebSocket close codes (4000-4999 are application-defined). */
export const AgentChannelCloseCode = {
  /** A newer connection for the same host took over. Do not fight it. */
  Superseded: 4001,
  /** The host's machine identity was revoked or the host deleted. */
  Revoked: 4002,
  /** The primary is shutting down. */
  Shutdown: 4003,
  /** The credential the channel authenticated with expired, or its
   * previous-credential grace window ended (#2451). Unlike Revoked the
   * identity may be fine: the agent redials with its renewed credential. */
  Expired: 4004,
} as const;

/** The operation name an agent advertises when it serves request/response
 * operations over the channel (#2451). */
export const AGENT_CHANNEL_REQUESTS_OPERATION = "channel-requests";

/** Advertised by an agent that also serves streams over the channel (#2571):
 * terminal attach, events, the control relay and the ssh-agent stream, plus
 * (#2620) the two preview WebSockets. The browser WS stays on the inbound
 * transport. Preview HTTP and the file-browser transfers are request/response
 * exchanges, so they ride `channel-requests`. */
export const AGENT_CHANNEL_STREAMS_OPERATION = "channel-streams";

/** The stream kinds a channel can carry, named in the stream open head. */
export const AGENT_CHANNEL_STREAM_KINDS = [
  "attach",
  "events",
  "control-relay",
  "ssh-agent",
  "preview",
  "configured-preview",
] as const;
export type AgentChannelStreamKind = (typeof AGENT_CHANNEL_STREAM_KINDS)[number];

/** Largest single WebSocket-shaped message carried on a stream channel; the
 * same 1 MiB cap the inbound sockets enforce (`maxPayload`). */
export const AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES = 1024 * 1024;

/** The first line of a stream channel (primary -> agent): JSON + "\n". It
 * is told apart from a request head by the `stream` key. */
export interface ChannelStreamOpenHead {
  stream: AgentChannelStreamKind;
  /** attach: the query params of `/internal/ws/attach`; events: `{cursors:"1"}`;
   * preview: `{port, path}`; configured-preview: `{url}`. */
  query?: Record<string, string>;
  /** True when the primary had a stream of this kind for this host before the
   * channel was lost, so the agent knows this is a re-establishment (#2571). */
  resumed?: boolean;
}

/** The agent's answer (JSON + "\n"): 200 accepts, anything else rejects. */
export interface ChannelStreamAcceptHead {
  status: number;
  message?: string;
  /** Echo of `resumed`, so the primary's socket can surface it explicitly. */
  resumed?: boolean;
}

/** How often an open channel's credential is re-validated (#2451). */
export const AGENT_CHANNEL_CREDENTIAL_RECHECK_MS = 60_000;

/** Largest request/response head (method, path, headers) on a tunnelled request. */
export const AGENT_CHANNEL_MAX_HEAD_BYTES = 64 * 1024;
/** Largest tunnelled response body the primary buffers (downloads, previews). */
export const AGENT_CHANNEL_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Default body limit on tunnelled requests. Sized to cover ordinary JSON RPCs while bounding worst-case buffering. */
export const AGENT_CHANNEL_DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** Default body limit on tunnelled responses for non-download operations. */
export const AGENT_CHANNEL_DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** How long channelFetch waits for a channel slot to become free when at capacity. */
export const AGENT_CHANNEL_SLOT_WAIT_MS = 5_000;
/** Backstop on the slot wait itself (the mux enforces `AGENT_CHANNEL_SLOT_WAIT_MS`;
 * this only covers a mux that never settles). The wait is not charged to the
 * request: its timeout starts when the slot is granted. */
export const AGENT_CHANNEL_SLOT_WAIT_GRACE_MS = 250;

/** The first line of a tunnelled request: JSON, terminated by "\n"; the raw
 * request body follows, then EOF. */
export interface ChannelRequestHead {
  method: string;
  /** Path and query, verbatim (always under /internal/). */
  path: string;
  headers: Record<string, string>;
}

/** The first line of a tunnelled response: JSON, terminated by "\n"; the raw
 * body follows, then EOF. */
export interface ChannelResponseHead {
  status: number;
  /** A repeated header (set-cookie) is an array. */
  headers: Record<string, string | string[]>;
}

/** What a channel carries given what both ends negotiated. */
export function carriedOperationsFor(negotiated: readonly string[]): string[] {
  return [AGENT_CHANNEL_REQUESTS_OPERATION, AGENT_CHANNEL_STREAMS_OPERATION].filter((op) =>
    negotiated.includes(op),
  );
}

export type AgentChannelErrorCode =
  "bad-handshake" | "invalid-credential" | "revoked" | "incompatible-protocol";

export interface AgentChannelAuthFrame {
  type: "auth";
  hostId: string;
  credential: string;
  protocol: AgentProtocolInfo;
}

export interface AgentChannelReadyFrame {
  type: "ready";
  /** The server-issued host identity this channel is bound to. */
  hostId: string;
  /** The primary's own protocol revision. */
  protocolVersion: number;
  /** Operations both ends advertise (the support set, not what is carried). */
  negotiatedOperations: string[];
  /** Operations actually carried over this channel: "channel-requests" (#2451)
   * and "channel-streams" (#2571) once both ends negotiate them. Never claim
   * one earlier. */
  carriedOperations: string[];
}

export interface AgentChannelErrorFrame {
  type: "error";
  code: AgentChannelErrorCode;
  message: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function parseAuthFrame(value: unknown): AgentChannelAuthFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.type !== "auth") return null;
  if (typeof v.hostId !== "string" || v.hostId.length === 0 || v.hostId.length > 128) return null;
  if (typeof v.credential !== "string" || v.credential.length === 0 || v.credential.length > 512) {
    return null;
  }
  const p = v.protocol as Record<string, unknown> | null;
  if (typeof p !== "object" || p === null) return null;
  if (typeof p.protocolVersion !== "number" || !Number.isInteger(p.protocolVersion)) return null;
  if (!isStringArray(p.operations) || !isStringArray(p.launchOptions ?? [])) return null;
  return {
    type: "auth",
    hostId: v.hostId,
    credential: v.credential,
    protocol: {
      protocolVersion: p.protocolVersion,
      operations: p.operations,
      launchOptions: (p.launchOptions as string[] | undefined) ?? [],
    },
  };
}

/** Null when compatible; otherwise the reason, for the error frame. */
export function protocolMismatch(peer: AgentProtocolInfo): string | null {
  if (isProtocolCompatible(peer.protocolVersion)) return null;
  return `agent protocol ${peer.protocolVersion} is outside the primary's supported range (this primary speaks ${PROTOCOL_VERSION})`;
}

/** Next reconnect delay for the `attempt`th consecutive failure (0-based). */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(
    AGENT_CHANNEL_BACKOFF.maxMs,
    AGENT_CHANNEL_BACKOFF.minMs * 2 ** Math.min(attempt, 16),
  );
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** What `GET /api/hosts` reports, separate from pairing/credential state. */
export interface HostChannelStatus {
  /** An authenticated channel is open right now. */
  ready: boolean;
  /** Whether the host is bound to the outbound channel transport. */
  bound: boolean;
  /** Human-readable status description. */
  status: "connected" | "bound to the outbound channel, not connected" | "not connected";
  connectedAt: string | null;
  carriedOperations: string[];
}
