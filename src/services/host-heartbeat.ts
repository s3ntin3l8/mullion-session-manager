import type { FastifyInstance } from "fastify";
import { LOCAL_HOST_ID, listHosts } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";

export type HostHealthStatus = "pending" | "online" | "degraded" | "offline";

export interface HostHealth {
  status: HostHealthStatus;
  lastSeenAt: number | null;
}

interface HeartbeatEntry {
  status: HostHealthStatus;
  missed: number;
  lastSeenAt: number | null;
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
    if (hostId === LOCAL_HOST_ID) return { status: "online", lastSeenAt: null };
    const entry = this.state.get(hostId);
    if (!entry) return { status: "pending", lastSeenAt: null };
    return { status: entry.status, lastSeenAt: entry.lastSeenAt };
  }

  recordSuccess(hostId: string): void {
    this.state.set(hostId, { status: "online", missed: 0, lastSeenAt: Date.now() });
  }

  recordFailure(hostId: string): void {
    const prev = this.state.get(hostId);
    const missed = (prev?.missed ?? 0) + 1;
    this.state.set(hostId, {
      status: missed >= OFFLINE_AFTER_MISSED ? "offline" : "degraded",
      missed,
      lastSeenAt: prev?.lastSeenAt ?? null,
    });
  }

  /** Test-only introspection/reset. */
  clearForTests(): void {
    this.state.clear();
  }
}

async function sweep(app: FastifyInstance, tracker: HostHeartbeatTracker): Promise<void> {
  // A host row with baseUrl === null is an enrollment-created row (#245)
  // still awaiting its first registration call — pinging it would just
  // render every pending row "offline" every cycle instead of "pending".
  const remoteHosts = listHosts(app).filter((h) => h.id !== LOCAL_HOST_ID && h.baseUrl !== null);
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

  if (intervalSeconds > 0) {
    timer = setInterval(() => {
      sweep(app, hostHeartbeatTracker).catch((err) => {
        app.log.error({ err }, "[host-heartbeat] sweep failed");
      });
    }, intervalSeconds * 1000);
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
