import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket } from "ws";
import { expandHome } from "../services/project-config.js";
import { createMuxConnection } from "../services/ssh-agent-mux.js";
import { attachSocketToSession } from "./terminal.js";
import { attachLocalEventsSocket, attachCursorsAndSeenBroadcast } from "./events.js";
import {
  MAX_SESSION_ENV_ENTRIES,
  MAX_SESSION_ENV_VALUE_LENGTH,
  SESSION_ID_PATTERN,
} from "./internal-schemas.js";

// The agent-side bodies of `/internal/ws/attach`, `/internal/ws/events` and
// `/internal/ws/ssh-agent`, shared by the inbound routes (routes/internal.ts)
// and the streams carried over the outbound channel (#2571,
// services/agent-channel-streams.ts) so both transports validate and behave
// identically. The socket may be a real WebSocket or a ChannelSocket.

/** Why an attach request must be refused, or null when it is acceptable. The
 * checks `/internal/ws/attach` runs before the upgrade completes. */
export function attachQueryError(query: Record<string, string | undefined>): string | null {
  if (!query.id || !query.cwd || !query.command) {
    return "id, cwd, and command query params are required";
  }
  // Same shape as SESSION_ID_PARAMS_SCHEMA's `id` field (internal-schemas.ts):
  // it flows into the same scopeUnitName(instanceId, id) sink either way.
  if (!SESSION_ID_PATTERN.test(query.id)) return "id must match ^[A-Za-z0-9_-]+$";
  // Issue #822 — the primary echoes the session's env back on every attach,
  // since this agent is DB-less. Malformed JSON would otherwise reach
  // getOrCreate as a raw string, so it is rejected before the upgrade.
  if (query.env !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(query.env);
    } catch {
      return "env must be valid JSON";
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((v) => typeof v !== "string")
    ) {
      return "env must be a JSON object of strings";
    }
    // Same bounds as spawnSessionSchema's `env`; ajv never sees a query string.
    const entries = Object.entries(parsed as Record<string, string>);
    if (entries.length > MAX_SESSION_ENV_ENTRIES) {
      return `env must have at most ${MAX_SESSION_ENV_ENTRIES} entries`;
    }
    if (entries.some(([, v]) => v.length > MAX_SESSION_ENV_VALUE_LENGTH)) {
      return `env values must be at most ${MAX_SESSION_ENV_VALUE_LENGTH} characters`;
    }
  }
  return null;
}

type StreamSocket = Parameters<typeof attachSocketToSession>[1];

export function acceptAttachStream(
  app: FastifyInstance,
  socket: StreamSocket,
  query: Record<string, string | undefined>,
): void {
  attachSocketToSession(app, socket, {
    id: query.id as string,
    cwd: expandHome(query.cwd as string),
    command: query.command as string,
    cols: Number(query.cols) || 80,
    rows: Number(query.rows) || 24,
    ...(query.env !== undefined ? { env: JSON.parse(query.env) as Record<string, string> } : {}),
  });
}

export function acceptEventsStream(
  app: FastifyInstance,
  socket: StreamSocket,
  query: { cursors?: string } | undefined,
): void {
  // Exactly "1", not merely present (the documented contract of #1459).
  if (query?.cursors === "1") {
    const onSeenAdvanced = attachCursorsAndSeenBroadcast(app, socket);
    attachLocalEventsSocket(app, socket, { onSeenAdvanced });
  } else {
    attachLocalEventsSocket(app, socket);
  }
}

/** The agent half of the ssh-agent fan-out leg (#820): the primary's mux is
 * "odd", this accepting side "even". Fail-fast contract (see the route's
 * comment in internal.ts): `holder.current` is only set while a primary
 * connection is live. */
export function acceptSshAgentStream(app: FastifyInstance, socket: NodeWebSocket): void {
  const holder = app.sshAgentBridgeConnection;
  // Superseding, not accumulating: a reconnect landing before the old
  // connection noticed it is dead must not orphan its channels.
  if (holder.current) {
    app.log.debug({}, "ssh-agent: superseding an already-live primary<->agent connection");
    holder.current.close();
  }
  const mux = createMuxConnection(socket, { channelIdParity: "even" });
  holder.current = mux;
  app.log.debug({}, "ssh-agent: primary<->agent connection established");
  mux.onClose((reason) => {
    // Only clear `current` if it is still this connection.
    if (holder.current === mux) {
      holder.current = null;
      app.log.debug({ reason }, "ssh-agent: primary<->agent connection closed");
    }
  });
}
