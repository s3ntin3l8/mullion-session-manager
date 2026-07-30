import type { FastifyInstance } from "fastify";
import type { NotificationEvent } from "./pty-manager.js";
import { getStoredSettings } from "./settings.js";
import { insertSessionEvents, sweepOldSessionEvents } from "./event-history.js";

// Issue #213 (roadmap 4.7) — the timer/debounce logic behind
// src/plugins/event-store.ts, pulled out as plain functions taking `app`
// (never wrapped in fp()) so each is directly unit-testable against a
// `fakeApp()`-shaped object with fake timers, the same split
// src/plugins/task-watcher.ts uses for src/services/task-watcher.ts's
// startTaskWatcher — no full buildApp()/real PTY spawn required to exercise
// the debounce/ceiling/sweep behavior itself.

// Short trailing-edge debounce, reset on every new event, mirroring
// Session's own scheduleStateFileWrite() (pty-manager.ts, issue #323).
export const EVENT_FLUSH_DEBOUNCE_MS = 5_000;
// Forces a flush at most this long after the first buffered event, even if
// events never stop arriving — same "ceiling timer armed only on the
// first-dirty transition" shape scheduleStateFileWrite uses.
export const EVENT_FLUSH_CEILING_MS = 30_000;
// Fixed retention-sweep cadence — deliberately NOT derived from
// sessions.eventRetentionDays (an age threshold, not a cadence): a
// `setInterval(retentionDays * 86_400_000)` would arm a ~30-day-by-default
// timer that all but never fires in a realistic uptime. Only the age
// cutoff each sweep applies is settings-driven, re-read fresh every tick.
export const EVENT_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Subscribes to `app.pty.onEvent()` and persists batches on a debounce +
 * hard-ceiling schedule. Returns a cleanup function that clears both timers,
 * unsubscribes, and does one final flush — call it from the plugin's
 * `onClose` hook.
 *
 * CRITICAL ORDERING POINT: subscribes at EMIT time, not read time.
 * pty-manager.ts's own per-session event ring buffer (EVENTS_MAX = 100)
 * evicts via shift() once full — anything not captured by this listener
 * before that happens is gone forever; there is no "read it later from the
 * buffer" fallback.
 *
 * Buffering (and scheduling a flush) happens unconditionally on every
 * event, regardless of the `sessions.eventPersistence` setting's current
 * value — that setting is only consulted inside the flush itself, right
 * before the actual DB write, so toggling it never leaves an unbounded
 * buffer: the debounce/ceiling timers keep flushing (and clearing) the
 * buffer either way, they just sometimes discard instead of writing.
 *
 * Best-effort by contract: this is opportunistic persistence sitting behind
 * the live in-memory ring buffer, which must keep working regardless — a
 * write failure is logged, never thrown/propagated.
 */
export function startEventWriter(app: FastifyInstance): () => void {
  let buffer: NotificationEvent[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;

  function clearFlushTimers(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (ceilingTimer !== null) {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
    }
  }

  function flush(): void {
    clearFlushTimers();
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

    // Read fresh on every flush, not cached at subscribe time — a plain,
    // synchronous better-sqlite3 read, already done on every tick elsewhere
    // in this codebase (see plugins/pty.ts's readReconcileIntervalMs/
    // readStaleErrorMs), so re-checking per batch here is negligible.
    //
    // Deliberately OUTSIDE the try/catch below: that catch's per-row retry
    // exists to contain a partial-batch INSERT failure, not a failure to
    // even determine whether persistence is on. If this read itself threw
    // (e.g. a transiently unusable settings-table read) and were inside the
    // try, the batch would still be pushed through the per-row retry loop
    // with no re-check of the setting at all — silently writing everything
    // anyway on a settings-read failure would violate this feature's whole
    // "opt-in, default off" contract. Fail closed instead: if we can't
    // confirm persistence is enabled, drop the batch and log, don't write it.
    let persistenceEnabled: boolean;
    try {
      persistenceEnabled = getStoredSettings(app.db).sessions.eventPersistence;
    } catch (err) {
      app.log.error(
        { err, count: batch.length },
        "failed to read sessions.eventPersistence; dropping batch rather than writing with an unconfirmed setting",
      );
      return;
    }
    if (!persistenceEnabled) return;

    try {
      insertSessionEvents(app.db, batch);
    } catch (err) {
      // Retry per-row before giving up on the whole batch: this buffer
      // accumulates events across EVERY locally-tracked session, and
      // insertSessionEvents issues one multi-row statement — a single
      // unpersistable row (most likely a sessionId whose session was
      // deleted, via a project cascade, between emit and flush; foreign_keys
      // is ON, see db/client.ts) would otherwise fail the whole statement
      // and drop every OTHER session's events in this batch along with it.
      // Deleting a project while other sessions are live is ordinary usage,
      // not an exotic path, so this containment is worth the extra queries
      // on the (rare) failure path only.
      let dropped = 0;
      for (const event of batch) {
        try {
          insertSessionEvents(app.db, [event]);
        } catch {
          dropped++;
        }
      }
      app.log.error(
        { err, count: batch.length, dropped },
        "failed to persist session events batch; retried per-row",
      );
    }
  }

  function scheduleFlush(): void {
    const wasAlreadyDirty = debounceTimer !== null || ceilingTimer !== null;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, EVENT_FLUSH_DEBOUNCE_MS);
    debounceTimer.unref();

    if (!wasAlreadyDirty) {
      ceilingTimer = setTimeout(flush, EVENT_FLUSH_CEILING_MS);
      ceilingTimer.unref();
    }
  }

  const unsubscribe = app.pty.onEvent((event) => {
    buffer.push(event);
    scheduleFlush();
  });

  return () => {
    // Clear every timer FIRST, then do one final flush — a timer firing
    // after app.db is closed (closeDb(), src/plugins/db.ts's own onClose)
    // would otherwise throw outside flush()'s own try/catch. flush() itself
    // already wraps its DB access in try/catch regardless, so this ordering
    // is defense-in-depth, not the only thing standing between a late timer
    // and an unhandled throw.
    clearFlushTimers();
    unsubscribe();
    flush();
  };
}

export interface EventRetentionSweep {
  /** Stops the fixed-cadence sweep timer. Does not affect an in-flight sweep. */
  stop: () => void;
  /** Runs one sweep immediately (re-entrancy-guarded against the timer's
   * own tick), against whatever `sessions.eventRetentionDays` is currently
   * persisted. */
  runNow: () => Promise<void>;
}

/**
 * Follows git-fetcher.ts's structure (re-entrancy guard, settings read fresh
 * inside the sweep) but on a FIXED cadence (`EVENT_RETENTION_SWEEP_INTERVAL_MS`)
 * rather than one derived from the retention setting itself — see this
 * file's header comment for why. `retentionDays <= 0` is "unlimited" and a
 * per-sweep no-op, same "0 disables" gate git-fetcher's own interval setting
 * uses.
 */
export function startEventRetentionSweep(app: FastifyInstance): EventRetentionSweep {
  let sweeping = false;

  async function sweep(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      const retentionDays = getStoredSettings(app.db).sessions.eventRetentionDays;
      if (retentionDays <= 0) return;
      const deleted = sweepOldSessionEvents(app.db, retentionDays);
      if (deleted > 0) {
        app.log.info({ deleted, retentionDays }, "swept expired session_events rows");
      }
    } catch (err) {
      app.log.error({ err }, "session_events retention sweep failed");
    } finally {
      sweeping = false;
    }
  }

  function runNow(): Promise<void> {
    return sweep().catch((err: unknown) => {
      app.log.error({ err }, "session_events retention sweep failed");
    });
  }

  const timer = setInterval(() => {
    runNow().catch(() => {
      /* runNow already logs; this catch only guards the interval callback itself */
    });
  }, EVENT_RETENTION_SWEEP_INTERVAL_MS);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
    runNow,
  };
}
