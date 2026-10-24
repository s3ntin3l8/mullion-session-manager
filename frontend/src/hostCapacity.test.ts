import { describe, it, expect } from "vitest";
import {
  CAPACITY_STALE_AFTER_MS,
  formatBytes,
  formatCapacityAge,
  formatHostCapacity,
  formatHostPlatform,
} from "./hostCapacity.js";
import { makeHost } from "./test/fixtures.js";
import type { HostCapacity } from "./api/index.js";

// Issue #1726 / roadmap 8.12 — the capacity display's rules. The two that
// matter: a host that reported nothing is UNKNOWN (never zero), and a
// reading that aged out is marked stale rather than presented as current.

const NOW = Date.parse("2026-01-01T00:10:00.000Z");

function capacity(overrides: Partial<HostCapacity> = {}): HostCapacity {
  return {
    platform: "linux",
    logicalCores: 12,
    loadAverage1m: 1.234,
    memory: { totalBytes: 32 * 1024 ** 3, freeBytes: 8.2 * 1024 ** 3 },
    sessions: { tracked: 3, alive: 2 },
    sampledAt: new Date(NOW - 5_000).toISOString(),
    ...overrides,
  };
}

describe("formatHostCapacity — unknown is not zero (issue #1726)", () => {
  it("reports a host that never reported a capacity as UNKNOWN", () => {
    const display = formatHostCapacity(makeHost({ health: "online" }), NOW);
    expect(display.known).toBe(false);
    // The important half: no number at all, so nothing can render a zero.
    expect(display.cores).toBeNull();
    expect(display.load).toBeNull();
    expect(display.memory).toBeNull();
    expect(display.ageMs).toBeNull();
  });

  it("reports an explicit null capacity as unknown too", () => {
    const display = formatHostCapacity(makeHost({ capacity: null, health: "online" }), NOW);
    expect(display.known).toBe(false);
  });

  it("shows the numbers when the host did report", () => {
    const host = makeHost({ health: "online", capacity: capacity() });
    const display = formatHostCapacity(host, NOW);
    expect(display.known).toBe(true);
    expect(display.cores).toBe(12);
    expect(display.load).toBe("1.23");
    expect(display.memory).toContain("free of");
    expect(display.stale).toBe(false);
  });
});

describe("formatHostCapacity — a reading is not a fact (issue #1726)", () => {
  it("marks a reading that aged out as stale, with its age", () => {
    const host = makeHost({
      health: "online",
      capacity: capacity({
        sampledAt: new Date(NOW - (CAPACITY_STALE_AFTER_MS + 1_000)).toISOString(),
      }),
    });
    const display = formatHostCapacity(host, NOW);
    expect(display.stale).toBe(true);
    expect(display.known).toBe(true);
    expect(display.ageMs).toBeGreaterThan(CAPACITY_STALE_AFTER_MS);
  });

  it("marks a reading stale when the host is not online, however fresh it is", () => {
    // A host that went quiet keeps its last known numbers — they are all
    // there is, so they are shown, but marked as not current.
    const host = makeHost({ health: "offline", capacity: capacity() });
    const display = formatHostCapacity(host, NOW);
    expect(display.stale).toBe(true);
    expect(display.known).toBe(true);
  });

  it("marks an unparseable timestamp stale rather than pretending it is fresh", () => {
    const host = makeHost({ health: "online", capacity: capacity({ sampledAt: "not a date" }) });
    const display = formatHostCapacity(host, NOW);
    expect(display.stale).toBe(true);
    expect(display.ageMs).toBeNull();
  });
});

describe("formatHostPlatform (issue #1726)", () => {
  it("prefers the host row's own platform", () => {
    const host = makeHost({ platform: "darwin", capacity: capacity({ platform: "linux" }) });
    expect(formatHostPlatform(host)).toBe("macOS");
  });

  it("falls back to the capacity reading's platform", () => {
    const host = makeHost({ platform: null, capacity: capacity({ platform: "linux" }) });
    expect(formatHostPlatform(host)).toBe("Linux");
  });

  it("says nothing when the host never said", () => {
    expect(formatHostPlatform(makeHost({ platform: null }))).toBeNull();
  });

  it("passes an unknown platform token through rather than hiding it", () => {
    expect(formatHostPlatform(makeHost({ platform: "freebsd" }))).toBe("freebsd");
  });
});

describe("the formatting helpers", () => {
  it("formats bytes in the biggest unit that reads well", () => {
    expect(formatBytes(8.2 * 1024 ** 3)).toBe("8.2 GB");
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB");
  });

  it("says 'unknown' for a nonsense byte count rather than printing NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("unknown");
    expect(formatBytes(-1)).toBe("unknown");
  });

  it("describes a reading's age in the biggest sensible unit", () => {
    expect(formatCapacityAge(3_000)).toBe("just now");
    expect(formatCapacityAge(30_000)).toBe("30s ago");
    expect(formatCapacityAge(180_000)).toBe("3 min ago");
    expect(formatCapacityAge(7_200_000)).toBe("2h ago");
    expect(formatCapacityAge(null)).toBeNull();
  });
});
