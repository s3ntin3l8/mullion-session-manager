import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { materializeSshAgentSocket } from "../services/ssh-agent-socket.js";
import type { MuxConnection } from "../services/ssh-agent-mux.js";

// Issue #820 — the agent-host half of the bridge: materializes the local
// unix socket a launched session's SSH_AUTH_SOCK will point at (PR5a's
// ssh-agent-socket.ts), wired to whatever `MuxConnection` the primary's
// most recent `/internal/ws/ssh-agent` dial-in currently is (PR5c is the
// first PR to make the primary actually dial in — until then, `current`
// stays null forever and every local connection closes immediately, same
// as the "no bridge reachable" case ssh-agent-socket.ts already tests).
//
// Agent-only (registered from src/app.ts's agent branch only, alongside
// hooksPlugin/ptyPlugin — a primary has no local SSH clients of its own to
// serve this way). Registered BEFORE internalRoutes: its own
// `/internal/ws/ssh-agent` route (routes/internal.ts) needs
// `app.sshAgentBridgeConnection` already decorated to read/write.
export const sshAgentPlugin = fp(async (app: FastifyInstance) => {
  const holder: SshAgentConnectionHolder = { current: null };
  app.decorate("sshAgentBridgeConnection", holder);

  // Same directory as hooks.sock (app.pty.hookSocketPath) — sessionsDir's
  // own short-fallback resolution (pty.ts) already guards the 108-byte
  // sun_path limit for that socket; reusing its directory means this one
  // inherits the same guarantee for free instead of re-deriving it.
  const socketPath = path.join(path.dirname(app.pty.hookSocketPath), "ssh-agent.sock");
  const handle = await materializeSshAgentSocket({
    socketPath,
    openChannel: () => (holder.current ? holder.current.openChannel() : Promise.resolve(null)),
  });

  app.addHook("onClose", async () => {
    await handle.close();
  });
});

export interface SshAgentConnectionHolder {
  current: MuxConnection | null;
}

declare module "fastify" {
  interface FastifyInstance {
    /** The `MuxConnection` wrapping the primary's most recent
     * `/internal/ws/ssh-agent` dial-in, or `null` when no primary is
     * currently connected. Mutable, not a `Map` — unlike
     * `app.connectedBridges` (which tracks many concurrent bridges by id),
     * an agent has exactly one primary, so there is only ever one
     * connection to hold at a time. Replaced, not accumulated, by
     * routes/internal.ts's own `/internal/ws/ssh-agent` handler on every
     * new dial-in (mirroring routes/agent-bridge.ts's `trackBridge`: the
     * OLD connection is closed first, so a reconnect landing before the
     * old TCP connection notices it's dead can't orphan it). */
    sshAgentBridgeConnection: SshAgentConnectionHolder;
  }
}
