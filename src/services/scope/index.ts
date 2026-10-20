import { DetachedScopeBackend } from "./detached.js";
import { SystemdScopeBackend } from "./systemd.js";
import type { ScopeBackend } from "./types.js";

export type { ScopeBackend, ScopeConstraints, ScopeLaunchSpec, ScopeLiveness } from "./types.js";
export { DetachedScopeBackend } from "./detached.js";
export { SystemdScopeBackend } from "./systemd.js";

export interface ScopeBackendOptions {
  /** This instance's absolute, resolved sessions dir. */
  sessionsDir: string;
  /** This instance's id — `deriveInstanceId(sessionsDir)`. */
  instanceId: string;
  /** Scope-name prefix; defaults to "crs-session". */
  prefix?: string;
}

/**
 * The backend that owns scopes on THIS host.
 *
 * **Where the choice is made, and why it is not negotiated.** The backend is
 * selected on the host that OWNS the scope, from that host's own platform.
 * A primary and its remote agents are separate processes, so each picks its
 * own — the two never have to agree on anything, and no wire format has to
 * carry the question. This is also why a remote host can run a different
 * backend than the primary without the primary knowing or caring: the primary
 * only ever speaks HTTP/WS to it (see docs/multi-host.md), and the PTY bytes
 * are opaque to it either way.
 *
 * **Why this can throw.** A platform with no backend has no way to run a
 * session at all — there is no supervisor to keep a detached program alive
 * and nothing to answer "is it still running?". Saying so plainly, at
 * construction time, beats the `spawn systemd-run ENOENT` the pre-seam code
 * produced on such a host: that error blamed a binary the user never
 * installed and said nothing about the real problem.
 *
 * Note that the check is on the PLATFORM, not on systemd's presence. A Linux
 * host without a systemd user bus still gets the systemd backend, exactly as
 * before this seam existed — it fails per-session, at spawn time, with
 * systemd's own error. That is deliberate: "is systemd usable here" is a
 * runtime property of the host, not a platform property, and treating the
 * two the same would silently change behavior on every container and CI
 * runner this repo's own tests run in.
 */
export function getScopeBackend(opts: ScopeBackendOptions): ScopeBackend {
  if (process.platform === "darwin") {
    return new DetachedScopeBackend(opts);
  }
  if (process.platform !== "linux") {
    throw new Error(
      `no scope backend for platform "${process.platform}": Mullion runs sessions on ` +
        `Linux and macOS (issue #1715 added the platform seam; issue #1716 added the ` +
        `macOS backend).`,
    );
  }
  return new SystemdScopeBackend(opts);
}
