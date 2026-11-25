// Shared API types for execution hosts: capacity, health, pairing, bridges and self-update (#2412).
//
// The single declaration of each API shape here, used by both workspaces.
// Most were hand-copied into frontend/src/api/ before #2412; the backend
// module that produces one re-exports it, so its importers are unchanged, and
// the frontend imports it through src/shared/types.ts, the one entry point.
// Type-only: no runtime code, and no import from outside src/shared/ (an
// import back from types.ts would be a cycle).

export type HostHealthStatus = "pending" | "online" | "degraded" | "offline";

export interface HostRecentIdentityReplacement {
  id: number;
  at: string;
  peer: string | null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  // null when the latest release's tag couldn't be parsed as a version —
  // still a successful check (updateAvailable is conservatively false), not
  // an error.
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  // browser_download_url of the release's .tgz asset, or null if the
  // release has no such asset yet (e.g. CI's build-tarball job hasn't
  // finished, or an older release predates this feature).
  assetUrl: string | null;
  // browser_download_url of the release's sha256sum-format checksum file
  // (see release-please.yml's build-tarball job) — self-update.sh verifies
  // the downloaded tarball against this before extracting it (Hermes
  // review, PR #54: "no integrity verification of the downloaded tarball").
  // null under the same conditions as assetUrl.
  checksumUrl: string | null;
  // Whether this install is even capable of applying an update — i.e.
  // MULLION_HOME is configured (a versioned-release layout, not a dev
  // checkout). Threaded in by the caller rather than read from process.env
  // in update-checker.ts's checkForUpdate, so that stays a pure, easily-testable function like
  // github.ts's getRepoStatus.
  applyAvailable: boolean;
  // Epoch ms of when GitHub was actually last queried for this result — set
  // once when the result is fetched and preserved verbatim across cache hits
  // (see checkForUpdate), so the frontend can show real staleness ("Last
  // checked: 59 minutes ago") instead of every result looking equally fresh
  // (issue #123).
  checkedAt: number;
}

/**
 * The CAPACITY signal — how busy a host is, in numbers a placement policy
 * can compare across machines (issue #1721, roadmap 8.7).
 *
 * The fleet has a health signal today (online / degraded / offline) but no
 * capacity signal, so "put the work on the idle machine" is still a manual
 * decision. This module is the one place those numbers are produced, and
 * it is deliberately the ONLY place: the agent measures itself with it, and
 * the primary measures itself with it. One function, two callers — so the
 * local host's numbers and an agent's numbers are comparable by
 * construction, not by two implementations that happen to agree today.
 *
 * Deliberately NOT the same number as system-stats.ts's `logicalCores`:
 * that one counts `os.cpus().length` (what the box advertises) for the
 * System Resources page, while this one counts
 * `os.availableParallelism()` (what the box can actually run in parallel,
 * which accounts for a cgroup CPU limit and for UV thread-pool sizing).
 * Two different questions, two different numbers, both documented.
 */
export interface HostCapacity {
  /** `process.platform` of the host — "linux" | "darwin" | "win32" | … */
  platform: string;
  /** `os.availableParallelism()` — how many things can run at once here. */
  logicalCores: number;
  /**
   * The 1-minute load average — `os.loadavg()[0]`.
   *
   * NOT comparable across platforms: it is permanently 0 on win32 (the
   * platform does not report one), so a placement policy reading 0 as
   * "idle" would read every Windows host as idle. Windows is out of
   * Phase 8 (#1728) and the placement half targets Linux and macOS, but
   * the contract is stated here so the policy that reads this field
   * (#1723) inherits the caveat: treat `platform: "win32"` as "this host
   * reports no load", never as "this host is idle".
   */
  loadAverage1m: number;
  /** Total and free memory, in bytes. */
  memory: { totalBytes: number; freeBytes: number };
  /**
   * The sessions THIS host is tracking: how many it knows about, and how
   * many of them are still alive. Host-level numbers only — per-session
   * capacity accounting is explicitly not attempted (issue #1721).
   */
  sessions: { tracked: number; alive: number };
}

/** The capacity report as it travels over the wire, with its age stamp. */
export interface HostCapacityReport extends HostCapacity {
  /** When these numbers were measured, ISO-8601. */
  sampledAt: string;
}

/** Which of resolveSshAuthSock's three tiers (or genuine absence) produced
 * its result — see that function's own doc comment for the precedence.
 * Issue #820 PR7a: exists so a caller (routes/internal.ts's
 * buildAgentConfig, for Settings > Hosts) can report *why* a session gets
 * the SSH_AUTH_SOCK it does, not just the resulting path. Exported so
 * remote-host-client.ts's AgentConfig type can reuse it rather than
 * hand-copying the four string literals and risking drift. */
export type SshAuthSockSource = "configured" | "ambient" | "bridge" | "none";

// Phases self-update.sh writes to $MULLION_HOME/.update-status.json as it
// runs (see src/routes/updates.ts) — "unavailable" is server-side-only
// (MULLION_HOME unset), "idle" means MULLION_HOME is set but no update has
// run yet.
export type UpdatePhase =
  | "unavailable"
  | "idle"
  | "downloading"
  | "installing"
  | "verifying"
  | "restarting"
  | "done"
  | "failed";

export interface UpdateStatus {
  phase: UpdatePhase;
  version?: string;
  updatedAt?: number;
  error?: string;
}

export type HostPairingState = "pending" | "paired" | "expired" | "revoked";

// GET/POST /api/host-pairings (src/routes/host-pairing.ts) — the wire shapes,
// snake_case and ISO strings; the service's own HostPairingRecord carries Dates.
export interface HostPairingCreated {
  id: string;
  /** `mullion://pair?url=…&code=…` — the primary URL and one-time code only. */
  pairing_link: string;
  url: string;
  code: string;
  expires_at: string;
}

export interface HostPairingSummary {
  id: string;
  label: string | null;
  state: HostPairingState;
  expires_at: string;
  created_at: string;
  host_id: string | null;
}

// GET/POST /api/automation-tokens (src/routes/automation-tokens.ts, issue #3440)
export type AutomationTokenState = "active" | "expired" | "revoked";

export interface AutomationTokenSummary {
  id: string;
  label: string;
  scopes: ("enroll" | "repair")[];
  expires_at: string;
  allowed_cidrs: string | null;
  require_approval: boolean;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  state: AutomationTokenState;
}

export interface AutomationTokenCreated extends AutomationTokenSummary {
  /** Shown once on creation; never stored or returned again. */
  token: string;
}

export interface BridgeSummary {
  id: string;
  name: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  /** A live, unexpired session exists on this row (bridge-registry.ts's own
   * `hasLiveSession`) — "this bridge is paired and its credential hasn't
   * expired," independent of whether a socket happens to be open RIGHT
   * NOW. */
  hasLiveSession: boolean;
  /** `app.connectedBridges.has(id)` at request time — "a helper is
   * actually connected right now." Reported alongside `hasLiveSession`
   * rather than instead of it, same "DB row = intent, in-memory map = live
   * state, route merges the two" split hosts.ts's own GET /api/hosts uses
   * for heartbeat health: a bridge can be paired (`hasLiveSession: true`)
   * with its helper process not currently running (`connected: false`),
   * and Settings needs to tell those apart, not collapse them into one
   * status. */
  connected: boolean;
  /** User-set tiebreak order among multiple enrolled bridges (issue
   * #1313) — lower first. `GET /api/bridges` returns entries already
   * sorted by this field (`listBridges`'s own `orderBy`), so the frontend
   * never has to re-sort what it's handed. */
  priority: number;
}

/** What `GET /api/hosts` reports, separate from pairing/credential state. */
export interface HostChannelStatus {
  /** An authenticated channel is open right now. */
  ready: boolean;
  /** Whether the host is bound to the outbound channel transport. */
  bound: boolean;
  /** Human-readable status description. */
  status: "connected" | "bound to the outbound channel, not connected" | "not connected";
  connectedAt: string | null;
  carriedOperations: string[];
}
