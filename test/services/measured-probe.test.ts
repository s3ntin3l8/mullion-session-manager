import { describe, expect, it, vi } from "vitest";
import { createMeasuredProbe } from "../../src/services/measured-probe.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createMeasuredProbe", () => {
  it("answers 'measuring' without waiting for a slow run", async () => {
    const run = deferred<{ bytes: number }>();
    const probe = createMeasuredProbe(() => run.promise, { ttlMs: 1000, waitMs: 5 });
    expect(await probe.read()).toEqual({ state: "measuring", measuredAt: null });
  });

  it("returns the value, flat, once the run finishes inside the wait", async () => {
    const probe = createMeasuredProbe(async () => ({ bytes: 7 }), {
      ttlMs: 1000,
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    });
    expect(await probe.read()).toEqual({
      bytes: 7,
      state: "ready",
      measuredAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("starts one run for concurrent reads and picks the result up on the next read", async () => {
    const run = deferred<{ bytes: number }>();
    const fn = vi.fn(() => run.promise);
    const probe = createMeasuredProbe(fn, { ttlMs: 1000, waitMs: 5 });
    await Promise.all([probe.read(), probe.read(), probe.read({ refresh: true })]);
    expect(fn).toHaveBeenCalledTimes(1);
    run.resolve({ bytes: 3 });
    expect(await probe.read()).toMatchObject({ bytes: 3, state: "ready" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("counts the TTL from when the run finishes, not from when it started", async () => {
    let clock = 0;
    const run = deferred<{ bytes: number }>();
    const fn = vi.fn(() => run.promise);
    const probe = createMeasuredProbe(fn, { ttlMs: 100, waitMs: 5, now: () => clock });
    await probe.read();
    clock = 10_000; // far longer than the TTL, spent inside the run
    run.resolve({ bytes: 1 });
    expect(await probe.read()).toMatchObject({ bytes: 1, state: "ready" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("re-measures after the TTL and on refresh, keeping the old figures meanwhile", async () => {
    let clock = 0;
    const second = deferred<{ bytes: number }>();
    const fn = vi
      .fn<() => Promise<{ bytes: number }>>()
      .mockResolvedValueOnce({ bytes: 1 })
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ bytes: 3 });
    const probe = createMeasuredProbe(fn, { ttlMs: 100, waitMs: 5, now: () => clock });
    expect(await probe.read()).toMatchObject({ bytes: 1 });
    expect(await probe.read()).toMatchObject({ bytes: 1, state: "ready" });
    expect(fn).toHaveBeenCalledTimes(1);

    const refreshing = await probe.read({ refresh: true });
    expect(refreshing).toMatchObject({ bytes: 1, state: "measuring" });
    expect(fn).toHaveBeenCalledTimes(2);
    second.resolve({ bytes: 2 });
    expect(await probe.read()).toMatchObject({ bytes: 2, state: "ready" });

    clock = 1000;
    await probe.read();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("discards an invalidated run, and starts the next one only after it ends", async () => {
    const stale = deferred<{ bytes: number }>();
    const fn = vi
      .fn<() => Promise<{ bytes: number }>>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ bytes: 2 });
    const probe = createMeasuredProbe(fn, { ttlMs: 1000, waitMs: 5 });
    await probe.read();
    probe.invalidate();
    // A read while the orphan still runs joins its wait: no second run yet.
    expect(await probe.read()).toEqual({ state: "measuring", measuredAt: null });
    expect(await probe.read({ refresh: true })).toEqual({ state: "measuring", measuredAt: null });
    expect(fn).toHaveBeenCalledTimes(1);
    stale.resolve({ bytes: 1 });
    // The orphan's figure is thrown away; the run that was asked for follows it.
    await vi.waitFor(async () =>
      expect(await probe.read()).toMatchObject({ bytes: 2, state: "ready" }),
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("starts no run after an invalidated one if nobody asks again", async () => {
    const stale = deferred<{ bytes: number }>();
    const fn = vi.fn<() => Promise<{ bytes: number }>>().mockReturnValueOnce(stale.promise);
    const probe = createMeasuredProbe(fn, { ttlMs: 1000, waitMs: 5 });
    await probe.read();
    probe.invalidate();
    stale.resolve({ bytes: 1 });
    await stale.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports a failed run, keeps earlier figures, and retries only after the TTL", async () => {
    let clock = 0;
    const fn = vi
      .fn<() => Promise<{ bytes: number }>>()
      .mockResolvedValueOnce({ bytes: 1 })
      .mockRejectedValueOnce(new Error("disk gone"))
      .mockResolvedValueOnce({ bytes: 3 });
    const probe = createMeasuredProbe(fn, { ttlMs: 100, waitMs: 5, now: () => clock });
    await probe.read();
    expect(await probe.read({ refresh: true })).toMatchObject({
      bytes: 1,
      state: "error",
      error: "disk gone",
    });
    expect(await probe.read()).toMatchObject({ state: "error" });
    expect(fn).toHaveBeenCalledTimes(2);
    clock = 500;
    expect(await probe.read()).toMatchObject({ bytes: 3, state: "ready" });
  });

  it("reports a first-run failure without a value", async () => {
    const probe = createMeasuredProbe(
      async (): Promise<{ bytes: number }> => {
        throw "nope";
      },
      { ttlMs: 1000 },
    );
    expect(await probe.read()).toEqual({
      state: "error",
      measuredAt: null,
      error: "Measurement failed",
    });
  });
});
