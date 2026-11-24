// The agent-side bodies of `/internal/ws/attach`, `/internal/ws/events`,
// `/internal/ws/ssh-agent` and `/internal/ws/device/:id` — shared by the
// inbound routes (routes/internal.ts, routes/internal-devices.ts) and the
// streams carried over the outbound channel (#2571,
// services/agent-channel-streams.ts) so both transports validate and behave
// identically. The socket may be a real WebSocket or a ChannelSocket.
//
// They live in a service because the OUTBOUND channel's plugin
// (src/plugins/agent-channel-client.ts)
// serves the same streams, and a plugin importing a route inverts the
// layering (routes -> services -> db, plugins above both) — issue #2413's
// whole subject.

import type { FastifyInstance } from "fastify";
import net from "node:net";
import { expandHome } from "./project-config.js";
import { WebSocket as NodeWebSocket } from "ws";
import { createMuxConnection } from "./ssh-agent-mux.js";
import { pipeWsFrames, toWsUrl } from "./ws-pipe.js";
import { getPinnedWsAgent } from "./pinned-connect.js";
import { normalizePreviewDestination, CONFIGURED_PREVIEW_POLICY } from "./preview-targets.js";
import { attachSocketToSession } from "./session-attach.js";
import { attachLocalEventsSocket, attachCursorsAndSeenBroadcast } from "./session-events.js";
import {
  isDeviceKind,
  iosSimulatorAvailable,
  physicalDeviceEnabled,
  physicalDeviceUnavailableMessage,
} from "./device-kinds.js";
import { DEVICE_ID_PATTERN } from "./device-wire.js";
import { attachSocketToDevice, type AttachDeviceParams } from "./device-attach.js";
import type { DeviceKind, DevicePlatform } from "./device-drivers/types.js";
import type { SocketLike } from "./socket-channel.js";
import {
  MAX_SESSION_ENV_ENTRIES,
  MAX_SESSION_ENV_VALUE_LENGTH,
  SESSION_ID_PATTERN,
} from "./session-limits.js";

/** The device id pattern, compiled once (see device-wire.ts). */
const DEVICE_ID_RE = new RegExp(DEVICE_ID_PATTERN);

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
 * `pathAndQuery` are safe (see internal-ws-and-preview.test.ts's adversarial
 * cases for both).
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

export type LoopbackHost = "127.0.0.1" | "[::1]";

const LOOPBACK_PROBE_TIMEOUT_MS = 300;
const LOOPBACK_DRAIN_TIMEOUT_MS = 1_000;
const LOOPBACK_CACHE_TTL_MS = 2_000;
const loopbackHosts = new Map<number, { at: number; host: LoopbackHost }>();

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: LOOPBACK_PROBE_TIMEOUT_MS });
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    // Close politely: a FIN, then drain whatever the server answers with. Tearing
    // the socket down at once resets the connection, which a server that writes
    // on connect (and a test's raw stub) reports as an uncaught ECONNRESET.
    socket.once("connect", () => {
      settle(true);
      // The connect-phase timeout no longer applies; the drain cap below does.
      socket.removeAllListeners("timeout");
      socket.end();
      socket.resume();
      // A server that keeps the connection open is let go of soon after.
      socket.setTimeout(LOOPBACK_DRAIN_TIMEOUT_MS, () => socket.destroy());
    });
    socket.once("timeout", () => {
      settle(false);
      socket.destroy();
    });
    socket.on("error", () => {
      settle(false);
      socket.destroy();
    });
  });
}

/**
 * Which loopback address a dev server on `port` listens on (#3425). Node
 * servers (Vite among them) often bind `localhost` to `::1` alone on macOS, so
 * a proxy that only dials 127.0.0.1 answers 502 for a server that is running.
 * IPv4 first; `::1` only when IPv4 refuses and IPv6 accepts; otherwise IPv4, so
 * a server that is simply down fails exactly as it did before. Held for a
 * moment: a preview makes a request per asset. Probes only the two literal
 * loopback addresses, never a caller-supplied host.
 */
export async function pickLoopbackHost(port: number): Promise<LoopbackHost> {
  const hit = loopbackHosts.get(port);
  if (hit && Date.now() - hit.at < LOOPBACK_CACHE_TTL_MS) return hit.host;
  // Only an answer is held. A server that is down (or still starting) is not
  // remembered, so one that comes up on ::1 is found on the very next request.
  if (await canConnect("127.0.0.1", port)) {
    loopbackHosts.set(port, { at: Date.now(), host: "127.0.0.1" });
    return "127.0.0.1";
  }
  if (await canConnect("::1", port)) {
    loopbackHosts.set(port, { at: Date.now(), host: "[::1]" });
    return "[::1]";
  }
  return "127.0.0.1";
}

/** Drops the cached loopback choices (tests). */
export function clearLoopbackHostCache(): void {
  loopbackHosts.clear();
}

/** `url` (built by `resolveLoopbackPreviewUrl`) pointed at `host` instead. */
export function withLoopbackHost(url: URL, host: LoopbackHost): URL {
  if (host === "127.0.0.1") return url;
  const next = new URL(url);
  next.hostname = host;
  return next;
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
  const base = resolveLoopbackPreviewUrl(query.path as string, port) as URL;
  // Frames the near side sends before the upstream opens are dropped anyway
  // (ws-pipe.ts), so choosing the address first costs nothing.
  void pickLoopbackHost(port)
    .then((host) => {
      // The browser side may have gone while the address was being chosen; its
      // close event is already past, so nothing would ever close an upstream
      // opened now.
      if (socket.readyState !== NodeWebSocket.OPEN) return;
      const upstreamUrl = withLoopbackHost(base, host);
      const upstream = new NodeWebSocket(toWsUrl(upstreamUrl), {
        headers: { host: upstreamUrl.host },
      });
      pipeWsFrames(app, socket as unknown as NodeWebSocket, upstream, { port });
    })
    .catch((err: unknown) => {
      app.log.warn({ err, port }, "internal preview ws: could not open the upstream");
      socket.close();
    });
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

// --- the device panel's socket (#3273) -------------------------------------

/**
 * Why a device socket must be refused, or null: the checks
 * `/internal/ws/device/:id` runs before its upgrade completes. The inbound
 * route and the `device` stream over the outbound channel run THIS one, so
 * the two transports gate a device identically instead of forking the rules.
 *
 * `id` is the device the socket names: the inbound route's path param, the
 * channel stream's `id` query.
 */
export async function deviceQueryError(
  app: FastifyInstance,
  query: Record<string, string | undefined>,
  id: string,
): Promise<string | null> {
  // The same pattern the route's params schema enforces (internal-schemas.ts),
  // so a device id means the same thing on both transports.
  if (!DEVICE_ID_RE.test(id)) return "id must be a number";
  const { kind } = query;
  if (!isDeviceKind(kind)) return "kind must be emulator or physical";
  const { platform } = query;
  if (platform !== undefined && platform !== "android" && platform !== "ios") {
    return "platform must be android or ios";
  }
  if (platform === "ios") {
    if (!(await iosSimulatorAvailable(app))) {
      return "iOS Simulator is not available on this host";
    }
    if (!query.udid) return "udid is required for an ios device";
  } else if (kind === "emulator" ? !app.deviceEmulatorEnabled : !physicalDeviceEnabled(app)) {
    return kind === "emulator"
      ? app.deviceEmulatorUnavailableMessage
      : physicalDeviceUnavailableMessage(app);
  }
  const { port } = query;
  // The same 1-65535 the spawn schema bounds the port to.
  if (port !== undefined && !(/^[0-9]{1,5}$/.test(port) && +port >= 1 && +port <= 65535)) {
    return "port must be a number from 1 to 65535";
  }
  return null;
}

/**
 * The attach parameters a device socket carries: the query of
 * `/internal/ws/device/:id`, with the id the route takes from its path.
 */
export function deviceStreamParams(
  query: Record<string, string | undefined>,
  id: string,
): AttachDeviceParams {
  const platform = query.platform as DevicePlatform | undefined;
  return {
    deviceId: Number(id),
    kind: query.kind as DeviceKind,
    avdName: query.avdName ?? null,
    serial: query.serial ?? null,
    label: query.label ?? null,
    port: query.port === undefined ? null : Number(query.port),
    ...(platform !== undefined ? { platform } : {}),
    udid: query.udid ?? null,
  };
}

/**
 * The agent's half of the device panel's video/input socket, for the
 * `device` stream over the outbound channel (#3273): the SAME attach the
 * inbound `/internal/ws/device/:id` route runs, so the keyframe gating and
 * the backpressure drop stay agent-side on either transport.
 */
export function acceptDeviceStream(
  app: FastifyInstance,
  socket: SocketLike,
  query: Record<string, string | undefined>,
  id: string,
): void {
  void attachSocketToDevice(app, socket, deviceStreamParams(query, id));
}
