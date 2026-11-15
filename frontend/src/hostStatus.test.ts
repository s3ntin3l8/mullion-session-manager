import { describe, it, expect } from "vitest";
import { CHANNEL_SATURATED_REASON } from "../../src/shared/constants.js";
import {
  deriveHostStatus,
  legacyAgentFix,
  legacyAgentLabels,
  legacyAgentTitle,
  type PingState,
} from "./hostStatus.js";
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
    expect(display).toEqual({ dot: "warn", label: "missed a ping", color: "var(--y)" });
  });

  it("carries the explanation for a saturated channel with its label (#2702)", () => {
    const host = makeHost({
      health: "degraded",
      healthReason: CHANNEL_SATURATED_REASON,
      lastCheckedAt: "2026-01-01T00:00:10.000Z",
    });
    const display = deriveHostStatus(host, { status: "unknown", lastCheckedAtSnapshot: null });
    expect(display.label).toBe(CHANNEL_SATURATED_REASON);
    expect(display.title).toMatch(/every request slot has been busy/);
  });

  it("shows a hollow 'unreachable' for an offline heartbeat status", () => {
    // Issue #1727 — the backend cannot tell a sleeping host from an
    // unreachable one, so the UI says what is knowable ("unreachable") and
    // does not dress it as a failure ("offline", in red).
    const host = makeHost({ health: "offline", lastCheckedAt: "2026-01-01T00:00:10.000Z" });
    const display = deriveHostStatus(host, NO_CLICK);
    expect(display).toEqual({ dot: "off", label: "unreachable", color: "var(--dim)" });
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
      label: "unreachable",
      color: "var(--dim)",
    });
  });

  it("falls back to the click's own result for a still-pending host (poller hasn't swept yet)", () => {
    const host = makeHost({ health: "pending", lastCheckedAt: null });
    const click: PingState = { status: "offline", lastCheckedAtSnapshot: null };
    // The CLICK's own verdict keeps the old wording and the red — the user
    // just tested this host by hand and it did not answer. Issue #1727's
    // wording change is about the heartbeat's "we could not reach it", not
    // about an explicit, freshly-observed failure.
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
      label: "unreachable",
      color: "var(--dim)",
    });
  });

  // Issue #2969 — an unreachable host with a legacy agent is the one case the
  // primary can name the cause of.
  it("explains an unreachable legacy agent on hover, and leaves other unreachable hosts untitled", () => {
    const legacy = deriveHostStatus(
      makeHost({
        health: "offline",
        legacyAgent: true,
        baseUrl: "http://192.168.2.92:3000",
        mullionVersion: "0.3.50",
      }),
      { status: "unknown", lastCheckedAtSnapshot: null },
    );
    expect(legacy.label).toBe("unreachable");
    expect(legacy.title).toMatch(/v0\.3\.50/);
    expect(legacy.title).toMatch(/192\.168\.2\.92:3000/);
    expect(legacy.title).toMatch(/Upgrade the agent/);

    const plain = deriveHostStatus(makeHost({ health: "offline" }), {
      status: "unknown",
      lastCheckedAtSnapshot: null,
    });
    expect(plain.title).toBeUndefined();
  });

  it("tells a current-version legacy agent to register, not to upgrade", () => {
    const status = deriveHostStatus(
      makeHost({ health: "offline", legacyAgent: true, mullionVersion: "0.3.62" }),
      { status: "unknown", lastCheckedAtSnapshot: null },
    );
    expect(status.title).toMatch(/MULLION_PRIMARY_URL/);
    expect(status.title).not.toMatch(/Upgrade the agent/);
    for (const v of ["0.3.59", "0.4.0", "1.0.0"]) {
      expect(legacyAgentTitle(makeHost({ legacyAgent: true, mullionVersion: v }))).toMatch(
        /MULLION_PRIMARY_URL/,
      );
    }
    for (const v of ["0.3.58", "0.2.99", null]) {
      expect(legacyAgentTitle(makeHost({ legacyAgent: true, mullionVersion: v }))).toMatch(
        /Upgrade the agent/,
      );
    }
  });

  it("treats a pre-release of the channel floor as older, and a pre-release above it as current", () => {
    for (const v of ["0.3.59-rc.1", "0.3.59.dev", "0.3.58", "garbage", ""]) {
      expect(legacyAgentFix(makeHost({ mullionVersion: v }))).toBe("upgrade");
    }
    for (const v of ["0.3.59", "0.3.60-rc.1", "0.4.0"]) {
      expect(legacyAgentFix(makeHost({ mullionVersion: v }))).toBe("register");
    }
  });

  it("words the visible label from the same decision as the hover", () => {
    const old = makeHost({ legacyAgent: true, mullionVersion: "0.3.50" });
    const current = makeHost({ legacyAgent: true, mullionVersion: "0.3.62" });
    expect(legacyAgentLabels(old)).toEqual({
      short: "outdated agent",
      long: "Outdated agent — upgrade",
    });
    expect(legacyAgentLabels(current).long).toBe("Not registered — set primary URL");
    expect(legacyAgentTitle(old)).toMatch(/Upgrade the agent/);
    expect(legacyAgentTitle(current)).toMatch(/MULLION_PRIMARY_URL/);
  });
});
