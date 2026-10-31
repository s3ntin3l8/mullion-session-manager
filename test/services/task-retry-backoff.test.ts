import { describe, it, expect } from "vitest";

import { createRetryBackoff } from "../../src/services/task-retry-backoff.js";

// The ledger behind every retry site in the Task Master reconciler (draft
// PR, merge, release, auto-approve). It owns three things the four sites
// each used to re-implement: the backoff curve, the attempt counter and the
// oldest-entry eviction. These tests pin that contract — in particular the
// parts the four copies had drifted on (the eviction living in two places,
// and the merge site's extra field riding along on the shared entry).

describe("createRetryBackoff", () => {
  describe("shouldAttempt", () => {
    it("allows an attempt for a key it has never seen", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      expect(backoff.shouldAttempt(1, 0)).toBe(true);
    });

    it("refuses an attempt inside the backoff window", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      backoff.record(1, 10_000);

      expect(backoff.shouldAttempt(1, 10_000)).toBe(false);
      expect(backoff.shouldAttempt(1, 10_999)).toBe(false);
    });

    it("allows the attempt once the window has elapsed", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      backoff.record(1, 10_000);

      // The FIRST wait is exactly the TTL — the attempt count is stored
      // post-increment, so the exponent is `attempts - 1` and the first
      // backoff is not twice the TTL.
      expect(backoff.shouldAttempt(1, 11_000)).toBe(true);
    });

    it("keeps each key's own window — one key's backoff never blocks another", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      backoff.record(1, 10_000);

      expect(backoff.shouldAttempt(2, 10_000)).toBe(true);
      expect(backoff.shouldAttempt(1, 10_000)).toBe(false);
    });
  });

  describe("the backoff curve", () => {
    it("doubles the wait per consecutive attempt and stops at the ceiling", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      backoff.record(1, 0);
      // 1 attempt → 1000ms
      expect(backoff.shouldAttempt(1, 999)).toBe(false);
      expect(backoff.shouldAttempt(1, 1000)).toBe(true);

      backoff.record(1, 1000);
      // 2 attempts → 2000ms
      expect(backoff.shouldAttempt(1, 2999)).toBe(false);
      expect(backoff.shouldAttempt(1, 3000)).toBe(true);

      backoff.record(1, 3000);
      // 3 attempts → 4000ms
      expect(backoff.shouldAttempt(1, 6999)).toBe(false);
      expect(backoff.shouldAttempt(1, 7000)).toBe(true);

      backoff.record(1, 7000);
      // 4 attempts → 8000ms, the ceiling
      expect(backoff.shouldAttempt(1, 14_999)).toBe(false);
      expect(backoff.shouldAttempt(1, 15_000)).toBe(true);

      backoff.record(1, 15_000);
      // 5 attempts → 16000ms, capped back to 8000ms
      expect(backoff.shouldAttempt(1, 22_999)).toBe(false);
      expect(backoff.shouldAttempt(1, 23_000)).toBe(true);
    });

    it("counts attempts post-increment, so the first wait is exactly the TTL", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      const entry = backoff.record(1, 0);

      expect(entry.attempts).toBe(1);
    });
  });

  describe("record", () => {
    it("increments the attempt count and stamps the time", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      backoff.record(1, 500);
      const entry = backoff.record(1, 2500);

      expect(entry.attempts).toBe(2);
      expect(entry.lastAttemptedAt).toBe(2500);
      expect(backoff.get(1)).toEqual({ lastAttemptedAt: 2500, attempts: 2 });
    });

    it("pins the attempt count when the caller asks for one", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      backoff.record(1, 0);
      // A permanent failure parks at the ceiling rather than climbing the
      // doubling ramp — the count is pinned, not incremented.
      const entry = backoff.record(1, 1000, { attempts: 64 });

      expect(entry.attempts).toBe(64);
      expect(backoff.get(1)?.attempts).toBe(64);
    });

    it("carries a site's own field across a record that does not mention it", () => {
      const backoff = createRetryBackoff<number, { lastReassertedSha?: string }>({
        ttlMs: 1000,
        maxTtlMs: 8000,
        maxEntries: 500,
      });

      backoff.record(1, 0, { extra: { lastReassertedSha: "abc123" } });
      // The merge sweep's own write records an attempt without touching the
      // memoized SHA — losing it here is what made the re-assert spin.
      const entry = backoff.record(1, 1000);

      expect(entry.lastReassertedSha).toBe("abc123");
      expect(entry.attempts).toBe(2);
    });

    it("overrides a site's own field when the caller supplies a new one", () => {
      const backoff = createRetryBackoff<number, { lastReassertedSha?: string }>({
        ttlMs: 1000,
        maxTtlMs: 8000,
        maxEntries: 500,
      });

      backoff.record(1, 0, { extra: { lastReassertedSha: "abc123" } });
      const entry = backoff.record(1, 1000, { extra: { lastReassertedSha: "def456" } });

      expect(entry.lastReassertedSha).toBe("def456");
    });

    it("keeps the timestamp and count a memoized write was given", () => {
      const backoff = createRetryBackoff<number, { lastReassertedSha?: string }>({
        ttlMs: 1000,
        maxTtlMs: 8000,
        maxEntries: 500,
      });

      backoff.record(1, 0);
      // The merge site's memoized write hands the ledger the timestamp and
      // the count it read, so neither of them moves — it memoizes a
      // re-assert, it does not start a new attempt.
      const entry = backoff.record(1, 0, {
        attempts: 1,
        extra: { lastReassertedSha: "abc123" },
      });

      expect(entry.lastAttemptedAt).toBe(0);
      expect(entry.attempts).toBe(1);
      expect(entry.lastReassertedSha).toBe("abc123");
    });

    it("returns undefined for a key it has never seen", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      expect(backoff.get(99)).toBeUndefined();
    });
  });

  describe("eviction", () => {
    it("evicts the oldest entry once the cap is reached", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 2 });

      backoff.record(1, 0);
      backoff.record(2, 0);
      // The third key pushes the ledger past its cap — the OLDEST entry is
      // the one that goes.
      backoff.record(3, 0);

      expect(backoff.get(1)).toBeUndefined();
      expect(backoff.get(2)).toBeDefined();
      expect(backoff.get(3)).toBeDefined();
    });

    it("never evicts an entry that is still being retried", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 2 });

      backoff.record(1, 0);
      backoff.record(2, 0);
      // Re-recording an existing key must not cost it its place — that would
      // silently reset the backoff of a task that is actively retrying.
      backoff.record(1, 1000);

      expect(backoff.get(1)?.attempts).toBe(2);
      expect(backoff.get(2)).toBeDefined();
    });

    it("holds the cap even when the write that fills it is a memoized one", () => {
      const backoff = createRetryBackoff<number, { lastReassertedSha?: string }>({
        ttlMs: 1000,
        maxTtlMs: 8000,
        maxEntries: 2,
      });

      backoff.record(1, 0);
      backoff.record(2, 0);
      backoff.record(3, 0, { extra: { lastReassertedSha: "abc123" } });

      expect(backoff.get(1)).toBeUndefined();
      expect(backoff.get(2)).toBeDefined();
      expect(backoff.get(3)?.lastReassertedSha).toBe("abc123");
    });
  });

  describe("reset and clear", () => {
    it("drops the entry, so the next attempt happens immediately", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      backoff.record(1, 10_000);
      expect(backoff.shouldAttempt(1, 10_000)).toBe(false);

      backoff.reset(1);

      expect(backoff.get(1)).toBeUndefined();
      expect(backoff.shouldAttempt(1, 10_000)).toBe(true);
    });

    it("clears the entry the same way reset does", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      backoff.record(1, 10_000);
      backoff.clear(1);

      expect(backoff.get(1)).toBeUndefined();
      expect(backoff.shouldAttempt(1, 10_000)).toBe(true);
    });

    it("leaves every other key alone", () => {
      const backoff = createRetryBackoff<number>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      backoff.record(1, 10_000);
      backoff.record(2, 10_000);
      backoff.reset(1);

      expect(backoff.get(2)?.attempts).toBe(1);
    });
  });

  describe("the key type", () => {
    it("is generic over the key, so a site can key by whatever it owns", () => {
      // The release sweep keys by PROJECT id; the other three key by task
      // id. Both are numbers, but the ledger does not care which, and a
      // string-keyed ledger works the same way.
      const byProject = createRetryBackoff<number>({
        ttlMs: 1000,
        maxTtlMs: 8000,
        maxEntries: 500,
      });
      const byName = createRetryBackoff<string>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      byProject.record(42, 0);
      byName.record("task-42", 0);

      expect(byProject.get(42)?.attempts).toBe(1);
      expect(byName.get("task-42")?.attempts).toBe(1);
    });

    it("keeps two ledgers over different key types independent", () => {
      const byProject = createRetryBackoff<number>({
        ttlMs: 1000,
        maxTtlMs: 8000,
        maxEntries: 500,
      });
      const byName = createRetryBackoff<string>({ ttlMs: 1000, maxTtlMs: 8000, maxEntries: 500 });

      byProject.record(42, 0);
      byName.record("task-42", 0);
      byName.record("task-42", 1000);

      expect(byProject.get(42)?.attempts).toBe(1);
      expect(byName.get("task-42")?.attempts).toBe(2);
    });
  });
});
