import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRelativeAge } from "./relativeTime.js";

// Hermes review, PR #130: formatRelativeAge previously had only implicit
// coverage via NotificationBell's own tests — now that it's a shared
// module, it gets explicit boundary/edge-case coverage of its own.
describe("formatRelativeAge", () => {
  const NOW = 1_700_000_000_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  function agoMs(deltaSeconds: number): number {
    return NOW - deltaSeconds * 1000;
  }

  it("reports 'just now' for a delta just under the 45s threshold", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatRelativeAge(agoMs(0))).toBe("just now");
    expect(formatRelativeAge(agoMs(44))).toBe("just now");
  });

  it("rounds into minutes once the delta reaches 45s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // 45s / 60 rounds to 1 — the threshold moves straight from "just now"
    // to "1m ago", there's no "0m ago" state.
    expect(formatRelativeAge(agoMs(45))).toBe("1m ago");
  });

  it("reports minutes up to the 59m/60m boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatRelativeAge(agoMs(30 * 60))).toBe("30m ago");
    expect(formatRelativeAge(agoMs(59 * 60))).toBe("59m ago");
  });

  it("rolls over to hours once the delta reaches 60 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatRelativeAge(agoMs(60 * 60))).toBe("1h ago");
  });

  it("reports hours up to the 23h/24h boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatRelativeAge(agoMs(12 * 3600))).toBe("12h ago");
    expect(formatRelativeAge(agoMs(23 * 3600))).toBe("23h ago");
  });

  it("rolls over to days once the delta reaches 24 hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatRelativeAge(agoMs(24 * 3600))).toBe("1d ago");
  });

  it("reports days for multi-day deltas", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatRelativeAge(agoMs(10 * 86400))).toBe("10d ago");
  });

  it("clamps a future timestamp (negative delta) to 'just now' instead of going negative", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatRelativeAge(NOW + 60_000)).toBe("just now");
  });
});
