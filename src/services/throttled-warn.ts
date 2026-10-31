// A warning that says itself at most once per interval, per key.
//
// The reconciler runs every sweep tick (30s by default), and several of the
// conditions it reports are STUCK states — an unstable PR whose check list
// cannot be read, a rate-limit grace window that lasts hours, a worker host
// that is unreachable. A warning that fires on every tick turns one incident
// into thousands of lines, and the lines are what an operator reads.
//
// One policy, one place: the interval, the entry cap, and the eviction rule
// live here rather than being copied into each caller. The eviction picks the
// LEAST RECENTLY warned key, not the oldest INSERTED one — re-warning a key
// moves it to the back of the map, so insertion order would otherwise evict
// an entry that was warned seconds ago.
//
// The state is in-memory only: a process restart forgets it, which costs at
// most one extra warning per key — the same "approximate is fine" posture the
// other in-memory reconciler state keeps.

import type { FastifyInstance } from "fastify";

/** A throttled warning. Call it with the key it is throttled by (a task id). */
export interface ThrottledWarn {
  (app: FastifyInstance, key: number, fields: Record<string, unknown>, message: string): void;
  /** Test-only reset — the state is module-scope and would otherwise leak
   * between test cases. */
  reset(): void;
}

/**
 * A warning that fires at most once per `intervalMs` per key.
 *
 * @param intervalMs the quiet period between two warnings for the same key
 * @param maxEntries the most keys to remember (the map is in-memory only)
 */
export function createThrottledWarn(intervalMs: number, maxEntries = 500): ThrottledWarn {
  const warnedAt = new Map<number, number>();

  const warn: ThrottledWarn = (app, key, fields, message) => {
    const now = Date.now();
    const last = warnedAt.get(key);
    if (last !== undefined && now - last < intervalMs) return;

    if (warnedAt.size >= maxEntries) {
      let oldestKey: number | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidate, at] of warnedAt) {
        if (at < oldestAt) {
          oldestAt = at;
          oldestKey = candidate;
        }
      }
      if (oldestKey !== undefined) warnedAt.delete(oldestKey);
    }

    // Delete before setting: a re-warned key moves to the back of the map,
    // so the map's order stays "least recently warned first".
    warnedAt.delete(key);
    warnedAt.set(key, now);
    app.log.warn(fields, message);
  };

  warn.reset = (): void => {
    warnedAt.clear();
  };

  return warn;
}
