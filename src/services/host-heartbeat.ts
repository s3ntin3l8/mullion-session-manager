import type { FastifyInstance } from "fastify";
import { LOCAL_HOST_ID, listHosts } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";

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
 * sessions (see CLAUDE.md's "non-obvious model"). A host's `hosts` row is
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

async function sweep(app: FastifyInstance, tracker: HostHeartbeatTracker): Promise<void> {
  const allHosts = listHosts(app).filter((h) => h.id !== LOCAL_HOST_ID);
  tracker.pruneMissing(new Set(allHosts.map((h) => h.id)));

  // A host row with baseUrl === null is an enrollment-created row (#245)
  // still awaiting its first registration call — pinging it would just
  // render every pending row "offline" every cycle instead of "pending".
  const remoteHosts = allHosts.filter((h) => h.baseUrl !== null);
  await Promise.all(
    remoteHosts.map(async (host) => {
      try {
        const online = await getRemoteHostClient(app, host.id).ping();
        if (online) tracker.recordSuccess(host.id);
        else tracker.recordFailure(host.id);
      } catch (err) {
        // getRemoteHostClient throws synchronously if the row vanished
        // between listHosts() and here (e.g. concurrent delete) — treat
        // exactly like an unreachable ping rather than crashing the sweep.
        app.log.warn({ err, hostId: host.id }, "[host-heartbeat] ping threw unexpectedly");
        tracker.recordFailure(host.id);
      }
    }),
  );
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
): () => void {
  const hostHeartbeatTracker = tracker ?? new HostHeartbeatTracker();
  app.hostHeartbeatTracker = hostHeartbeatTracker;

  const intervalSeconds = app.config.HOST_HEARTBEAT_INTERVAL_SECONDS;
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
    sweep(app, hostHeartbeatTracker)
      .catch((err) => {
        app.log.error({ err }, "[host-heartbeat] sweep failed");
      })
      .finally(() => {
        sweepInFlight = false;
      });
  }

  if (intervalSeconds > 0) {
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

  return () => {
    if (timer) clearInterval(timer);
    app.hostHeartbeatTracker = undefined;
  };
}

declare module "fastify" {
  interface FastifyInstance {
    hostHeartbeatTracker?: HostHeartbeatTracker;
  }
}
