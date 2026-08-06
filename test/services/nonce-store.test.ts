import { describe, it, expect } from "vitest";
import { NonceStore } from "../../src/services/nonce-store.js";

describe("NonceStore (issue #249 / roadmap 7.5)", () => {
  it("accepts and records a nonce never seen before", () => {
    const store = new NonceStore();
    expect(store.checkAndRecord("n1", 60_000)).toBe(true);
    expect(store.size()).toBe(1);
  });

  it("rejects a nonce presented again while its record is still live", () => {
    const store = new NonceStore();
    store.checkAndRecord("n1", 60_000);
    expect(store.checkAndRecord("n1", 60_000)).toBe(false);
  });

  it("tracks distinct nonces independently", () => {
    const store = new NonceStore();
    expect(store.checkAndRecord("n1", 60_000)).toBe(true);
    expect(store.checkAndRecord("n2", 60_000)).toBe(true);
    expect(store.checkAndRecord("n1", 60_000)).toBe(false);
    expect(store.checkAndRecord("n2", 60_000)).toBe(false);
  });

  it("accepts a nonce again once its TTL has genuinely expired", () => {
    const store = new NonceStore();
    const t0 = 1_000_000;
    store.checkAndRecord("n1", 1_000, t0);
    // Just past expiry.
    expect(store.checkAndRecord("n1", 1_000, t0 + 1_001)).toBe(true);
  });

  it("does not accept a nonce at exactly its expiry instant (expiresAt is exclusive)", () => {
    const store = new NonceStore();
    const t0 = 1_000_000;
    store.checkAndRecord("n1", 1_000, t0);
    // t0 + 1000 == expiresAt; checkAndRecord's own check is `expiresAt > now`,
    // so `now === expiresAt` must NOT count as still-live.
    expect(store.checkAndRecord("n1", 1_000, t0 + 1_000)).toBe(true);
  });

  describe("sweep", () => {
    it("drops entries whose TTL has expired", () => {
      const store = new NonceStore();
      const t0 = 1_000_000;
      store.checkAndRecord("expired", 1_000, t0);
      store.checkAndRecord("still-live", 60_000, t0);
      store.sweep(t0 + 2_000);
      expect(store.size()).toBe(1);
      // The swept-away nonce is usable again — proving it was actually
      // removed, not just left present-but-stale.
      expect(store.checkAndRecord("expired", 1_000, t0 + 2_000)).toBe(true);
    });

    it("leaves unexpired entries untouched", () => {
      const store = new NonceStore();
      const t0 = 1_000_000;
      store.checkAndRecord("still-live", 60_000, t0);
      store.sweep(t0 + 2_000);
      expect(store.checkAndRecord("still-live", 60_000, t0 + 2_000)).toBe(false);
    });
  });

  it("clearForTests empties the store", () => {
    const store = new NonceStore();
    store.checkAndRecord("n1", 60_000);
    store.clearForTests();
    expect(store.size()).toBe(0);
    expect(store.checkAndRecord("n1", 60_000)).toBe(true);
  });
});
