import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";

// A Unix domain socket file outlives the process that created it — a hard
// kill (kill -9, an OOM, a crash) leaves the filesystem entry behind even
// though nothing is listening on it anymore, and net.Server.listen()
// refuses to bind an already-existing path (EADDRINUSE) regardless of
// whether it's actually live. Three call sites in this codebase need to
// tell "stale file, safe to remove and rebind" apart from "a live process
// is listening there right now, removing this would hijack it out from
// under it" before binding their own socket: pty-manager.ts's own dtach
// master reattach, plugins/hooks.ts, and plugins/control-socket.ts. Shared
// here rather than duplicated per the "small guards get duplicated" repo
// convention (Sidebar.tsx et al.) — this is a real probe with a timeout and
// genuine edge cases, not a one-line guard, so a fix belongs in one place.
//
// The concrete incident this guards against: this app's control socket path
// (MULLION_SOCKET_PATH) is injected into every session it spawns, so a dev
// backend started from inside an already-running Mullion-hosted session
// inherits that same path. Before this fix, plugins/control-socket.ts and
// plugins/hooks.ts unconditionally unlinked whatever was at that path before
// listening — silently deleting the *production* instance's live control
// socket out from under it the moment a stray `npm run dev` started in a
// worktree with no .env to override the inherited env var.

// Exported for test/services/unix-socket.test.ts's own timeout case, same
// reasoning as control-socket.ts's own exported HANDSHAKE_TIMEOUT_MS.
export const PROBE_TIMEOUT_MS = 2_000;

export type SocketProbeResult = "live" | "dead" | "unknown";

/**
 * Connects to `socketPath` to determine whether a live process is actually
 * listening, without sending or expecting any protocol-specific bytes (the
 * connection is destroyed immediately either way — this never risks being
 * mistaken for a real client by whatever's on the other end).
 *   - "live": something accepted the connection.
 *   - "dead": no file exists, or one exists but nothing answers
 *     (ECONNREFUSED) — safe to remove and rebind.
 *   - "unknown": the probe didn't resolve within PROBE_TIMEOUT_MS, or failed
 *     with anything other than ECONNREFUSED (EACCES, ENOTSOCK, a plain file
 *     at that path, ...). There's no way to positively confirm this case is
 *     safe, so callers should treat it the same as "live" unless they have
 *     their own reason not to (see isSocketLive vs. reclaimSocketPath below).
 */
export function probeSocket(socketPath: string): Promise<SocketProbeResult> {
  if (!existsSync(socketPath)) return Promise.resolve("dead");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SocketProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(result);
    };
    // `probe` created before `timer` is armed — a synchronous throw from
    // net.createConnection (rare, but not impossible) then aborts this
    // executor before any timer is scheduled, rather than leaving a
    // scheduled timer whose callback would later reference `probe` while
    // it's still in the temporal dead zone.
    const probe = net.createConnection(socketPath);
    const timer = setTimeout(() => finish("unknown"), PROBE_TIMEOUT_MS);
    probe.once("connect", () => finish("live"));
    probe.once("error", (err) => {
      finish((err as NodeJS.ErrnoException).code === "ECONNREFUSED" ? "dead" : "unknown");
    });
  });
}

/**
 * Boolean convenience wrapper for callers that only need "should I attach to
 * the existing thing instead of rebuilding it" (pty-manager.ts's own dtach
 * reattach) — an inconclusive probe is conservatively treated as "not live"
 * here, same as this function's behavior before it was extracted out of
 * Session.socketIsLive().
 */
export function isSocketLive(socketPath: string): Promise<boolean> {
  return probeSocket(socketPath).then((result) => result === "live");
}

export class SocketAlreadyListeningError extends Error {
  constructor(socketPath: string, reason: Exclude<SocketProbeResult, "dead">) {
    const detail =
      reason === "live"
        ? "another process is already listening there"
        : "could not confirm it's safe to remove (the probe timed out or failed " +
          "unexpectedly) — refusing to guess";
    super(
      `Refusing to bind the socket at ${socketPath}: ${detail}. This usually means a second ` +
        `Mullion instance inherited this socket path from an already-running one (e.g. ` +
        `MULLION_SOCKET_PATH leaking into a dev backend started from inside an existing ` +
        `Mullion-hosted session). Stop the other process first, point this one at a ` +
        `different socket path, or remove the file yourself if you're certain it's stale.`,
    );
    this.name = "SocketAlreadyListeningError";
  }
}

/**
 * Prepares `socketPath` for a fresh `net.Server.listen()` call: removes a
 * genuinely stale file (the crash/kill -9 case) but throws
 * SocketAlreadyListeningError rather than silently unlinking and stealing
 * the path out from under an already-live listener — see this module's own
 * doc comment for the incident this prevents. Used by plugins/hooks.ts and
 * plugins/control-socket.ts, both of which bind a long-lived, singleton
 * socket that other processes actively depend on staying put; pty-manager.ts
 * deliberately does NOT use this (a live dtach master should be attached to,
 * not treated as an error — see isSocketLive above).
 *
 * A probe-then-unlink-then-listen sequence can't fully close every race
 * (something else could bind between the unlink here and the caller's own
 * listen()) — that residual window is milliseconds at this process's own
 * startup, not the hours-long "already-running production instance" case
 * this function actually defends against, and the caller's own
 * server.listen() still fails loudly (EADDRINUSE) if it's lost that race.
 */
export async function reclaimSocketPath(socketPath: string): Promise<void> {
  const result = await probeSocket(socketPath);
  if (result !== "dead") {
    throw new SocketAlreadyListeningError(socketPath, result);
  }
  try {
    unlinkSync(socketPath);
  } catch (err) {
    // ENOENT is the benign case — gone already (a race with the probe
    // above, or never there in the first place). Anything else (EACCES on
    // a root-owned directory, ...) would otherwise surface only as a
    // confusing EADDRINUSE from the caller's own listen() moments later —
    // rethrow it here instead, now that this helper has an explicit error
    // taxonomy to report it through.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
