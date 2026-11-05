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
} as const;

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
  /** Operations actually carried over this channel. Empty until each
   * operation's migration lands (#2451, #2571); never claim one earlier. */
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
  connectedAt: string | null;
  carriedOperations: string[];
}
