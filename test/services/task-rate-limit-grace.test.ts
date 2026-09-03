import { describe, it, expect } from "vitest";
import { isRateLimitGraceActive } from "../../src/services/task-rate-limit-grace.js";

const now = Date.now();

describe("isRateLimitGraceActive", () => {
  it("returns true when errorState is api_error, errorDetail is rate_limit, and the error is within the grace window", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorAt: now - 60_000, errorDetail: "rate_limit" },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(true);
  });

  it("returns false when the error is older than the grace window", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorAt: now - 10 * 60_000, errorDetail: "rate_limit" },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });

  it("returns false when errorDetail is set to something other than rate_limit", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorAt: now - 60_000, errorDetail: "overloaded" },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });

  it("returns false when errorState is not api_error", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "idle", errorAt: null, errorDetail: null },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });

  it("returns false when the task has made commits past the base — let the normal success path run", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorAt: now - 60_000, errorDetail: "rate_limit" },
        { graceMinutes: 5, hasCommitsPastBase: true },
      ),
    ).toBe(false);
  });

  it("returns false when graceMinutes is 0 (operator opt-out)", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorAt: now - 60_000, errorDetail: "rate_limit" },
        { graceMinutes: 0, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });

  it("returns false when errorDetail is null — no classification means no rate_limit signal, fail fast", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorAt: now - 60_000, errorDetail: null },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });

  it("returns false when errorAt is null — can't compute grace without a timestamp", () => {
    expect(
      isRateLimitGraceActive(
        { errorState: "api_error", errorAt: null, errorDetail: "rate_limit" },
        { graceMinutes: 5, hasCommitsPastBase: false },
      ),
    ).toBe(false);
  });
});
