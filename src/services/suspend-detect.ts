import type { FastifyInstance } from "fastify";

// Issue #1719 (roadmap 8.5) — sleep/wake resilience for macOS agents.
//
// WHY THIS EXISTS: macOS *suspends* a laptop's processes when it sleeps; it
// does not kill them. A Mullion agent on a sleeping Mac therefore comes back
// with its processes intact but with its network connection severed and every
// timer it had pending now overdue. Detecting that transition is what lets
// the agent revalidate its credential (agent-enrollment.ts) and the keep-awake
// service re-arm (keep-awake.ts) instead of waiting for their next ordinary
// tick — which, for a credential TTL measured in hours, could be far too late.
//
// HOW THE DETECTION WORKS: a plain Node process has no sleep/wake
// notification — Electron's `powerMonitor` is not available here, and there is
// no portable native equivalent. So we sample the *wall clock* on a fixed
// interval and look for a gap.
//
// The wall clock is the right clock to compare against precisely BECAUSE it
// advances across a suspend while the process's timers do not fire: a timer
// due at T is still pending when the machine resumes at T+8h, so the first
// tick after the resume lands 8h later than the previous one. That gap is the
// signal.
//
// Deliberately NOT used: the monotonic clock (`process.hrtime`, Node's
// `uv_hrtime`). Whether it advances across a macOS suspend differs by
// platform and hardware generation (mach_absolute_time vs CLOCK_MONOTONIC
// semantics), and that difference is exactly one of the things the macOS
// hardware validation has to MEASURE (see issue #1719 and
// scripts/macos-sleep-wake-check.sh). Building the detection on a clock whose
// behaviour across sleep is unverified would make this module's correctness
// depend on an unmeasured assumption — so it deliberately depends only on the
// wall clock, whose behaviour is unambiguous.
//
// The detection itself is platform-NEUTRAL: it runs everywhere and simply
// never fires on a host that is never suspended. Only the *effects* of a
// resume are platform-sensitive, and those are gated by their own callers.

/** How often the wall clock is sampled. */
export const DEFAULT_SUSPEND_POLL_INTERVAL_MS = 15_000;

/**
 * How many poll intervals a gap must span before it counts as a suspend.
 *
 * Three, not one: a single missed tick happens on any momentarily loaded
 * host (a GC pause, a slow disk, a CPU-bound sweep), and treating that as a
 * suspend would fire spurious resume events. A real macOS sleep is measured
 * in minutes at the very least, so a 3-interval threshold (45s at the default
 * poll) separates the two cleanly with room to spare.
 */
export const SUSPEND_GAP_INTERVALS = 3;

export interface SuspendEvent {
  /**
   * How long the host was asleep, in milliseconds — the gap between two
   * consecutive ticks, minus the one interval that was legitimately due.
   * Zero for a gap too short to be a suspend (never emitted today, but the
   * subtraction makes the value meaningful if the threshold is ever lowered).
   */
  sleptMs: number;
}

export interface SuspendWatcherOptions {
  /** How often to sample the wall clock. Defaults to 15s. */
  intervalMs?: number;
  /**
   * Injectable wall clock — tests only. Defaults to `Date.now`.
   *
   * Injecting rather than mocking the global clock keeps this module free of
   * any dependency on a fake-timer implementation, and lets a test drive an
   * 8-hour sleep in microseconds.
   */
  now?: () => number;
}

export interface SuspendWatcherHandle {
  /**
   * Subscribes to resume events. Returns an unsubscribe function.
   *
   * Listeners are invoked synchronously, in subscription order, from the
   * timer callback that detected the gap. A listener that throws must not
   * prevent the others from running, and must not kill the timer.
   */
  onResume(listener: (event: SuspendEvent) => void): () => void;
  /** Stops sampling. Idempotent. */
  stop(): void;
}

/**
 * Starts sampling the wall clock and reporting resumes.
 *
 * The timer is `unref()`'d, matching the repo's convention for background
 * timers (see src/plugins/pty.ts's reconcile timer): a keep-alive timer must
 * never be the reason a process refuses to exit.
 */
export function startSuspendWatcher(
  app: FastifyInstance,
  options: SuspendWatcherOptions = {},
): SuspendWatcherHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_SUSPEND_POLL_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const thresholdMs = intervalMs * SUSPEND_GAP_INTERVALS;

  const listeners = new Set<(event: SuspendEvent) => void>();

  let lastTickAt: number | null = null;
  let stopped = false;

  const timer = setInterval(() => {
    const at = now();
    const previous = lastTickAt;
    lastTickAt = at;
    if (previous === null) return; // First sample establishes the baseline.
    const gap = at - previous;
    if (gap < thresholdMs) return; // An ordinary tick — no suspend happened.

    // The gap spans the sleep plus the one interval that was due at
    // `previous + intervalMs`. Subtracting that interval leaves the sleep
    // itself.
    const sleptMs = Math.max(0, gap - intervalMs);
    app.log.info({ gapMs: gap, sleptMs }, "[suspend] resume detected after a suspend");

    for (const listener of [...listeners]) {
      try {
        listener({ sleptMs });
      } catch (err) {
        // One bad listener must not take down the others, nor the timer.
        app.log.error({ err }, "[suspend] a resume listener threw");
      }
    }
  }, intervalMs);
  timer.unref();

  return {
    onResume(listener: (event: SuspendEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      listeners.clear();
    },
  };
}
