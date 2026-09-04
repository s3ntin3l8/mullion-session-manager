import { describe, it, expect } from "vitest";
import {
  isRateLimitGraceActive,
  isTaskInRateLimitGrace,
} from "../../src/services/task-rate-limit-grace.js";

const now = Date.now();
const nowMinus = (ms: number) => new Date(now - ms);

describe("isRateLimitGraceActive", () => {
  it("returns true when errorState is api_error, errorDetail is rate_limit, and the durable lastRateLimitAt is within the grace window", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorDetail: "rate_limit" },
        { lastRateLimitAt: nowMinus(60_000) },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(true);
  });

  it("returns false when the durable lastRateLimitAt is older than the grace window", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorDetail: "rate_limit" },
        { lastRateLimitAt: nowMinus(10 * 60_000) },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });

  it("returns false when errorDetail is set to something other than rate_limit", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorDetail: "overloaded" },
        { lastRateLimitAt: nowMinus(60_000) },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });

  it("returns false when errorState is not api_error (TTL-cleared, recovered, or never set)", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "idle", errorDetail: null },
        { lastRateLimitAt: nowMinus(60_000) },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });

  it("returns false when the task has made commits past the base — let the normal success path run", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorDetail: "rate_limit" },
        { lastRateLimitAt: nowMinus(60_000) },
        { graceMinutes: 5, hasCommitsPastBase: true },
      ),
    ).toBe(false);
  });

  it("returns false when graceMinutes is 0 (operator opt-out)", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorDetail: "rate_limit" },
        { lastRateLimitAt: nowMinus(60_000) },
        { graceMinutes: 0, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });

  it("returns false when errorDetail is null — no classification means no rate_limit signal, fail fast", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorDetail: null },
        { lastRateLimitAt: nowMinus(60_000) },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });

  it("returns false when lastRateLimitAt is null — no record of any rate_limit, fail fast", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorDetail: "rate_limit" },
        { lastRateLimitAt: null },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });
});

describe("isTaskInRateLimitGrace", () => {
  it("returns true when lastRateLimitAt is within the grace window", () => {
    expect(isTaskInRateLimitGrace({ lastRateLimitAt: nowMinus(60_000) }, 5)).toBe(true);
  });

  it("returns false when lastRateLimitAt is older than the grace window", () => {
    expect(isTaskInRateLimitGrace({ lastRateLimitAt: nowMinus(10 * 60_000) }, 5)).toBe(false);
  });

  it("returns false when lastRateLimitAt is null", () => {
    expect(isTaskInRateLimitGrace({ lastRateLimitAt: null }, 5)).toBe(false);
  });

  it("returns false when graceMinutes is 0 (operator opt-out)", () => {
    expect(isTaskInRateLimitGrace({ lastRateLimitAt: nowMinus(60_000) }, 0)).toBe(false);
  });

  it("does NOT consult the session at all — only the durable task-level signal", () => {
    // This is the round-2 Hermes fix: the outer reconciler gate uses this
    // function to widen the `(finished || api_error)` branch to include
    // a third condition for TTL-cleared sessions whose durable
    // lastRateLimitAt is still recent. The signature has no `info`
    // parameter, by design.
    expect(isTaskInRateLimitGrace({ lastRateLimitAt: nowMinus(2 * 60_000) }, 60)).toBe(true);
  });
});
