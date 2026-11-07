// The agent-side bodies of `/internal/ws/attach`, `/internal/ws/events` and
// `/internal/ws/ssh-agent` — shared by the inbound routes (routes/internal.ts)
// and the streams carried over the outbound channel (#2571,
// services/agent-channel-streams.ts) so both transports validate and behave
// identically. The socket may be a real WebSocket or a ChannelSocket.
//
// They live in a service because the OUTBOUND channel's plugin
// (src/plugins/agent-channel-client.ts)
// serves the same streams, and a plugin importing a route inverts the
// layering (routes -> services -> db, plugins above both) — issue #2413's
// whole subject.

import type { FastifyInstance } from "fastify";
import { expandHome } from "./project-config.js";
import { WebSocket as NodeWebSocket } from "ws";
import { createMuxConnection } from "./ssh-agent-mux.js";
import { pipeWsFrames, toWsUrl } from "./ws-pipe.js";
import { getPinnedWsAgent } from "./pinned-connect.js";
import { normalizePreviewDestination, CONFIGURED_PREVIEW_POLICY } from "./preview-targets.js";
import { attachSocketToSession } from "./session-attach.js";
import { attachLocalEventsSocket, attachCursorsAndSeenBroadcast } from "./session-events.js";
import {
  MAX_SESSION_ENV_ENTRIES,
  MAX_SESSION_ENV_VALUE_LENGTH,
  SESSION_ID_PATTERN,
} from "./session-limits.js";

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

// Same shape as projects.ts's DEV_SERVER_PORT_ONLY — a bare 1-65535 port,
// nothing else. Used for both /internal/preview/:port/* and
// /internal/ws/preview's ?port= (issue #28 phase 6).
const PORT_PATTERN = /^\d{1,5}$/;

export function parsePort(value: string): number | null {
  if (!PORT_PATTERN.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Resolves a caller-supplied path+query (from the primary, ultimately
 * derived from a browser's preview request) against this agent's own
 * loopback dev server at `port` — and never anything else. This is the
 * whole security promise of this phase (see projects.ts's own
 * isValidDevServerUrl comment: "the preview proxy forces the connection to
 * the owning agent's own loopback"), so it's deliberately not just "parse
 * and trust": naively string-concatenating `pathAndQuery` into
 * `http://127.0.0.1:${port}${pathAndQuery}` (or its ws:// equivalent) is
 * bypassable — a network-path reference ("//evil.com/x") overrides the
 * host entirely, and a leading "@evil.com/" turns "127.0.0.1:<port>" into
 * HTTP userinfo with "evil.com" as the actual host — both confirmed via
 * `new URL()` directly, not just reasoned about. The fix: `pathAndQuery` is
 * first parsed *alone*, against a throwaway placeholder base, so any
 * authority-like syntax it contains resolves into that placeholder's own
 * host/userinfo — which is then thrown away, keeping only `.pathname` and
 * `.search`. Only those two — guaranteed to start with "/" or be empty,
 * never authority syntax — are then combined with the real,
 * literally-constructed loopback base. The `hostname`/`port` assertion
 * below is redundant with that construction by design; it's still worth
 * asserting outright rather than trusting reasoning about which forms of
 * `pathAndQuery` are safe (see internal.test.ts's adversarial cases for
 * both).
 */
export function resolveLoopbackPreviewUrl(pathAndQuery: string, port: number): URL | null {
  // Both `new URL()` calls below can throw outright for a sufficiently
  // malformed `pathAndQuery` (confirmed: a bracketed-but-invalid literal
  // like "//[::a.b.c.d]/x" throws TypeError rather than just parsing into
  // something this function would otherwise reject) — every caller already
  // treats a null return as "reject with 400", so folding a parse failure
  // into that same null case (Hermes review, PR #48) keeps this function's
  // contract honest ("tells you whether the input is usable," not "usable
  // unless it happens to throw") without pushing a try/catch onto every
  // call site.
  try {
    const parsed = new URL(pathAndQuery, "http://internal-preview-placeholder/");
    const upstreamUrl = new URL(parsed.pathname + parsed.search, `http://127.0.0.1:${port}`);
    const resolvedPort = upstreamUrl.port === "" ? 80 : Number(upstreamUrl.port);
    if (upstreamUrl.hostname !== "127.0.0.1" || resolvedPort !== port) return null;
    return upstreamUrl;
  } catch {
    return null;
  }
}

/** Why a preview WebSocket must be refused, or null: the checks
 * `/internal/ws/preview` runs before the upgrade completes. */
export function previewQueryError(query: Record<string, string | undefined>): string | null {
  const port = query.port !== undefined ? parsePort(query.port) : null;
  if (port === null) return "port must be 1-65535";
  if (query.path === undefined) return "path query param is required";
  if (!resolveLoopbackPreviewUrl(query.path, port)) return "invalid preview path";
  return null;
}

/** The WS analog of `/internal/preview/:port/*`, for a remote-hosted project's
 * HMR connection (issue #28 phase 6): the dev server on this agent's own
 * loopback. */
export function acceptPreviewStream(
  app: FastifyInstance,
  socket: StreamSocket,
  query: Record<string, string | undefined>,
): void {
  // Re-derived, not trusted from the validation run: cheap, pure, and already
  // proven to succeed by it passing at all.
  const port = parsePort(query.port as string) as number;
  const upstreamUrl = resolveLoopbackPreviewUrl(query.path as string, port) as URL;
  const upstream = new NodeWebSocket(toWsUrl(upstreamUrl), {
    headers: { host: upstreamUrl.host },
  });
  pipeWsFrames(app, socket as unknown as NodeWebSocket, upstream, { port });
}

export function configuredPreviewQueryError(query: { url?: string }): string | null {
  return normalizePreviewDestination(query.url ?? "")
    ? null
    : "Invalid configured preview destination";
}

export function acceptConfiguredPreviewStream(
  app: FastifyInstance,
  socket: StreamSocket,
  query: { url: string },
): void {
  const destination = normalizePreviewDestination(query.url)!;
  const url = toWsUrl(new URL(destination));
  const upstream = new NodeWebSocket(url, {
    headers: { host: new URL(destination).host },
    agent: getPinnedWsAgent(CONFIGURED_PREVIEW_POLICY, url),
  });
  pipeWsFrames(app, socket as unknown as NodeWebSocket, upstream, { kind: "configured-preview" });
}
