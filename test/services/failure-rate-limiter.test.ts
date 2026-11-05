import { describe, it, expect } from "vitest";
import { createFailureRateLimiter } from "../../src/services/failure-rate-limiter.js";

describe("failure rate limiter (issue #2597)", () => {
  it("blocks a key after max failures and frees it as they leave the window", () => {
    let t = 1_000_000;
    const limiter = createFailureRateLimiter({ max: 3, windowMs: 60_000, now: () => t });
    expect(limiter.isBlocked("a")).toBe(false);
    for (let i = 0; i < 3; i++) {
      limiter.recordFailure("a");
      t += 1000;
    }
    expect(limiter.isBlocked("a")).toBe(true);
    expect(limiter.isBlocked("b")).toBe(false);
    expect(limiter.retryAfterSeconds("a")).toBe(57);
    t += 58_000;
    expect(limiter.isBlocked("a")).toBe(false);
    expect(limiter.retryAfterSeconds("a")).toBe(1);
  });

  it("bounds the number of tracked keys", () => {
    const limiter = createFailureRateLimiter({ max: 1, windowMs: 60_000 });
    for (let i = 0; i < 10_005; i++) limiter.recordFailure(`k${i}`);
    expect(limiter.isBlocked("k10004")).toBe(true);
    expect(limiter.isBlocked("k0")).toBe(false);
  });
});
