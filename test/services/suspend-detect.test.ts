import { describe, it, expect, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  startSuspendWatcher,
  DEFAULT_SUSPEND_POLL_INTERVAL_MS,
  SUSPEND_GAP_INTERVALS,
} from "../../src/services/suspend-detect.js";

// Issue #1719 (roadmap 8.5) — the suspend/resume detection.
//
// The clock is INJECTED, so a test can simulate an 8-hour sleep in
// microseconds — and, more importantly, so the module's correctness does not
// depend on any assumption about how a particular platform's monotonic clock
// behaves across a suspend. (It deliberately uses the wall clock, which
// always advances; see the module's own doc comment.)

function mockApp(): FastifyInstance {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as FastifyInstance;
}

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("startSuspendWatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onResume with the sleep duration when the wall clock jumps past the threshold", () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    const app = mockApp();
    const watcher = startSuspendWatcher(app, { intervalMs: 1000, now: clock.now });

    const events: number[] = [];
    watcher.onResume((event) => events.push(event.sleptMs));

    // First tick: establishes the baseline, no event.
    clock.advance(1000);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);

    // An ordinary tick — no suspend.
    clock.advance(1000);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);

    // The machine sleeps for 8 hours. The wall clock jumps; the timer does
    // not fire until the process is scheduled again.
    clock.advance(8 * 60 * 60 * 1000);
    vi.advanceTimersByTime(1000);

    expect(events).toHaveLength(1);
    // The reported sleep is the gap between the two ticks MINUS the one
    // interval that was legitimately due — so it lands within one interval
    // below the real sleep (the interval that was pending when the machine
    // went down is part of the gap, not part of the sleep).
    expect(events[0]).toBeLessThanOrEqual(8 * 60 * 60 * 1000);
    expect(events[0]).toBeGreaterThan(8 * 60 * 60 * 1000 - 2 * 1000);
    watcher.stop();
  });

  it("does not fire below the threshold, and DOES fire exactly at it", () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    const watcher = startSuspendWatcher(mockApp(), { intervalMs: 1000, now: clock.now });
    const onResume = vi.fn();
    watcher.onResume(onResume);

    // Baseline.
    clock.advance(1000);
    vi.advanceTimersByTime(1000);

    // ONE missed tick on a loaded host (a 2-interval gap) is NOT a suspend.
    clock.advance(2000);
    vi.advanceTimersByTime(2000);
    expect(onResume).not.toHaveBeenCalled();

    // A gap of exactly the threshold (three intervals) IS a suspend — the
    // implementation fires at >=, not >.
    clock.advance(3000);
    vi.advanceTimersByTime(3000);
    expect(onResume).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it("stops sampling after stop()", () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    const watcher = startSuspendWatcher(mockApp(), { intervalMs: 1000, now: clock.now });
    const onResume = vi.fn();
    watcher.onResume(onResume);

    clock.advance(1000);
    vi.advanceTimersByTime(1000);

    watcher.stop();

    clock.advance(8 * 60 * 60 * 1000);
    vi.advanceTimersByTime(1000);
    expect(onResume).not.toHaveBeenCalled();

    // stop() is idempotent.
    expect(() => watcher.stop()).not.toThrow();
  });

  it("unsubscribes a listener through the returned function", () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    const watcher = startSuspendWatcher(mockApp(), { intervalMs: 1000, now: clock.now });
    const onResume = vi.fn();
    const unsubscribe = watcher.onResume(onResume);

    clock.advance(1000);
    vi.advanceTimersByTime(1000);

    unsubscribe();

    clock.advance(8 * 60 * 60 * 1000);
    vi.advanceTimersByTime(1000);
    expect(onResume).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("keeps the other listeners running when one of them throws", () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    const app = mockApp();
    const watcher = startSuspendWatcher(app, { intervalMs: 1000, now: clock.now });

    const throwing = vi.fn(() => {
      throw new Error("listener exploded");
    });
    const healthy = vi.fn();
    watcher.onResume(throwing);
    watcher.onResume(healthy);

    clock.advance(1000);
    vi.advanceTimersByTime(1000);
    clock.advance(8 * 60 * 60 * 1000);
    vi.advanceTimersByTime(1000);

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(app.log.error).toHaveBeenCalled();
    watcher.stop();
  });

  it("uses a 15s poll interval by default", () => {
    expect(DEFAULT_SUSPEND_POLL_INTERVAL_MS).toBe(15_000);
    expect(SUSPEND_GAP_INTERVALS).toBe(3);
  });
});
