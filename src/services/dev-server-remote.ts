import type { FastifyInstance } from "fastify";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { detectDevServerPortForSessionIds } from "./dev-server-detect.js";
import { getRemoteHostClient } from "./remote-host-client.js";

// Issue #3427 — the dev-server port a project's dock sessions announced, across
// every host they run on. A local session is read from this process's own
// PtyManager; a session on an agent host is read by that agent, which is the
// only process that holds its output.

const REMOTE_PORT_CACHE_TTL_MS = 10_000;
const REMOTE_PORT_CACHE_MAX = 200;
const MAX_SESSION_IDS = 100;
const remotePortCache = new Map<string, { expiresAt: number; port: string | null }>();

/** Exported for tests only. */
export function clearRemoteDevServerPortCacheForTests(): void {
  remotePortCache.clear();
}

async function remotePort(
  app: FastifyInstance,
  hostId: string,
  ids: string[],
): Promise<string | null> {
  // A host the heartbeat has marked offline is not asked on every poll.
  if (app.hostHeartbeatTracker?.getHealth(hostId)?.status === "offline") return null;
  // The agent route takes at most this many ids; the newest sessions win.
  ids = ids.slice(-MAX_SESSION_IDS);
  const key = `${hostId}:${ids.join(",")}`;
  const hit = remotePortCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.port;
  let port: string | null = null;
  try {
    port = (await getRemoteHostClient(app, hostId).resolveDevServerPort(ids)).port;
  } catch (err) {
    // An agent that predates the route, or an unreachable host: no detection.
    app.log.warn({ hostId, err }, "host unreachable, dev-server port detection unavailable");
  }
  if (remotePortCache.size >= REMOTE_PORT_CACHE_MAX) remotePortCache.clear();
  remotePortCache.set(key, { expiresAt: Date.now() + REMOTE_PORT_CACHE_TTL_MS, port });
  return port;
}

/** `sessionIdsByHost`: a project's active dock session ids grouped by the host each runs on. */
export async function detectDevServerPortAcrossHosts(
  app: FastifyInstance,
  sessionIdsByHost: Map<string, string[]> | undefined,
): Promise<string | null> {
  if (!sessionIdsByHost) return null;
  const local = sessionIdsByHost.get(LOCAL_HOST_ID);
  if (local) {
    const port = detectDevServerPortForSessionIds(app, local);
    if (port) return port;
  }
  for (const [hostId, ids] of sessionIdsByHost) {
    if (hostId === LOCAL_HOST_ID) continue;
    const port = await remotePort(app, hostId, ids);
    if (port) return port;
  }
  return null;
}
