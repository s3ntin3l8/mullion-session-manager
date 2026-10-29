import type { FastifyInstance } from "fastify";
import { LOCAL_HOST_ID, listHosts } from "./host-registry.js";
import { HostRequestError, getRemoteHostClient } from "./remote-host-client.js";
import { getTerminalPalette } from "./terminal-query-reply.js";

// A remote session's PTY runs in the agent's own process, so the agent answers
// that session's startup color/DA1 queries (terminal-query-reply.ts) from ITS
// palette cache. Only the primary hears from the browser, so it forwards the
// palette to each agent. Best-effort: a failed push is logged, never thrown.

/** Pushes the cached palette to one remote host. No-op until a palette is known. */
export async function pushTerminalPaletteToHost(
  app: FastifyInstance,
  hostId: string,
): Promise<void> {
  const palette = getTerminalPalette();
  if (!palette || hostId === LOCAL_HOST_ID) return;
  try {
    await getRemoteHostClient(app, hostId).setTerminalPalette(palette);
  } catch (err) {
    if (err instanceof HostRequestError && err.statusCode === 404) {
      // An agent that predates the route: one-time, fixed by updating it.
      app.log.warn({ hostId }, "[terminal-palette] host has no palette route; update the agent");
    } else {
      // Usually a sleeping or unreachable host, and this runs on every
      // dashboard load, so keep it quiet; the next push retries.
      app.log.debug({ err, hostId }, "[terminal-palette] could not push the palette to host");
    }
  }
}

/** Pushes the cached palette to every enrolled remote host. */
export async function pushTerminalPaletteToHosts(app: FastifyInstance): Promise<void> {
  const hosts = listHosts(app).filter((h) => h.id !== LOCAL_HOST_ID && h.baseUrl !== null);
  await Promise.all(hosts.map((h) => pushTerminalPaletteToHost(app, h.id)));
}
