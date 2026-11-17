import { describe, it, expect } from "vitest";
import { mapAgyEvent } from "../../src/hooks/forwarder-core.mjs";

describe("Stop on a quota-exhausted turn, as agy really sends it (issue #3233)", () => {
  // Captured from `agy --print` on gemini-4-argon-medium with the quota
  // exhausted, 2026-11-17: the reason is upper case and the error carries the
  // reset as a relative duration.
  const CAPTURED_STOP = {
    continuationActive: false,
    error:
      "generating and executing: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 102h16m12s.",
    executionNum: 0,
    fullyIdle: true,
    hookEventName: "Stop",
    modelName: "gemini-4-argon-medium",
    terminationReason: "ERROR",
  };

  it("classifies it as a rate_limit stop_failure", () => {
    const result = mapAgyEvent("Stop", CAPTURED_STOP) ?? [];
    expect(result).toContainEqual(
      expect.objectContaining({
        kind: "stop_failure",
        errorType: "rate_limit",
        error: CAPTURED_STOP.error,
      }),
    );
  });

  it("does not turn a normal upper-case completion into a failure", () => {
    const result = (mapAgyEvent("Stop", { terminationReason: "COMPLETE", fullyIdle: true }) ??
      []) as Array<{ kind: string }>;
    expect(result.some((m) => m.kind === "stop_failure")).toBe(false);
  });
});
