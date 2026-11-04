// Issue #2597 — a sliding-window limiter that counts only FAILED attempts, for
// public endpoints where a success must never be throttled by junk traffic
// (@fastify/rate-limit counts every request). Per process and in memory: it
// bounds guessing, it is not a durable audit.

export interface FailureRateLimiter {
  /** True while `key` has used up its failure budget. Does not count. */
  isBlocked(key: string): boolean;
  recordFailure(key: string): void;
  /** Seconds until the oldest counted failure leaves the window (>= 1). */
  retryAfterSeconds(key: string): number;
}

const MAX_TRACKED_KEYS = 10_000;

export function createFailureRateLimiter(opts: {
  max: number;
  windowMs: number;
  now?: () => number;
}): FailureRateLimiter {
  const now = opts.now ?? Date.now;
  const failures = new Map<string, number[]>();

  const live = (key: string): number[] => {
    const cutoff = now() - opts.windowMs;
    const kept = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  };

  return {
    isBlocked: (key) => live(key).length >= opts.max,
    recordFailure(key) {
      if (failures.size >= MAX_TRACKED_KEYS && !failures.has(key)) {
        // Bound memory against a spray of distinct keys: drop what has expired,
        // and if that frees nothing, the oldest-inserted key.
        for (const k of [...failures.keys()]) live(k);
        if (failures.size >= MAX_TRACKED_KEYS) {
          const oldest = failures.keys().next().value;
          if (oldest !== undefined) failures.delete(oldest);
        }
      }
      const kept = live(key);
      kept.push(now());
      failures.set(key, kept);
    },
    retryAfterSeconds(key) {
      const kept = live(key);
      if (kept.length === 0) return 1;
      return Math.max(1, Math.ceil((kept[0]! + opts.windowMs - now()) / 1000));
    },
  };
}
