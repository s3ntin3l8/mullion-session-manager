import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_WAIT_UNTIL,
  MAX_WAIT_TIMEOUT_MS,
  parseWaitTimeout,
  parseWaitUntil,
  waitForSession,
  type WaitDeps,
  type WaitSnapshot,
} from "../../src/services/session-wait.js";

const snap = (
  status: WaitSnapshot["status"],
  severity: WaitSnapshot["severity"],
  detail: string | null = null,
): WaitSnapshot => ({ status, severity, detail });

/** A controllable fake of everything environmental. */
function makeDeps(initial: WaitSnapshot | null) {
  let current: WaitSnapshot | null = initial;
  let head = 0;
  const listeners = new Set<() => void>();
  const readStatus = vi.fn(async () => current);
  const deps: WaitDeps = {
    readStatus,
    eventSeqHead: () => head,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    deps,
    readStatus,
    listeners,
    set(next: WaitSnapshot | null) {
      current = next;
    },
    setHead(n: number) {
      head = n;
    },
    emit(nextHead?: number) {
      if (nextHead !== undefined) head = nextHead;
      for (const l of [...listeners]) l();
    },
  };
}

const until = (...v: string[]) => new Set(v);

describe("waitForSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves immediately when the status already matches", async () => {
    const f = makeDeps(snap("finished", "done"));
    const result = await waitForSession({ until: until("done"), timeoutMs: 5_000 }, f.deps);
    expect(result).toEqual({ status: "finished", severity: "done", detail: null, timedOut: false });
    expect(f.listeners.size).toBe(0);
  });

  it("matches on a status name as well as on a severity", async () => {
    const f = makeDeps(snap("awaiting_permission", "blocked"));
    const result = await waitForSession(
      { until: until("awaiting_permission"), timeoutMs: 5_000 },
      f.deps,
    );
    expect(result).toMatchObject({ status: "awaiting_permission", timedOut: false });
  });

  it("wakes on a session event, without waiting for the tick", async () => {
    const f = makeDeps(snap("working", "busy"));
    const p = waitForSession({ until: until("done"), timeoutMs: 60_000 }, f.deps);
    await vi.advanceTimersByTimeAsync(0);
    f.set(snap("finished", "done"));
    f.emit();
    await expect(p).resolves.toMatchObject({ status: "finished", timedOut: false });
    expect(f.listeners.size).toBe(0);
  });

  it("catches a time-based transition (no event) via the periodic tick", async () => {
    const f = makeDeps(snap("working", "busy"));
    const p = waitForSession({ until: until("dormant"), timeoutMs: 60_000 }, f.deps);
    await vi.advanceTimersByTimeAsync(0);
    f.set(snap("idle", "dormant"));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toMatchObject({ status: "idle", timedOut: false });
  });

  it("times out, reporting the last observed status, and releases everything", async () => {
    const f = makeDeps(snap("working", "busy", "x"));
    const p = waitForSession({ until: until("done"), timeoutMs: 3_000 }, f.deps);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(p).resolves.toEqual({
      timedOut: true,
      status: "working",
      severity: "busy",
      detail: "x",
    });
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out with nulls if no status was ever read", async () => {
    const f = makeDeps(snap("working", "busy"));
    f.readStatus.mockImplementation(() => new Promise(() => {}));
    const p = waitForSession({ until: until("done"), timeoutMs: 1_000 }, f.deps);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toEqual({
      timedOut: true,
      status: null,
      severity: null,
      detail: null,
    });
  });

  it("ignores a stale match until the session emits an event newer than afterSeq", async () => {
    const f = makeDeps(snap("finished", "done"));
    f.setHead(4);
    const p = waitForSession({ until: until("done"), timeoutMs: 60_000, afterSeq: 4 }, f.deps);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(f.readStatus.mock.calls.length).toBeGreaterThan(1);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    f.emit(5);
    await expect(p).resolves.toMatchObject({ status: "finished", timedOut: false });
  });

  it("treats an afterSeq ahead of the session's head as a stale (pre-restart) cursor and ignores it", async () => {
    const f = makeDeps(snap("finished", "done"));
    f.setHead(2);
    const result = await waitForSession(
      { until: until("done"), timeoutMs: 5_000, afterSeq: 40 },
      f.deps,
    );
    expect(result).toMatchObject({ status: "finished", timedOut: false });
  });

  it("tolerates transient read failures, but gives up after MAX_CONSECUTIVE_READ_FAILURES", async () => {
    const f = makeDeps(snap("working", "busy"));
    f.readStatus
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(snap("finished", "done"));
    const p = waitForSession({ until: until("done"), timeoutMs: 60_000 }, f.deps);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toMatchObject({ status: "finished", timedOut: false });

    const g = makeDeps(snap("working", "busy"));
    g.readStatus.mockRejectedValue(new Error("down"));
    const q = waitForSession({ until: until("done"), timeoutMs: 60_000 }, g.deps);
    const assertion = expect(q).rejects.toThrow("down");
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    expect(g.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failure streak is reset by a successful read", async () => {
    const f = makeDeps(snap("working", "busy"));
    f.readStatus
      .mockRejectedValueOnce(new Error("e"))
      .mockRejectedValueOnce(new Error("e"))
      .mockResolvedValueOnce(snap("working", "busy"))
      .mockRejectedValueOnce(new Error("e"))
      .mockRejectedValueOnce(new Error("e"))
      .mockResolvedValue(snap("finished", "done"));
    const p = waitForSession({ until: until("done"), timeoutMs: 60_000 }, f.deps);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(p).resolves.toMatchObject({ status: "finished" });
  });

  it("rejects with 'not authorized' as soon as the authorized() check fails", async () => {
    const f = makeDeps(snap("working", "busy"));
    let ok = true;
    const p = waitForSession(
      { until: until("done"), timeoutMs: 60_000 },
      { ...f.deps, authorized: () => ok },
    );
    const assertion = expect(p).rejects.toThrow("not authorized");
    await vi.advanceTimersByTimeAsync(0);
    ok = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a gone session matches regardless of the afterSeq gate", async () => {
    const f = makeDeps(snap("exited", "gone"));
    const result = await waitForSession(
      { until: until("gone"), timeoutMs: 5_000, afterSeq: 99 },
      f.deps,
    );
    expect(result).toMatchObject({ status: "exited", timedOut: false });
  });

  it("rejects when the session does not exist", async () => {
    const f = makeDeps(null);
    await expect(
      waitForSession({ until: until("done"), timeoutMs: 5_000 }, f.deps),
    ).rejects.toThrow("session not found");
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects, and cleans up, when reading the status keeps throwing", async () => {
    const f = makeDeps(snap("working", "busy"));
    f.readStatus.mockRejectedValue(new Error("boom"));
    const p = waitForSession({ until: until("done"), timeoutMs: 5_000 }, f.deps);
    const assertion = expect(p).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces an event burst during an in-flight read into one follow-up read", async () => {
    const f = makeDeps(snap("working", "busy"));
    let release!: () => void;
    f.readStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(snap("working", "busy"));
        }),
    );
    const p = waitForSession({ until: until("done"), timeoutMs: 60_000 }, f.deps);
    f.emit();
    f.emit();
    f.emit();
    expect(f.readStatus).toHaveBeenCalledTimes(1);
    f.set(snap("finished", "done"));
    release();
    await expect(p).resolves.toMatchObject({ status: "finished" });
    expect(f.readStatus).toHaveBeenCalledTimes(2);
  });

  it("aborts via the signal, releasing everything", async () => {
    const f = makeDeps(snap("working", "busy"));
    const ac = new AbortController();
    const p = waitForSession(
      { until: until("done"), timeoutMs: 60_000 },
      { ...f.deps, signal: ac.signal },
    );
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await expect(p).resolves.toEqual({ aborted: true });
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns aborted at once for an already-aborted signal", async () => {
    const f = makeDeps(snap("working", "busy"));
    const ac = new AbortController();
    ac.abort();
    await expect(
      waitForSession({ until: until("done"), timeoutMs: 60_000 }, { ...f.deps, signal: ac.signal }),
    ).resolves.toEqual({ aborted: true });
    expect(f.listeners.size).toBe(0);
  });
});

describe("parseWaitUntil", () => {
  it("the default is the attention severities plus gone", () => {
    expect([...DEFAULT_WAIT_UNTIL].sort()).toEqual(
      ["blocked", "done", "failed", "gone", "waiting"].sort(),
    );
  });

  it("defaults to the attention set", () => {
    const r = parseWaitUntil(undefined);
    expect(r).toEqual({ ok: true, until: new Set(DEFAULT_WAIT_UNTIL) });
    expect(parseWaitUntil(null)).toEqual(r);
  });

  it("accepts known statuses and severities", () => {
    expect(parseWaitUntil(["finished", "blocked"])).toEqual({
      ok: true,
      until: new Set(["finished", "blocked"]),
    });
  });

  it.each([[[]], ["done"], [["done", 3]], [["nope"]]])("rejects %j", (raw) => {
    expect(parseWaitUntil(raw)).toMatchObject({ ok: false });
  });
});

describe("parseWaitTimeout", () => {
  it("defaults, passes through, and clamps", () => {
    expect(parseWaitTimeout(undefined)).toEqual({ ok: true, timeoutMs: DEFAULT_WAIT_TIMEOUT_MS });
    expect(parseWaitTimeout(2_500)).toEqual({ ok: true, timeoutMs: 2_500 });
    expect(parseWaitTimeout(10 * MAX_WAIT_TIMEOUT_MS)).toEqual({
      ok: true,
      timeoutMs: MAX_WAIT_TIMEOUT_MS,
    });
    expect(parseWaitTimeout(0.4)).toEqual({ ok: true, timeoutMs: 1 });
  });

  it.each([[0], [-5], ["10"], [Number.NaN], [Infinity]])("rejects %j", (raw) => {
    expect(parseWaitTimeout(raw)).toMatchObject({ ok: false });
  });
});
