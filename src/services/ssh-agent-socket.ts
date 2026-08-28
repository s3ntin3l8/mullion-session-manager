import net from "node:net";
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
