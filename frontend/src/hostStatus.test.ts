import { describe, it, expect } from "vitest";
import { deriveHostStatus, type PingState } from "./hostStatus.js";
import { makeHost } from "./test/fixtures.js";

const NO_CLICK: PingState = { status: "unknown", lastCheckedAtSnapshot: null };

describe("deriveHostStatus (issue #246)", () => {
  it("shows nothing for a pending host with no click", () => {
    expect(deriveHostStatus(makeHost({ health: "pending" }), NO_CLICK)).toEqual({
      dot: undefined,
      label: null,
      color: "var(--dim)",
    });
  });

  it("shows green/on for an online heartbeat status", () => {
    const host = makeHost({ health: "online", lastCheckedAt: "2026-01-01T00:00:10.000Z" });
    const display = deriveHostStatus(host, NO_CLICK);
    expect(display).toEqual({ dot: "on", label: "online", color: "var(--g)" });
  });

  it("shows amber/warn for a degraded heartbeat status", () => {
    const host = makeHost({ health: "degraded", lastCheckedAt: "2026-01-01T00:00:10.000Z" });
    const display = deriveHostStatus(host, NO_CLICK);
    expect(display).toEqual({ dot: "warn", label: "degraded", color: "var(--y)" });
  });

  it("shows red/off for an offline heartbeat status", () => {
    const host = makeHost({ health: "offline", lastCheckedAt: "2026-01-01T00:00:10.000Z" });
    const display = deriveHostStatus(host, NO_CLICK);
    expect(display).toEqual({ dot: "off", label: "offline", color: "var(--r)" });
  });

  it("shows 'testing…' while a click is in flight, overriding a disagreeing heartbeat", () => {
    const host = makeHost({ health: "offline", lastCheckedAt: "2026-01-01T00:00:10.000Z" });
    const click: PingState = {
      status: "checking",
      lastCheckedAtSnapshot: "2026-01-01T00:00:10.000Z",
    };
    expect(deriveHostStatus(host, click)).toEqual({
      dot: undefined,
      label: "testing…",
      color: "var(--dim)",
    });
  });

  it("keeps a completed click's result even when the heartbeat disagrees, as long as no newer sweep has landed", () => {
    // The heartbeat's last sweep (t1) reported offline; the user clicked
    // Test right after and it succeeded — no sweep has run since.
    const t1 = "2026-01-01T00:00:10.000Z";
    const host = makeHost({ health: "offline", lastCheckedAt: t1 });
    const click: PingState = { status: "online", lastCheckedAtSnapshot: t1 };
    expect(deriveHostStatus(host, click)).toEqual({
      dot: "on",
      label: "online",
      color: "var(--g)",
    });
  });

  it("lets a newer sweep supersede a completed click once lastCheckedAt advances", () => {
    const t1 = "2026-01-01T00:00:10.000Z";
    const t2 = "2026-01-01T00:00:40.000Z"; // a real sweep ran after the click completed
    const host = makeHost({ health: "offline", lastCheckedAt: t2 });
    const click: PingState = { status: "online", lastCheckedAtSnapshot: t1 };
    expect(deriveHostStatus(host, click)).toEqual({
      dot: "off",
      label: "offline",
      color: "var(--r)",
    });
  });

  it("falls back to the click's own result for a still-pending host (poller hasn't swept yet)", () => {
    const host = makeHost({ health: "pending", lastCheckedAt: null });
    const click: PingState = { status: "offline", lastCheckedAtSnapshot: null };
    expect(deriveHostStatus(host, click)).toEqual({
      dot: "off",
      label: "offline",
      color: "var(--r)",
    });
  });

  it("shows nothing for a still-pending host with no click result yet", () => {
    const host = makeHost({ health: "pending", lastCheckedAt: null });
    const click: PingState = { status: "unknown", lastCheckedAtSnapshot: null };
    expect(deriveHostStatus(host, click)).toEqual({
      dot: undefined,
      label: null,
      color: "var(--dim)",
    });
  });

  // Regression for the clock-skew bug (Hermes review, PR #524, 2nd pass):
  // an out-of-order pair of ISO timestamps (t2 "earlier" than t1 as
  // strings/Dates) must NOT flip the outcome — freshness is decided purely
  // by string equality against the click's own snapshot, never by which
  // timestamp is "newer". A magnitude-based comparison (the original,
  // buggy version compared click.completedAt >= lastCheckedAtMs) would
  // fail this the moment the two values come from different clocks.
  it("is order-independent — only equality of the two tokens matters, never which is chronologically later", () => {
    const clickToken = "2026-01-01T00:00:40.000Z";
    const earlierServerToken = "2026-01-01T00:00:10.000Z"; // "earlier" than clickToken, but different
    const host = makeHost({ health: "offline", lastCheckedAt: earlierServerToken });
    const click: PingState = { status: "online", lastCheckedAtSnapshot: clickToken };
    // Tokens differ (even though the host's is chronologically earlier) ->
    // not fresh -> heartbeat wins. A magnitude comparison would have
    // wrongly treated this as fresh since clickToken > earlierServerToken.
    expect(deriveHostStatus(host, click)).toEqual({
      dot: "off",
      label: "offline",
      color: "var(--r)",
    });
  });
});
