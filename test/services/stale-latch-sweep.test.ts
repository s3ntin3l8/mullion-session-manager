import { describe, it, expect } from "vitest";
import {
  isLatchStale,
  sweepStaleLatches,
  type StaleLatch,
  type StaleSweepContext,
} from "../../src/services/stale-latch-sweep.js";

const GRACE = 2000;

describe("isLatchStale", () => {
  it("is never stale without a baseline timestamp", () => {
    expect(isLatchStale(null, 1, 10_000, null, GRACE)).toBe(false);
  });
  it("needs the TTL to have elapsed", () => {
    expect(isLatchStale(1000, 5000, 5999, null, GRACE)).toBe(false);
    expect(isLatchStale(1000, 5000, 6000, null, GRACE)).toBe(true);
  });
  it("activity within the grace window of the latch is the same event; later activity is progress", () => {
    expect(isLatchStale(1000, 5000, 9000, 3000, GRACE)).toBe(true); // 3000 <= 1000+2000
    expect(isLatchStale(1000, 5000, 9000, 3001, GRACE)).toBe(false);
    expect(isLatchStale(1000, 5000, 9000, 500, GRACE)).toBe(true);
  });
});

describe("sweepStaleLatches", () => {
  function setup(
    latches: Array<Partial<StaleLatch> & { name: string }>,
    lastActivity: number | null = null,
  ) {
    const log: string[] = [];
    const full: StaleLatch[] = latches.map((l) => ({
      tier: "blocked",
      isActive: () => true,
      at: () => 0,
      clear: () => log.push(`clear:${l.name}`),
      ...l,
    }));
    const ctx: StaleSweepContext = {
      now: 100_000,
      blockedMaxAgeMs: 10_000,
      busyMaxAgeMs: 50_000,
      graceMs: GRACE,
      lastActivityAt: () => lastActivity,
      clearAttention: (k) => log.push(`attn:${k}`),
      emit: (n) => log.push(`emit:${n}`),
    };
    return { full, ctx, log };
  }

  it("clears a stale latch in order: clear, attention kind, emit", () => {
    const { full, ctx, log } = setup([{ name: "planState", attentionKind: "planReady" }]);
    expect(sweepStaleLatches(full, ctx)).toBe(true);
    expect(log).toEqual(["clear:planState", "attn:planReady", "emit:planState"]);
  });

  it("emits without an attention clear for a latch that owns no kind", () => {
    const { full, ctx, log } = setup([{ name: "compactState", tier: "busy" }]);
    expect(sweepStaleLatches(full, ctx)).toBe(true);
    expect(log).toEqual(["clear:compactState", "emit:compactState"]);
  });

  it("skips inactive latches without reading their timestamp", () => {
    let atReads = 0;
    const { full, ctx, log } = setup([
      {
        name: "x",
        isActive: () => false,
        at: () => {
          atReads++;
          return 0;
        },
      },
    ]);
    expect(sweepStaleLatches(full, ctx)).toBe(false);
    expect(atReads).toBe(0);
    expect(log).toEqual([]);
  });

  it("uses the blocked TTL for blocked latches and the longer busy TTL for busy ones", () => {
    const { full, ctx, log } = setup([
      { name: "blocked", tier: "blocked", at: () => 80_000 }, // 20s old > 10s
      { name: "busy", tier: "busy", at: () => 80_000 }, // 20s old < 50s
    ]);
    expect(sweepStaleLatches(full, ctx)).toBe(true);
    expect(log).toEqual(["clear:blocked", "emit:blocked"]);
  });

  it("leaves a fresh latch and one with later agent activity alone", () => {
    const fresh = setup([{ name: "fresh", at: () => 95_000 }]);
    expect(sweepStaleLatches(fresh.full, fresh.ctx)).toBe(false);
    const active = setup([{ name: "busyAgent", at: () => 0 }], 50_000);
    expect(sweepStaleLatches(active.full, active.ctx)).toBe(false);
    expect(active.log).toEqual([]);
  });

  it("evaluates lazily and in order: an earlier clear's side effects are visible to later predicates", () => {
    let flag = true;
    const { full, ctx, log } = setup([
      {
        name: "first",
        clear: () => {
          flag = false;
          log.push("clear:first");
        },
      },
      { name: "second", isActive: () => flag },
    ]);
    expect(sweepStaleLatches(full, ctx)).toBe(true);
    expect(log).toEqual(["clear:first", "emit:first"]);
  });

  it("returns false for an empty table", () => {
    const { ctx } = setup([]);
    expect(sweepStaleLatches([], ctx)).toBe(false);
  });
});
