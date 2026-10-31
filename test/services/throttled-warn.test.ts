// The shared throttle policy — the one place that decides how often a
// "this state is stuck" warning may repeat.
//
// The eviction rule is the subtle part: a key that keeps getting re-warned
// must not cost an innocent key its slot, and the key that IS evicted must
// be the least recently warned one. That rule regressed once already (a
// re-warn at capacity evicted an innocent key, which then warned immediately),
// so it is pinned here rather than left to whichever caller happens to use it.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createThrottledWarn } from "../../src/services/throttled-warn.js";

describe("createThrottledWarn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A minimal app whose logger records the warnings. */
  function fakeApp() {
    const warn = vi.fn();
    return { app: { log: { warn } } as never, warn };
  }

  it("warns once per key per interval", () => {
    vi.useFakeTimers();
    const { app, warn } = fakeApp();
    const throttled = createThrottledWarn(1000);

    throttled(app, 1, {}, "first");
    throttled(app, 1, {}, "second");
    expect(warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    throttled(app, 1, {}, "third");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("throttles each key independently", () => {
    vi.useFakeTimers();
    const { app, warn } = fakeApp();
    const throttled = createThrottledWarn(1000);

    throttled(app, 1, {}, "one");
    throttled(app, 1, {}, "one again");
    expect(warn).toHaveBeenCalledTimes(1);

    // A different key is not blocked by the first one's quiet period.
    throttled(app, 2, {}, "two");
    expect(warn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    throttled(app, 1, {}, "one later");
    throttled(app, 2, {}, "two later");
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("passes the fields and the message through to the logger", () => {
    const { app, warn } = fakeApp();
    const throttled = createThrottledWarn(1000);

    throttled(app, 7, { taskId: 7, detail: "boom" }, "the message");

    expect(warn).toHaveBeenCalledWith({ taskId: 7, detail: "boom" }, "the message");
  });

  it("evicts the least recently warned key when a new key arrives at the cap", () => {
    vi.useFakeTimers();
    const { app, warn } = fakeApp();
    const throttled = createThrottledWarn(1000, 3);

    throttled(app, 1, {}, "one");
    vi.advanceTimersByTime(1000);
    throttled(app, 2, {}, "two");
    vi.advanceTimersByTime(1000);
    throttled(app, 3, {}, "three");
    // The cap is reached: key 1 is the least recently warned.
    vi.advanceTimersByTime(1000);
    throttled(app, 4, {}, "four");
    expect(warn).toHaveBeenCalledTimes(4);

    // Key 1 was evicted, so it warns again right away. Key 2 was NOT
    // evicted — it is still tracked, so its own quiet period applies.
    vi.advanceTimersByTime(1000);
    throttled(app, 1, {}, "one again");
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("does not evict an innocent key when an already-tracked key is re-warned", () => {
    vi.useFakeTimers();
    const { app, warn } = fakeApp();
    const throttled = createThrottledWarn(10_000, 3);

    // Three keys, warned at staggered times so their quiet periods end at
    // different moments: key 1 at t=10000, key 2 at t=11000, key 3 at 12000.
    throttled(app, 1, {}, "one");
    vi.advanceTimersByTime(1000);
    throttled(app, 2, {}, "two");
    vi.advanceTimersByTime(1000);
    throttled(app, 3, {}, "three");
    expect(warn).toHaveBeenCalledTimes(3);

    // Key 1's quiet period is over and the map is at its cap. Re-warning it
    // is NOT a new key, so nothing may be evicted — key 2 keeps its slot.
    vi.advanceTimersByTime(8000);
    throttled(app, 1, {}, "one again");
    expect(warn).toHaveBeenCalledTimes(4);

    // Key 2 is still tracked and still inside its own quiet period, so it
    // stays quiet. (Had the re-warn evicted it, this call would warn.)
    vi.advanceTimersByTime(500);
    throttled(app, 2, {}, "two too soon");
    expect(warn).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(500);
    throttled(app, 2, {}, "two later");
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("forgets everything on reset", () => {
    vi.useFakeTimers();
    const { app, warn } = fakeApp();
    const throttled = createThrottledWarn(1000);

    throttled(app, 1, {}, "one");
    throttled(app, 1, {}, "two");
    expect(warn).toHaveBeenCalledTimes(1);

    throttled.reset();
    throttled(app, 1, {}, "three");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
