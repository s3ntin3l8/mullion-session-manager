import type { FastifyInstance } from "fastify";
import { inArray, eq } from "drizzle-orm";
import { sessions, projects } from "../db/schema.js";
import type { NotificationEvent } from "./pty-manager.js";
import { getStoredSettings } from "./settings.js";
import {
  insertSessionEvents,
  sweepOldSessionEvents,
  sweepSessionEventCap,
} from "./event-history.js";

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

export interface BufferedEvent {
  event: NotificationEvent;
  /** null for a locally-emitted event (app.pty.onEvent — always trusted,
   * since it can only ever fire for a session this process itself spawned).
   * Set to the reporting host's id for an event handed in by
   * remote-event-subscriber.ts, which MUST be verified against
   * `sessions -> projects.hostId` before it's allowed to persist — see
   * filterHostOwnership below. */
  sourceHostId: string | null;
}

export interface EventWriter {
  /** Pushes one event into the shared buffer and (re)arms the debounce/
   * ceiling timers. `sourceHostId` distinguishes a locally-emitted event
   * (null) from one relayed by remote-event-subscriber.ts (that host's id)
   * — see BufferedEvent's own doc comment. */
  pushEvent: (event: NotificationEvent, sourceHostId: string | null) => void;
  /** Clears both timers, unsubscribes from app.pty, and does one final
   * flush. Call from the plugin's `onClose` hook. */
  stop: () => void;
}

// Chunk size for the ownership-lookup `inArray` below (Hermes review, PR
// #564) — SQLite's bind-parameter limit (~32,766, same one
// sweepSessionEventCap already works around in event-history.ts) binds one
// parameter per distinct sessionId. The batch this function runs on is only
// bounded by the 5s/30s flush debounce, not by count, so a
// compromised/flooding agent emitting more than the limit's worth of
// distinct bogus sessionIds in one flush window would otherwise blow the
// limit — and since that throw is caught one level up in flush() (fail
// closed, drop the WHOLE batch), a flood would take down every OTHER
// session's legitimate events in the same batch along with it. Chunking
// means a flood only ever drops its own bogus ids via the normal
// ownership-mismatch path below, never anyone else's.
const OWNERSHIP_LOOKUP_CHUNK_SIZE = 500;

/** Resolves each remote-sourced event's session to its owning host (via
 * `sessions -> projects.hostId`, same join session-reconciler.ts's
 * reconcileExitedSessions already uses — `sessions` itself has no `hostId`
 * column) and drops any whose reporting host doesn't match. A buggy or
 * compromised agent could otherwise emit an arbitrary numeric `sessionId`
 * over its events stream and have it persisted against a session it
 * doesn't actually own.
 *
 * Resolves every distinct remote-sourced sessionId in the batch via
 * `inArray` lookups chunked at OWNERSHIP_LOOKUP_CHUNK_SIZE (not one query
 * per event) — flush() already batches on the same 5s/30s debounce this
 * function runs inside, so this is still O(1) queries for the common case.
 * Locally-emitted events (`sourceHostId: null`) skip the query entirely —
 * including the common case of an all-local batch, which never touches
 * `app.db` here at all. */
export function filterHostOwnership(
  app: FastifyInstance,
  batch: BufferedEvent[],
): NotificationEvent[] {
  const remoteSessionIds = [
    ...new Set(batch.filter((b) => b.sourceHostId !== null).map((b) => b.event.sessionId)),
  ];
  if (remoteSessionIds.length === 0) return batch.map((b) => b.event);

  const ownerBySessionId = new Map<number, string>();
  for (let i = 0; i < remoteSessionIds.length; i += OWNERSHIP_LOOKUP_CHUNK_SIZE) {
    const chunk = remoteSessionIds.slice(i, i + OWNERSHIP_LOOKUP_CHUNK_SIZE);
    const ownerRows = app.db
      .select({ sessionId: sessions.id, hostId: projects.hostId })
      .from(sessions)
      .innerJoin(projects, eq(sessions.projectId, projects.id))
      .where(inArray(sessions.id, chunk))
      .all();
    for (const row of ownerRows) ownerBySessionId.set(row.sessionId, row.hostId);
  }

  const verified: NotificationEvent[] = [];
  let droppedForOwnership = 0;
  for (const { event, sourceHostId } of batch) {
    if (sourceHostId === null || ownerBySessionId.get(event.sessionId) === sourceHostId) {
      verified.push(event);
    } else {
      droppedForOwnership++;
    }
  }
  if (droppedForOwnership > 0) {
    app.log.warn(
      { droppedForOwnership },
      "dropped remote session_events whose sessionId did not resolve to the reporting host",
    );
  }
  return verified;
}

/**
 * Persists batches on a debounce + hard-ceiling schedule, fed both by
 * `app.pty.onEvent()` (this process's own sessions, subscribed here) and by
 * remote-event-subscriber.ts's per-host streams (fed in externally via the
 * returned `pushEvent`, from plugins/event-store.ts's wiring). Returns
 * `{ pushEvent, stop }` — `stop` clears both timers, unsubscribes from
 * app.pty, and does one final flush; call it from the plugin's `onClose`
 * hook.
 *
 * CRITICAL ORDERING POINT: subscribes at EMIT time, not read time.
 * pty-manager.ts's own per-session event ring buffer (EVENTS_MAX = 100)
 * evicts via shift() once full — anything not captured by this listener
 * before that happens is gone forever; there is no "read it later from the
 * buffer" fallback. The same applies to a remote host's own ring buffer —
 * remote-event-subscriber.ts's persistent connection exists specifically so
 * pushEvent sees events as they're emitted, not just whatever a
 * REPLAY_MAX_EVENTS reconnect dump still has.
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
export function startEventWriter(app: FastifyInstance): EventWriter {
  let buffer: BufferedEvent[] = [];
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

    // filterHostOwnership issues its own DB query (Hermes review, PR #564)
    // that isn't covered by the insert try/catch below, and a timer-invoked
    // flush() has no other caller to catch an escaping throw — this whole
    // file's "never thrown/propagated" contract would break. Fail closed on
    // a throw here too, but narrower than the settings read above: a
    // locally-emitted event (sourceHostId: null) never needed verification
    // in the first place, so a failure to verify the REMOTE subset must not
    // also sink trusted local events riding in the same batch (Hermes
    // review, PR #564 round 3) — only the unverifiable remote events are
    // dropped.
    let verified: NotificationEvent[];
    try {
      verified = filterHostOwnership(app, batch);
    } catch (err) {
      verified = batch.filter((b) => b.sourceHostId === null).map((b) => b.event);
      app.log.error(
        { err, count: batch.length, keptLocal: verified.length },
        "failed to verify remote-event host ownership; dropping the unverifiable remote events, keeping trusted local ones",
      );
    }
    if (verified.length === 0) return;

    try {
      insertSessionEvents(app.db, verified);
    } catch (err) {
      // Retry per-row before giving up on the whole batch: this buffer
      // accumulates events across EVERY locally-tracked session (and, as of
      // remote-event-subscriber.ts, every remote host's too), and
      // insertSessionEvents issues one multi-row statement — a single
      // unpersistable row (most likely a sessionId whose session was
      // deleted, via a project cascade, between emit and flush; foreign_keys
      // is ON, see db/client.ts) would otherwise fail the whole statement
      // and drop every OTHER session's events in this batch along with it.
      // Deleting a project while other sessions are live is ordinary usage,
      // not an exotic path, so this containment is worth the extra queries
      // on the (rare) failure path only.
      let dropped = 0;
      for (const event of verified) {
        try {
          insertSessionEvents(app.db, [event]);
        } catch {
          dropped++;
        }
      }
      app.log.error(
        { err, count: verified.length, dropped },
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

  function pushEvent(event: NotificationEvent, sourceHostId: string | null): void {
    buffer.push({ event, sourceHostId });
    scheduleFlush();
  }

  const unsubscribe = app.pty.onEvent((event) => pushEvent(event, null));

  return {
    pushEvent,
    stop: () => {
      // Clear every timer FIRST, then do one final flush — a timer firing
      // after app.db is closed (closeDb(), src/plugins/db.ts's own onClose)
      // would otherwise throw outside flush()'s own try/catch. flush() itself
      // already wraps its DB access in try/catch regardless, so this ordering
      // is defense-in-depth, not the only thing standing between a late timer
      // and an unhandled throw.
      clearFlushTimers();
      unsubscribe();
      flush();
    },
  };
}

export interface EventRetentionSweep {
  /** Stops the fixed-cadence sweep timer. Does not affect an in-flight sweep. */
  stop: () => void;
  /** Runs one sweep immediately (re-entrancy-guarded against the timer's
   * own tick), against whatever `sessions.eventRetentionDays` /
   * `sessions.eventRetentionPerSession` are currently persisted. */
  runNow: () => Promise<void>;
}

/**
 * Follows git-fetcher.ts's structure (re-entrancy guard, settings read fresh
 * inside the sweep) but on a FIXED cadence (`EVENT_RETENTION_SWEEP_INTERVAL_MS`)
 * rather than one derived from the retention setting itself — see this
 * file's header comment for why. Runs BOTH the age-based sweep
 * (`eventRetentionDays`) and the per-session count-cap sweep
 * (`eventRetentionPerSession`) on the same tick — two independent settings,
 * each with its own "0 disables" no-op gate, same convention
 * git-fetcher.ts's own interval setting uses.
 *
 * `opts.onTick`, when given, fires once per completed sweep (success or
 * failure, but never on a re-entrant no-op) — remote-event-subscriber.ts's
 * host-set reconciliation piggybacks on this existing cadence as its
 * fallback tick (issue #213 hazard 5), rather than a second independent
 * timer that could drift out of sync with this one.
 */
export function startEventRetentionSweep(
  app: FastifyInstance,
  opts?: { onTick?: () => void },
): EventRetentionSweep {
  let sweeping = false;

  async function sweep(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      // Issue #213's own body asked for both an age bound AND a per-session
      // count bound — independent settings, so each gets its own `<= 0`
      // check rather than one short-circuiting the other (a deployment
      // running with age-based retention off but a count cap on, or vice
      // versa, is a legitimate combination).
      const settings = getStoredSettings(app.db).sessions;
      if (settings.eventRetentionDays > 0) {
        const deleted = sweepOldSessionEvents(app.db, settings.eventRetentionDays);
        if (deleted > 0) {
          app.log.info(
            { deleted, retentionDays: settings.eventRetentionDays },
            "swept expired session_events rows",
          );
        }
      }
      if (settings.eventRetentionPerSession > 0) {
        const deleted = sweepSessionEventCap(app.db, settings.eventRetentionPerSession);
        if (deleted > 0) {
          app.log.info(
            { deleted, maxPerSession: settings.eventRetentionPerSession },
            "swept over-cap session_events rows",
          );
        }
      }
    } catch (err) {
      app.log.error({ err }, "session_events retention sweep failed");
    } finally {
      sweeping = false;
      opts?.onTick?.();
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
