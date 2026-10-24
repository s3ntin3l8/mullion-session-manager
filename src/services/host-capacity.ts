import os from "node:os";
import type { FastifyInstance } from "fastify";

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

/**
 * The `os` primitives this module reads, injectable so a test can pin the
 * numbers without mocking `os` globally — the same shape
 * system-stats.ts's own `StatsDependencies` uses.
 */
export interface CapacityDependencies {
  platform: () => string;
  availableParallelism: () => number;
  loadavg: () => number[];
  totalmem: () => number;
  freemem: () => number;
}

const defaultDependencies: CapacityDependencies = {
  platform: () => process.platform,
  availableParallelism: () => os.availableParallelism(),
  loadavg: () => os.loadavg(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
};

/**
 * Measures THIS process's host.
 *
 * The session counts come from `app.pty.list()` — the same call on both
 * roles: an agent tracks its sessions in memory (it has no DB), and so does
 * a primary (session-backend.ts's local backend hands every local session
 * to `app.pty.getOrCreate`). `SessionInfo.alive` is the liveness flag the
 * same manager already maintains, so "alive" here means exactly what it
 * means everywhere else in the app.
 */
export function measureHostCapacity(
  app: FastifyInstance,
  dependencies: CapacityDependencies = defaultDependencies,
): HostCapacity {
  const sessions = app.pty?.list() ?? [];
  return {
    platform: dependencies.platform(),
    logicalCores: dependencies.availableParallelism(),
    loadAverage1m: dependencies.loadavg()[0] ?? 0,
    memory: { totalBytes: dependencies.totalmem(), freeBytes: dependencies.freemem() },
    sessions: {
      tracked: sessions.length,
      alive: sessions.filter((session) => session.alive).length,
    },
  };
}

/** One host's cached capacity, with the age of the numbers. */
export interface HostCapacityEntry {
  capacity: HostCapacity;
  /** When the numbers were measured (epoch ms). */
  sampledAt: number;
}

/**
 * The primary's in-memory capacity cache — one entry per remote host.
 *
 * IN MEMORY ONLY, never the `hosts` table: capacity is a live reading, not
 * an intent. Persisting it would make a stale number look durable ("the row
 * says 3 GB free") long after the machine filled up, and a host that stops
 * reporting must keep its LAST known numbers with their age, not lose them
 * to a restart.
 *
 * The same shape as HostHeartbeatTracker (host-heartbeat.ts): one instance
 * per app, decorated onto it, so state never leaks across the many
 * buildApp() instances a single test run creates — never a module-level
 * Map.
 */
export class HostCapacityTracker {
  private entries = new Map<string, HostCapacityEntry>();

  /** The cached entry for a host, or undefined when it never reported. */
  get(hostId: string): HostCapacityEntry | undefined {
    return this.entries.get(hostId);
  }

  /** Records a fresh reading, replacing whatever was cached before. */
  record(hostId: string, capacity: HostCapacity, sampledAt: number = Date.now()): void {
    this.entries.set(hostId, { capacity, sampledAt });
  }

  /** Drops tracked entries for hosts that no longer exist — called once per
   * sweep with the current host id set, mirroring the health tracker's own
   * pruneMissing: without it a deleted host's numbers live for the
   * process's lifetime. */
  pruneMissing(currentIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!currentIds.has(id)) this.entries.delete(id);
    }
  }

  /** Drops one host's cached entry — call when its baseUrl/token changes
   * (PATCH /api/hosts/:id), so numbers measured against the OLD address do
   * not linger for up to a sweep interval. Same self-invalidation reasoning
   * the health tracker uses for the same event. */
  invalidateHost(hostId: string): void {
    this.entries.delete(hostId);
  }

  /** Test-only introspection/reset. */
  clearForTests(): void {
    this.entries.clear();
  }
}
