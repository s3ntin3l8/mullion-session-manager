import type { FastifyInstance } from "fastify";
import { LOCAL_HOST_ID, listHosts } from "./host-registry.js";
import { HostCapacityTracker } from "./host-capacity.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { resolveHeartbeatSeconds } from "./runtime-config.js";
import { getStoredSettings } from "./settings.js";

export type HostHealthStatus = "pending" | "online" | "degraded" | "offline";

export interface HostHealth {
  status: HostHealthStatus;
  lastSeenAt: number | null;
  // Distinct from lastSeenAt (last *successful* contact): this advances on
  // every sweep result, success or failure. Lets a caller (Settings' "Test"
  // button, Hermes review PR #524) tell "a sweep has run since my own
  // click completed" apart from "the host was last reachable at this time"
  // — lastSeenAt alone can't do that, since it never moves on failure.
  lastCheckedAt: number | null;
}

interface HeartbeatEntry {
  status: HostHealthStatus;
  missed: number;
  lastSeenAt: number | null;
  lastCheckedAt: number;
}

// Issue #246 / roadmap 7.2: <=2 consecutive missed pings -> degraded,
// >=3 -> offline. Success at any point resets to online/missed:0.
const OFFLINE_AFTER_MISSED = 3;

/**
 * Live-state health tracker for remote hosts — the same DB-row-records-
 * intent / in-memory-map-records-liveness split PtyManager uses for
 * sessions (see AGENTS.md's "non-obvious session model" invariant). A host's `hosts` row is
 * never touched by heartbeat results; this tracker is the only place "is it
 * actually up right now" lives. One instance per app, decorated onto it —
 * mirrors github-activity-tracker.ts's ActivityTracker, not git-fetcher.ts's
 * module-level Map, so state never leaks across the many buildApp()
 * instances a single test run creates.
 */
export class HostHeartbeatTracker {
  private state = new Map<string, HeartbeatEntry>();

  getHealth(hostId: string): HostHealth {
    if (hostId === LOCAL_HOST_ID)
      return { status: "online", lastSeenAt: null, lastCheckedAt: null };
    const entry = this.state.get(hostId);
    if (!entry) return { status: "pending", lastSeenAt: null, lastCheckedAt: null };
    return {
      status: entry.status,
      lastSeenAt: entry.lastSeenAt,
      lastCheckedAt: entry.lastCheckedAt,
    };
  }

  recordSuccess(hostId: string): void {
    this.state.set(hostId, {
      status: "online",
      missed: 0,
      lastSeenAt: Date.now(),
      lastCheckedAt: Date.now(),
    });
  }

  recordFailure(hostId: string): void {
    const prev = this.state.get(hostId);
    const missed = (prev?.missed ?? 0) + 1;
    this.state.set(hostId, {
      status: missed >= OFFLINE_AFTER_MISSED ? "offline" : "degraded",
      missed,
      lastSeenAt: prev?.lastSeenAt ?? null,
      lastCheckedAt: Date.now(),
    });
  }

  /** Issue #248 / roadmap 7.3 — immediately marks a host offline, skipping
   * ahead of OFFLINE_AFTER_MISSED's 3-miss window, so a clean agent
   * shutdown reflects in Settings within the deregister request's own
   * round-trip rather than waiting on the next sweep(s) to time out.
   * lastSeenAt is preserved (still meaningful: "last time it was actually
   * reachable"), same as recordFailure does. The next successful sweep
   * after the agent comes back overwrites this the normal way — nothing
   * here is sticky. */
  markOffline(hostId: string): void {
    const prev = this.state.get(hostId);
    this.state.set(hostId, {
      status: "offline",
      missed: OFFLINE_AFTER_MISSED,
      lastSeenAt: prev?.lastSeenAt ?? null,
      lastCheckedAt: Date.now(),
    });
  }

  /** Drops tracked entries for hosts that no longer exist — called once per
   * sweep with the current host id set (Hermes review, PR #524: without
   * this, a deleted host's entry lives in memory for the process's
   * lifetime). Harmless with UUID ids (never reused), just unbounded. */
  pruneMissing(currentIds: ReadonlySet<string>): void {
    for (const id of this.state.keys()) {
      if (!currentIds.has(id)) this.state.delete(id);
    }
  }

  /** Drops one host's tracked entry — call when its baseUrl/token changes
   * (PATCH /api/hosts/:id) so a stale "online"/"offline" verdict from the
   * *old* URL doesn't linger for up to HOST_HEARTBEAT_INTERVAL_SECONDS.
   * Same self-invalidation reasoning as remote-host-client.ts's
   * clientCache, which already does this for the HTTP client itself. */
  invalidateHost(hostId: string): void {
    this.state.delete(hostId);
  }

  /** Test-only introspection/reset. */
  clearForTests(): void {
    this.state.clear();
  }
}

/**
 * One host's turn in the sweep: the health ping, and — only if the host
 * answered — its capacity.
 *
 * The two are deliberately SEPARATE calls with SEPARATE consequences
 * (issue #1721 / roadmap 8.7):
 *
 *   - the ping decides the health verdict, and nothing else does;
 *   - the capacity poll NEVER touches that verdict. A host that answers
 *     404 on /internal/capacity is an agent build that predates the
 *     route — "this host does not report capacity", not "this host is
 *     broken". The same "absent is not broken" distinction
 *     readTaskReviewFindings draws between "absent" and "404, the route
 *     doesn't exist".
 *
 * Capacity is polled only after a successful ping: a host that is not
 * reachable cannot report capacity, and skipping saves a doomed request.
 * The cost of that shortcut is one sweep tick of staleness after a
 * transient ping failure — which the staleness model already tolerates
 * (a host that stops reporting keeps its last known numbers).
 */
async function sweepHost(
  app: FastifyInstance,
  hostId: string,
  tracker: HostHeartbeatTracker,
  capacityTracker: HostCapacityTracker,
): Promise<void> {
  let reachable = false;
  try {
    reachable = await getRemoteHostClient(app, hostId).ping();
    if (reachable) tracker.recordSuccess(hostId);
    else tracker.recordFailure(hostId);
  } catch (err) {
    // getRemoteHostClient throws synchronously if the row vanished
    // between listHosts() and here (e.g. concurrent delete) — treat
    // exactly like an unreachable ping rather than crashing the sweep.
    app.log.warn({ err, hostId }, "[host-heartbeat] ping threw unexpectedly");
    tracker.recordFailure(hostId);
  }

  if (!reachable) return;

  try {
    const report = await getRemoteHostClient(app, hostId).resolveCapacity();
    if (report === null) {
      // An agent build without the capacity route. Nothing is recorded, the
      // health verdict above stands, and the previous numbers (if any) stay
      // as they were — stale, but real.
      app.log.debug(
        { hostId },
        "[host-heartbeat] the agent does not report capacity (no /internal/capacity route)",
      );
      return;
    }
    // The report comes from a REMOTE host, so its sampledAt is untrusted
    // input: a body without a parseable timestamp (a non-Mullion service
    // behind an admin-added baseUrl, a proxy, a future build) would parse
    // to NaN, and a NaN timestamp would throw a RangeError later — inside
    // GET /api/hosts's map, where one bad host would break the list for
    // the WHOLE fleet. Stamp it here, where the untrusted value enters.
    const sampledAt = Date.parse(report.sampledAt);
    capacityTracker.record(hostId, report, Number.isFinite(sampledAt) ? sampledAt : Date.now());
  } catch (err) {
    // A capacity failure NEVER affects the health verdict — it is
    // advisory input to a placement policy, not a liveness signal. The
    // previous numbers stay (stale); the next sweep tries again.
    app.log.debug(
      { err, hostId },
      "[host-heartbeat] the capacity poll failed, keeping the last known numbers",
    );
  }
}

async function sweep(
  app: FastifyInstance,
  tracker: HostHeartbeatTracker,
  capacityTracker: HostCapacityTracker,
): Promise<void> {
  const allHosts = listHosts(app).filter((h) => h.id !== LOCAL_HOST_ID);
  const hostIds = new Set(allHosts.map((h) => h.id));
  tracker.pruneMissing(hostIds);
  capacityTracker.pruneMissing(hostIds);

  // A host row with baseUrl === null is an enrollment-created row (#245)
  // still awaiting its first registration call — pinging it would just
  // render every pending row "offline" every cycle instead of "pending".
  const remoteHosts = allHosts.filter((h) => h.baseUrl !== null);
  await Promise.all(remoteHosts.map((host) => sweepHost(app, host.id, tracker, capacityTracker)));
}

/**
 * Starts the heartbeat poller and returns a cleanup function — same shape
 * as startGitHubPRPoller (github-pr-poller.ts). `tracker` is injectable for
 * tests that want to drive/inspect state directly without waiting on a
 * real timer.
 */
export function startHostHeartbeat(
  app: FastifyInstance,
  tracker?: HostHeartbeatTracker,
  capacityTracker?: HostCapacityTracker,
): () => void {
  const hostHeartbeatTracker = tracker ?? new HostHeartbeatTracker();
  app.hostHeartbeatTracker = hostHeartbeatTracker;
  // Issue #1721 / roadmap 8.7 — the CAPACITY cache lives here too, on the
  // same timer as the health sweep (there is deliberately no second timer:
  // the capacity poll is one more call inside the sweep that already
  // exists). In memory only — never the hosts table; see
  // services/host-capacity.ts's own comment for why.
  const hostCapacityTracker = capacityTracker ?? new HostCapacityTracker();
  app.hostCapacityTracker = hostCapacityTracker;

  let timer: ReturnType<typeof setInterval> | null = null;
  // Reentrancy guard (Hermes review, PR #524): each ping already has its
  // own REQUEST_TIMEOUT_MS bound, but nothing stopped a slow/hung host from
  // still being in flight when the next tick fires if
  // HOST_HEARTBEAT_INTERVAL_SECONDS is set below that timeout (the schema
  // only enforces minimum: 0). Without this, an overlapping tick would
  // double-count a still-pending ping as a second miss, compressing the
  // <=2-degraded/>=3-offline thresholds for one slow host into a single
  // sweep window.
  //
  // Deliberately one flag for the whole sweep, not a per-host `inFlight`
  // Set like git-fetcher.ts's — one slow/hung host throttles every other
  // registered host's liveness update to its own timeout for that tick.
  // Harmless at the 30s default; a per-host guard would remove the
  // coupling at the cost of tracking a Set instead of a boolean, not
  // pursued here since each host is already pinged concurrently
  // (Promise.all in sweep()) — the guard only prevents overlap *across*
  // ticks, not within one.
  let sweepInFlight = false;

  function runSweep() {
    if (sweepInFlight) return;
    sweepInFlight = true;
    sweep(app, hostHeartbeatTracker, hostCapacityTracker)
      .catch((err) => {
        app.log.error({ err }, "[host-heartbeat] sweep failed");
      })
      .finally(() => {
        sweepInFlight = false;
      });
  }

  // (Re)arms the sweep timer. Called once at start with the resolved
  // interval (env default, overridable from Settings → Hosts) and again by
  // applySettingsPatch whenever that setting changes. 0 disables the
  // heartbeat.
  function arm(intervalSeconds: number) {
    if (timer) clearInterval(timer);
    timer = null;
    if (intervalSeconds <= 0) {
      // Forget every verdict so no host keeps showing a stale "online"
      // while nothing is checking it — the same "pending" state a server
      // started with the heartbeat off reports. The capacity cache is
      // cleared for the same reason: with the sweep off, its numbers are
      // no longer being refreshed, and a stale reading must not be passed
      // off as current.
      hostHeartbeatTracker.pruneMissing(new Set());
      hostCapacityTracker.pruneMissing(new Set());
      return;
    }
    // Immediate first sweep (Hermes review, PR #524) — without this every
    // host reports "pending" for a full interval (30s default) after every
    // primary restart, even though every host was already fully populated
    // pre-restart. Fire-and-forget from here, same as the boot-time
    // worktree sweep in task-watcher.ts's own onReady hook — this function
    // isn't awaited by hostHeartbeatPlugin either, so nothing here can
    // delay listen().
    runSweep();
    timer = setInterval(runSweep, intervalSeconds * 1000);
    timer.unref();
  }

  arm(resolveHeartbeatSeconds(getStoredSettings(app.db), app));
  app.reconfigureHostHeartbeat = arm;

  return () => {
    if (timer) clearInterval(timer);
    app.hostHeartbeatTracker = undefined;
    app.hostCapacityTracker = undefined;
    app.reconfigureHostHeartbeat = undefined;
  };
}

declare module "fastify" {
  interface FastifyInstance {
    hostHeartbeatTracker?: HostHeartbeatTracker;
    // Issue #1721 / roadmap 8.7 — the in-memory capacity cache, filled by
    // the same sweep that fills the health tracker above.
    hostCapacityTracker?: HostCapacityTracker;
    reconfigureHostHeartbeat?: (intervalSeconds: number) => void;
  }
}
