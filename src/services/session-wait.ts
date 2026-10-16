// Server-owned "wait until this session needs attention" — the engine behind
// the control socket's `sessions.wait` (parent→child orchestration). The wait
// lives HERE, not in the caller: an agent that polled sessions.get itself
// would burn a model turn per poll and miss short-lived states.
//
// Pure of Fastify/PtyManager on purpose — everything environmental
// (reading the derived status, the per-session event feed, the event-seq
// head) is injected via WaitDeps so the timing logic is unit-testable with
// fake timers.
import {
  SESSION_SEVERITIES,
  SESSION_STATUSES,
  type SessionSeverity,
  type SessionStatus,
} from "./session-status.js";

/** Anything that needs the parent's attention (or means it's over). Mirrors
 * session-status.ts's ATTENTION_SEVERITIES, plus "gone". */
export const DEFAULT_WAIT_UNTIL: readonly string[] = [
  "done",
  "blocked",
  "waiting",
  "failed",
  "gone",
];
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
export const MAX_WAIT_TIMEOUT_MS = 60 * 60_000;
/** Consecutive status-read failures tolerated before the wait gives up — one
 * transient hiccup must not kill a wait that may run for an hour. */
export const MAX_CONSECUTIVE_READ_FAILURES = 3;
/** `idle` and `needs_input` are time-based and emit no event, so the wait
 * also re-checks on a slow tick. */
export const WAIT_TICK_MS = 1_000;

export interface WaitSnapshot {
  status: SessionStatus;
  severity: SessionSeverity;
  detail: string | null;
}

export interface WaitDeps {
  /** Derived status right now, or null if the session no longer exists. */
  readStatus: () => Promise<WaitSnapshot | null>;
  /** Highest event seq the session has emitted (0 if it isn't live). */
  eventSeqHead: () => number;
  /** Calls `listener` on every event the session emits; returns unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Re-checked every round; returning false ends the wait with a rejection
   * ("not authorized") — e.g. the waiting parent was killed meanwhile. */
  authorized?: () => boolean;
  signal?: AbortSignal;
  tickMs?: number;
}

export interface WaitOptions {
  until: ReadonlySet<string>;
  timeoutMs: number;
  /** Stale-latch guard: a match only counts once the session has emitted an
   * event with seq > afterSeq, so a fresh prompt can't instantly "match" the
   * previous turn's `finished`. A `gone` session always matches. A cursor
   * AHEAD of the session's head is stale (event seqs reset when the server
   * restarts) and is ignored, so a saved cursor can't wedge the wait. */
  afterSeq?: number;
}

export type WaitResult =
  | (WaitSnapshot & { timedOut: false })
  | {
      timedOut: true;
      status: SessionStatus | null;
      severity: SessionSeverity | null;
      detail: string | null;
    }
  | { aborted: true };

/** Validates a caller-supplied `until` (statuses and/or severities). */
export function parseWaitUntil(
  raw: unknown,
): { ok: true; until: Set<string> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, until: new Set(DEFAULT_WAIT_UNTIL) };
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "'until' must be a non-empty array of statuses or severities" };
  }
  const known = new Set<string>([...SESSION_STATUSES, ...SESSION_SEVERITIES]);
  for (const value of raw) {
    if (typeof value !== "string" || !known.has(value)) {
      return { ok: false, error: `unknown status or severity in 'until': ${String(value)}` };
    }
  }
  return { ok: true, until: new Set(raw as string[]) };
}

/** Defaults to 10 min, clamped to [1ms, 1h]; rejects a non-number. */
export function parseWaitTimeout(
  raw: unknown,
): { ok: true; timeoutMs: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, timeoutMs: DEFAULT_WAIT_TIMEOUT_MS };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return { ok: false, error: "'timeoutMs' must be a positive number" };
  }
  return { ok: true, timeoutMs: Math.min(Math.floor(raw) || 1, MAX_WAIT_TIMEOUT_MS) };
}

export function waitForSession(opts: WaitOptions, deps: WaitDeps): Promise<WaitResult> {
  return new Promise<WaitResult>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let recheck = false;
    let last: WaitSnapshot | null = null;
    let readFailures = 0;

    // Releases the timer, interval, event listener and abort listener — the
    // wait must leave nothing behind however it ends.
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeout);
      clearInterval(tick);
      unsubscribe();
      deps.signal?.removeEventListener("abort", onAbort);
      return true;
    };
    const finish = (result: WaitResult) => {
      if (settle()) resolve(result);
    };
    const fail = (err: unknown) => {
      if (settle()) reject(err);
    };
    const onAbort = () => finish({ aborted: true });

    const check = async () => {
      // Coalesce: an event burst while a read is in flight triggers exactly
      // one follow-up read, never a pile of concurrent ones.
      if (checking) {
        recheck = true;
        return;
      }
      checking = true;
      try {
        do {
          recheck = false;
          if (deps.authorized && !deps.authorized()) {
            fail(new Error("not authorized"));
            return;
          }
          const snapshot = await deps.readStatus();
          if (settled) return;
          readFailures = 0;
          if (snapshot === null) {
            fail(new Error("session not found"));
            return;
          }
          last = snapshot;
          const matches = opts.until.has(snapshot.status) || opts.until.has(snapshot.severity);
          // head > afterSeq: a newer event arrived. head < afterSeq: stale
          // cursor from before a restart. Only head === afterSeq holds back.
          const turnStarted =
            snapshot.severity === "gone" ||
            opts.afterSeq === undefined ||
            deps.eventSeqHead() !== opts.afterSeq;
          if (matches && turnStarted) {
            finish({ ...snapshot, timedOut: false });
            return;
          }
        } while (recheck && !settled);
      } catch (err) {
        // Tolerate a few consecutive read failures (the next tick retries).
        readFailures += 1;
        if (readFailures >= MAX_CONSECUTIVE_READ_FAILURES) fail(err);
      } finally {
        checking = false;
      }
    };

    const timeout = setTimeout(() => {
      finish({
        timedOut: true,
        status: last?.status ?? null,
        severity: last?.severity ?? null,
        detail: last?.detail ?? null,
      });
    }, opts.timeoutMs);
    const tick = setInterval(() => void check(), deps.tickMs ?? WAIT_TICK_MS);
    const unsubscribe = deps.subscribe(() => void check());

    if (deps.signal?.aborted) {
      onAbort();
      return;
    }
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    void check();
  });
}
