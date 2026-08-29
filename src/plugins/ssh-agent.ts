import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { materializeSshAgentSocket, sshAgentSocketPath } from "../services/ssh-agent-socket.js";
import { pickBridge } from "../services/ssh-agent-fanout.js";
import type { MuxConnection, MuxChannel } from "../services/ssh-agent-mux.js";

// Issue #820 — the agent-host half of the bridge: materializes the local
// unix socket a launched session's SSH_AUTH_SOCK will point at (PR5a's
// ssh-agent-socket.ts), wired to whatever `MuxConnection` the primary's
// most recent `/internal/ws/ssh-agent` dial-in currently is (PR5c is the
// first PR to make the primary actually dial in — until then, `current`
// stays null forever and every local connection closes immediately, same
// as the "no bridge reachable" case ssh-agent-socket.ts already tests).
//
// Post-ship audit follow-up (#873, PR5e) — registers on BOTH roles now.
// Agent role keeps the exact wiring above (`sshAgentBridgeConnection`
// holder, populated by routes/internal.ts's `/internal/ws/ssh-agent`
// handler). Primary role is new: its own local sessions had no bridge-
// backed socket at all — see resolveSshAuthSock/ssh-agent-socket.ts's own
// "primary local sessions are a later PR" comment, now obsolete. The
// primary serves its own socket in-process, calling `pickBridge(app)` +
// `bridge.mux.openChannel()` directly (ssh-agent-fanout.ts) rather than
// dialing itself over `/internal/ws/ssh-agent` — there is no hop to make.
//
// Registered BEFORE internalRoutes on the agent branch: its own
// `/internal/ws/ssh-agent` route (routes/internal.ts) needs
// `app.sshAgentBridgeConnection` already decorated to read/write. On the
// primary, registered after ptyPlugin (needs app.pty.hookSocketPath) — its
// primary-side openChannel closure reads `app.connectedBridges` lazily, at
// call time (well after full app boot), not at registration time, so it
// doesn't need agentBridgePlugin to have registered first (src/app.ts's
// own ordering comment for agentBridgePlugin covers routes that read it
// eagerly; this isn't one).
export const sshAgentPlugin = fp(async (app: FastifyInstance) => {
  const isAgent = app.config.MULLION_ROLE === "agent";

  let openChannel: () => Promise<MuxChannel | null>;
  if (isAgent) {
    const holder: SshAgentConnectionHolder = { current: null };
    app.decorate("sshAgentBridgeConnection", holder);
    openChannel = () => (holder.current ? holder.current.openChannel() : Promise.resolve(null));
  } else {
    // Primary-local sessions, unfiltered by design (not an oversight): the
    // sign-only filter's home is ssh-agent-fanout.ts's
    // pipeFilteredChannelToChannel, applied to traffic arriving from a
    // DIFFERENT trust domain (an agent host) as it crosses onto the
    // primary. A primary-local session already runs as the primary — same
    // host, same user, same process tree — so a filter the primary
    // enforced against its own traffic would defend against nothing an
    // attacker with primary code execution couldn't bypass by editing the
    // filter itself. It's also no new capability: `MULLION_SSH_AUTH_SOCK`
    // pointing at a manual `ssh -R` tunnel (still fully supported, see
    // docs/ssh-agent.md) already forwards every message type unfiltered,
    // including ADD_IDENTITY/REMOVE_IDENTITY/LOCK — this path is not worse
    // than what a primary-local session can already reach today. The
    // laptop-side filter remains authoritative regardless. A filtered
    // net.Socket<->MuxChannel adapter (mirroring pipeFilteredChannelToChannel
    // but for a raw accepted socket rather than two MuxChannels) is tracked
    // as a follow-up on #873 if defense-in-depth here is ever wanted, but
    // is deliberately not bundled into this PR.
    openChannel = () => {
      const bridge = pickBridge(app);
      return bridge ? bridge.mux.openChannel() : Promise.resolve(null);
    };
  }

  // Same directory as hooks.sock (app.pty.hookSocketPath) — sessionsDir's
  // own short-fallback resolution (pty.ts) already guards the 108-byte
  // sun_path limit for that socket; reusing its directory means this one
  // inherits the same guarantee for free instead of re-deriving it.
  // sshAgentSocketPath is the same helper resolveSshAuthSock/buildAgentConfig
  // use (PR5d) so the filename never drifts from where this actually binds.
  const socketPath = sshAgentSocketPath(path.dirname(app.pty.hookSocketPath));

  // Post-ship audit follow-up (#873, PR-B) — a bind failure here used to
  // throw out of plugin registration and crash the whole process at boot,
  // with no bridge-specific log line identifying the cause. The bridge
  // socket is an optional convenience layer (unlike hooks.sock/mullion.sock,
  // which are load-bearing and correctly crash-on-collision) — degrade
  // instead: log loudly, boot without a bridge-backed SSH_AUTH_SOCK on this
  // host. `resolveSshAuthSock`'s own consumer (plugins/pty.ts) runs a
  // preflight probe at the SAME path before this plugin registers, so the
  // common case (a live foreign listener already there) is already
  // reflected in what got frozen into PtyManager; this catch handles the
  // residual cases the preflight can't fully close (a race between the
  // preflight and this bind, or a non-listener failure like EACCES).
  let handle: Awaited<ReturnType<typeof materializeSshAgentSocket>> | null = null;
  try {
    handle = await materializeSshAgentSocket({ socketPath, openChannel });
  } catch (err) {
    app.log.error(
      { err, socketPath },
      "failed to materialize the local ssh-agent bridge socket — this process will boot " +
        "without a bridge-backed SSH_AUTH_SOCK; sessions here fall through to any lower-" +
        "precedence source (see resolveSshAuthSock)",
    );
  }

  app.addHook("onClose", async () => {
    if (handle) await handle.close();
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
