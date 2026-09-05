import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/app.js";

// Hermes review on PR #1071 — close the Codecov gap on bridge-cleanup.ts by
// exercising the same real timer wiring host-heartbeat.test.ts does for its
// own plugin. Three lines were uncovered:
//   - line 18: the MULLION_ROLE !== "primary" short-circuit
//   - line 27: the catch branch that swallows cleanupExpiredPairingCodes errors
//   - line 34: the onClose clearInterval guard
//
// All three are observable purely through setInterval call counts + whether
// the callback runs again after a thrown error. The bridge-cleanup timer's
// callback is uniquely identified by `toString()` matching
// "cleanupExpiredPairingCodes" — git-fetcher.ts uses the same 5-minute cadence
// (gitAutoFetchIntervalSeconds default = 300s), so a naive `ms === 300000`
// filter would conflate the two; the callback's source text is the actual
// discriminator.

function isBridgeCleanupInterval(call: readonly unknown[]): boolean {
  const fn = call[0];
  return typeof fn === "function" && fn.toString().includes("cleanupExpiredPairingCodes");
}

describe("bridgeCleanupPlugin (PR #1071 review — Hermes)", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;
  let cleanupSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    cleanupSpy = vi.spyOn(
      await import("../../src/services/bridge-registry.js"),
      "cleanupExpiredPairingCodes",
    );
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    cleanupSpy.mockRestore();
    // Defensive: no test in this file currently toggles these, but clear
    // them anyway so a future addition (or a sibling test in the same
    // worker that forgets to restore) doesn't leak across files — same
    // posture as test/plugins/host-heartbeat.test.ts:37-39.
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
  });

  it("does not register a sweep timer on the agent role (the MULLION_ROLE short-circuit)", async () => {
    // app.ts's role branch only registers bridgeCleanupPlugin on primary,
    // so we exercise the plugin's own `if (MULLION_ROLE !== "primary")`
    // guard directly — same shape host-heartbeat.ts:8 uses, which the
    // review is calling out for parity. A mock Fastify instance with the
    // minimum surface the plugin touches (config + addHook) is enough.
    const { bridgeCleanupPlugin } = await import("../../src/plugins/bridge-cleanup.js");
    const hooks: Array<{ event: string; cb: () => void }> = [];
    const mockApp = {
      config: { MULLION_ROLE: "agent" },
      addHook: (event: string, cb: () => void) => {
        hooks.push({ event, cb });
      },
    };

    await bridgeCleanupPlugin(mockApp as never);

    // The short-circuit returns before any addHook calls, so neither
    // onReady nor onClose should have been registered at all.
    expect(hooks).toHaveLength(0);

    // And of course no setInterval was called for this app.
    const bridgeIntervals = setIntervalSpy.mock.calls.filter(isBridgeCleanupInterval);
    expect(bridgeIntervals).toHaveLength(0);
  });

  it("keeps the periodic sweep alive when cleanupExpiredPairingCodes throws (the catch branch)", async () => {
    cleanupSpy.mockImplementation(() => {
      throw new Error("synthetic cleanup failure");
    });

    const app = await buildApp();
    await app.inject({ method: "GET", url: "/health" });

    const bridgeIntervals = setIntervalSpy.mock.calls.filter(isBridgeCleanupInterval);
    expect(bridgeIntervals).toHaveLength(1);
    const [callback] = bridgeIntervals[0]!;

    // First tick throws — the catch must absorb it, not let it kill the
    // interval. We invoke the callback directly here (rather than advancing
    // fake timers across a 5-minute interval) to keep this test fast and
    // independent of Fastify's own onReady sequencing.
    expect(() => (callback as () => void)()).not.toThrow();

    // Pin the regression: a thrown error out of a setInterval callback
    // would otherwise propagate as an UnhandledException on Node's timer
    // phase and could (depending on Node version) tear the interval down.
    // We can't easily inspect "is the interval still live after the throw"
    // from outside the plugin, but the callback's *body* — try/catch around
    // cleanupExpiredPairingCodes — IS the contract being tested. Re-running
    // it through the same mock just confirms the catch branch is still
    // doing the work, not that Node would have killed the interval anyway.
    expect(() => (callback as () => void)()).not.toThrow();
    expect(cleanupSpy).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("clears the sweep timer on app close (the onClose guard)", async () => {
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/health" });

    const bridgeIntervals = setIntervalSpy.mock.calls.filter(isBridgeCleanupInterval);
    expect(bridgeIntervals).toHaveLength(1);

    // The plugin captures `timer = setInterval(...)` in an onReady closure;
    // its onClose guard is `if (timer) clearInterval(timer)`. The guard's
    // observable contract is that the exact handle returned from setInterval
    // is the one passed to clearInterval — if the plugin ever lost its
    // closure reference (or captured `timer` from a different scope), it
    // would call clearInterval on a stale/wrong handle and leave the live
    // timer firing. Asserting on reference equality here pins that down,
    // complementing host-heartbeat.test.ts's tracker-state assertions with
    // a direct timer-handle identity check.
    const bridgeIdx = setIntervalSpy.mock.calls.indexOf(bridgeIntervals[0]!);
    const bridgeHandle = setIntervalSpy.mock.results[bridgeIdx]?.value;
    expect(bridgeHandle).toBeDefined();

    await app.close();

    // onClose fires clearInterval at least once, and one of those calls
    // is our bridge handle. Other plugins (browser, pty reconciler, git
    // fetcher, request-nonce, preview-proxy, ...) each clear their own
    // timers too — we don't assert on the absolute count, just on
    // presence of our specific handle. A `clearedHandles` count of 0 here
    // would mean clearInterval wasn't called at all; a count without our
    // handle would mean the plugin's `if (timer)` guard bypassed it
    // somehow.
    const clearedHandles = clearIntervalSpy.mock.calls.map((call) => call[0]);
    expect(clearedHandles).toContain(bridgeHandle);
  });
});
