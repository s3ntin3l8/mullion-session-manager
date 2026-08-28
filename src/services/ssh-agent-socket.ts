import net from "node:net";
import path from "node:path";
import { chmodSync } from "node:fs";
import { reclaimSocketPath } from "./unix-socket.js";
import { pipeNetSocketToChannel, type MuxChannel } from "./ssh-agent-mux.js";

// Issue #820 — the agent-host half of the bridge's local surface: a real
// unix socket a launched session's SSH_AUTH_SOCK can point at (see
// PR5b/launch-plan.ts's env injection), materialized the same way this
// codebase's other long-lived singleton sockets are (hooks.ts,
// control-socket.ts) — reclaimSocketPath first, so a stale file from a
// crashed prior process doesn't block a clean rebind, but a genuinely
// live listener at this path is never silently stolen out from under it.
//
// Deliberately decoupled from the actual `/internal/ws/ssh-agent` mux
// connection (a later PR in this same sequence, #820): this module takes
// an `openChannel` callback rather than a connection/socket itself, so it
// can be unit-tested with a fake channel opener and doesn't need to know
// anything about how — or whether — a bridge is currently reachable. Only
// the wiring in that later PR knows that.

export interface SshAgentSocketOptions {
  socketPath: string;
  /** Called once per accepted SSH-client connection to obtain the
   * MuxChannel that carries its traffic onward (toward primary, and from
   * there toward the paired laptop bridge/helper and its real ssh-agent).
   * Resolving to `null` (or rejecting) means no bridge is currently
   * reachable — the caller must respond by closing the accepted
   * connection immediately, NOT hanging: `ssh` blocks on SSH_AUTH_SOCK
   * until the agent answers or the connection drops, so a hang here is a
   * UX-breaking stall (and a plausible CI/e2e-hang source), not a safe
   * fallback. Closing immediately lets ssh fall through to its next
   * configured auth method instead. */
  openChannel: () => Promise<MuxChannel | null>;
}

export interface SshAgentSocketHandle {
  readonly socketPath: string;
  close(): Promise<void>;
}

export async function materializeSshAgentSocket(
  opts: SshAgentSocketOptions,
): Promise<SshAgentSocketHandle> {
  await reclaimSocketPath(opts.socketPath);

  const openSockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    void handleConnection(socket, opts.openChannel);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // 0600: this socket hands out a live SSH-agent-protocol channel to
  // whatever connects to it — filesystem perms are the only gate (there's
  // no protocol-level auth on a unix socket the way the bridge WS itself
  // has a pairing/session credential), same posture as hooks.sock.
  chmodSync(opts.socketPath, 0o600);

  return {
    socketPath: opts.socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of openSockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

// The one deterministic name/location this socket is ever created at (see
// plugins/ssh-agent.ts) — shared with resolveSshAuthSock below and with
// routes/internal.ts's buildAgentConfig (its own diagnostic report of the
// effective SSH_AUTH_SOCK) so no caller re-derives or hardcodes the
// filename and risks drifting from where materializeSshAgentSocket above
// actually listens.
export function sshAgentSocketPath(sessionsDir: string): string {
  return path.join(sessionsDir, "ssh-agent.sock");
}

// Issue #820 (Hermes review, PR #865) — mirrors sshAgentPlugin's own
// registration predicate (src/app.ts's `MULLION_ROLE === "agent"` branch,
// the only place that registers it): true exactly when this process will
// materialize a bridge socket (plugins/ssh-agent.ts). plugins/pty.ts and
// routes/internal.ts's buildAgentConfig both need this same answer for the
// same reason resolveSshAuthSock exists at all — call this instead of each
// keeping its own `=== "agent"` copy, so a PR5e primary-local bridge socket
// only has to change this one function, not hunt down every call site that
// silently assumed "agent-only" and risk missing one.
export function materializesBridgeSocket(role: string): boolean {
  return role === "agent";
}

/** Which of resolveSshAuthSock's three tiers (or genuine absence) produced
 * its result — see that function's own doc comment for the precedence.
 * Issue #820 PR7a: exists so a caller (routes/internal.ts's
 * buildAgentConfig, for Settings > Hosts) can report *why* a session gets
 * the SSH_AUTH_SOCK it does, not just the resulting path. Exported so
 * remote-host-client.ts's AgentConfig type can reuse it rather than
 * hand-copying the four string literals and risking drift. */
export type SshAuthSockSource = "configured" | "ambient" | "bridge" | "none";

/**
 * Issue #820 PR5d — what a spawned session's SSH_AUTH_SOCK should resolve
 * to, given the three things that can supply it. Precedence:
 *
 * 1. `configured` (MULLION_SSH_AUTH_SOCK) always wins when set — an
 *    operator who already pointed this at a working `ssh -R` tunnel gets
 *    exactly that, unchanged, whether or not a bridge is ever enrolled.
 * 2. Otherwise, if `ambient` (this process's own inherited SSH_AUTH_SOCK —
 *    systemd --user env, PAM, a desktop keyring) is set, returning `path:
 *    ""` here leaves it alone: launch-plan.ts only overwrites a session's
 *    SSH_AUTH_SOCK when the result's `path` is truthy, so "" means
 *    "don't touch it" and the ambient value passes through
 *    buildSessionEnv() untouched, same as before this feature existed.
 * 3. Only when neither is present do we fall back to the bridge-
 *    materialized socket — and only when the caller says this process
 *    actually materializes one (`materializesBridgeSocket`; see
 *    plugins/ssh-agent.ts, agent-role-only today, primary local sessions
 *    are a later PR).
 *
 * Deliberately NOT gated on whether a bridge is *currently* connected: the
 * bridge socket is a stable path (materializeSshAgentSocket binds it
 * unconditionally at boot) exactly like the static config path always was
 * — a session spawned before any laptop ever pairs starts working the
 * moment one does, with no respawn needed. Gating on point-in-time
 * liveness here would also silently break case 1 turning into "sometimes
 * case 3" every time the laptop sleeps, which is worse than either
 * fixed choice.
 *
 * PR7a: returns `{path, source}` instead of a bare string so a caller can
 * report which tier won (Settings > Hosts needs to distinguish
 * bridge-backed from MULLION_SSH_AUTH_SOCK-backed, not just show a path).
 * `path` alone is still exactly what it was before — callers that only
 * ever consumed the path (PtyManager) just read `.path` now.
 */
export function resolveSshAuthSock(opts: {
  configured: string;
  ambient: string | undefined;
  materializesBridgeSocket: boolean;
  sessionsDir: string;
}): { path: string; source: SshAuthSockSource } {
  if (opts.configured) return { path: opts.configured, source: "configured" };
  if (opts.ambient) return { path: "", source: "ambient" };
  if (opts.materializesBridgeSocket) {
    return { path: sshAgentSocketPath(opts.sessionsDir), source: "bridge" };
  }
  return { path: "", source: "none" };
}

async function handleConnection(
  socket: net.Socket,
  openChannel: () => Promise<MuxChannel | null>,
): Promise<void> {
  let channel: MuxChannel | null;
  try {
    channel = await openChannel();
  } catch {
    channel = null;
  }
  // The SSH client may have already given up (or the accepted connection
  // otherwise died) while `openChannel` was pending — don't wire a dead
  // socket to a freshly-opened channel just to immediately tear it down
  // via pipeNetSocketToChannel's own close plumbing.
  if (!channel || socket.destroyed) {
    if (channel) channel.close();
    if (!socket.destroyed) socket.destroy();
    return;
  }
  pipeNetSocketToChannel(socket, channel);
}
