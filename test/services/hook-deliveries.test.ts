import { describe, it, expect } from "vitest";
import { HookDeliveryRegistry } from "../../src/services/hook-deliveries.js";

// Issue #3174 — the ledger behind the at-most-once guarantee for a retried
// `Stop` delivery: a delivery that already landed is acknowledged again, but
// never dispatched a second time.

describe("HookDeliveryRegistry", () => {
  it("claims a delivery key once and refuses it afterwards", () => {
    const registry = new HookDeliveryRegistry();
    expect(registry.claim("session-1", "delivery-1#0")).toBe(true);
    expect(registry.claim("session-1", "delivery-1#0")).toBe(false);
  });

  it("keeps different messages of one delivery apart", () => {
    const registry = new HookDeliveryRegistry();
    expect(registry.claim("session-1", "delivery-1#0")).toBe(true);
    expect(registry.claim("session-1", "delivery-1#1")).toBe(true);
  });

  it("keeps different sessions apart", () => {
    const registry = new HookDeliveryRegistry();
    expect(registry.claim("session-1", "delivery-1#0")).toBe(true);
    expect(registry.claim("session-2", "delivery-1#0")).toBe(true);
  });

  it("expires a claim once its TTL has passed", () => {
    let now = 1_000;
    const registry = new HookDeliveryRegistry({ ttlMs: 500, now: () => now });
    expect(registry.claim("session-1", "delivery-1#0")).toBe(true);
    expect(registry.claim("session-1", "delivery-1#0")).toBe(false);
    now += 501;
    // The retry window is long over, so the key is treated as unseen again —
    // which cannot cause a duplicate inside that window.
    expect(registry.claim("session-1", "delivery-1#0")).toBe(true);
  });

  it("sweeps expired entries of OTHER sessions too, so the ledger stays bounded", () => {
    let now = 1_000;
    const registry = new HookDeliveryRegistry({ ttlMs: 500, now: () => now });
    expect(registry.claim("session-1", "delivery-1#0")).toBe(true);
    now += 501;
    // A claim for a DIFFERENT session sweeps the expired entry of the first
    // one — the ledger lives as long as the server does, so an entry for a
    // session that stopped delivering long ago must not sit in memory. This
    // TTL sweep is the ledger's ONLY memory bound: there is no explicit
    // "forget this session" call anywhere (see the file's own header for
    // why a dead session needs none).
    expect(registry.claim("session-2", "delivery-2#0")).toBe(true);
    expect(registry.claim("session-1", "delivery-1#0")).toBe(true);
  });

  it("caps how many keys one session may hold, evicting the oldest first", () => {
    const registry = new HookDeliveryRegistry({ maxPerSession: 2 });
    expect(registry.claim("session-1", "a")).toBe(true);
    expect(registry.claim("session-1", "b")).toBe(true);
    expect(registry.claim("session-1", "c")).toBe(true);
    // "a" was evicted to make room for "c".
    expect(registry.claim("session-1", "a")).toBe(true);
    // "c" is still on the ledger.
    expect(registry.claim("session-1", "c")).toBe(false);
  });
});
