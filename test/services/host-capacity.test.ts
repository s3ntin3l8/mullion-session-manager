import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  HostCapacityTracker,
  measureHostCapacity,
  type HostCapacity,
} from "../../src/services/host-capacity.js";

// Issue #1721 / roadmap 8.7 — the fleet's capacity signal. The measurement
// is the ONE producer of these numbers: the agent measures itself with it,
// and so does the primary. One function, two callers — that is what makes a
// local host's numbers comparable with an agent's.

/** A minimal app stand-in: measureHostCapacity only ever reads app.pty. */
function fakeApp(sessions: Array<{ id: string; alive: boolean }>): FastifyInstance {
  return {
    pty: {
      list: () => sessions.map((s) => ({ id: s.id, alive: s.alive })),
    },
  } as unknown as FastifyInstance;
}

const fixedDeps = {
  platform: () => "darwin",
  availableParallelism: () => 16,
  loadavg: () => [2.1, 1.8, 1.5],
  totalmem: () => 34359738368,
  freemem: () => 21474836480,
};

describe("measureHostCapacity (issue #1721)", () => {
  it("reports the platform, the cores, the load and the memory", () => {
    const capacity = measureHostCapacity(fakeApp([]), fixedDeps);
    expect(capacity.platform).toBe("darwin");
    expect(capacity.logicalCores).toBe(16);
    expect(capacity.loadAverage1m).toBe(2.1);
    expect(capacity.memory).toEqual({ totalBytes: 34359738368, freeBytes: 21474836480 });
  });

  it("counts the sessions this host tracks, and how many are alive", () => {
    const capacity = measureHostCapacity(
      fakeApp([
        { id: "a", alive: true },
        { id: "b", alive: false },
        { id: "c", alive: true },
      ]),
      fixedDeps,
    );
    expect(capacity.sessions).toEqual({ tracked: 3, alive: 2 });
  });

  it("reports zero sessions for a host that tracks none", () => {
    const capacity = measureHostCapacity(fakeApp([]), fixedDeps);
    expect(capacity.sessions).toEqual({ tracked: 0, alive: 0 });
  });

  it("reads this machine's real primitives when no dependencies are injected", () => {
    // The default path is the one that runs in production — the agent
    // measuring itself and the primary measuring itself.
    const capacity = measureHostCapacity(fakeApp([]));
    expect(capacity.platform).toBe(process.platform);
    expect(capacity.logicalCores).toBeGreaterThan(0);
    expect(capacity.memory.totalBytes).toBeGreaterThan(0);
    expect(capacity.loadAverage1m).toBeGreaterThanOrEqual(0);
  });

  it("falls back to a zero load average on a platform that reports none", () => {
    const capacity = measureHostCapacity(fakeApp([]), {
      ...fixedDeps,
      loadavg: () => [],
    });
    expect(capacity.loadAverage1m).toBe(0);
  });
});

describe("HostCapacityTracker (issue #1721)", () => {
  const capacity: HostCapacity = {
    platform: "linux",
    logicalCores: 8,
    loadAverage1m: 0.5,
    memory: { totalBytes: 100, freeBytes: 50 },
    sessions: { tracked: 1, alive: 1 },
  };

  it("records and returns a host's numbers with their age", () => {
    const tracker = new HostCapacityTracker();
    tracker.record("host-1", capacity, 1234);
    expect(tracker.get("host-1")).toEqual({ capacity, sampledAt: 1234 });
  });

  it("has no entry for a host that never reported", () => {
    const tracker = new HostCapacityTracker();
    expect(tracker.get("host-1")).toBeUndefined();
  });

  it("replaces the previous reading wholesale on a new one", () => {
    const tracker = new HostCapacityTracker();
    tracker.record("host-1", capacity, 1000);
    tracker.record("host-1", { ...capacity, logicalCores: 4 }, 2000);
    expect(tracker.get("host-1")).toEqual({
      capacity: { ...capacity, logicalCores: 4 },
      sampledAt: 2000,
    });
  });

  it("pruneMissing drops the entries of hosts that no longer exist", () => {
    const tracker = new HostCapacityTracker();
    tracker.record("host-1", capacity);
    tracker.record("host-2", capacity);
    tracker.pruneMissing(new Set(["host-2"]));
    expect(tracker.get("host-1")).toBeUndefined();
    expect(tracker.get("host-2")).toBeDefined();
  });

  it("invalidateHost drops one host's entry (its baseUrl/token changed)", () => {
    const tracker = new HostCapacityTracker();
    tracker.record("host-1", capacity);
    tracker.record("host-2", capacity);
    tracker.invalidateHost("host-1");
    expect(tracker.get("host-1")).toBeUndefined();
    expect(tracker.get("host-2")).toBeDefined();
  });

  it("clearForTests resets all tracked state", () => {
    const tracker = new HostCapacityTracker();
    tracker.record("host-1", capacity);
    tracker.clearForTests();
    expect(tracker.get("host-1")).toBeUndefined();
  });
});
