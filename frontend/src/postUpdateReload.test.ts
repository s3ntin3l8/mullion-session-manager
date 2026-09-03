import { describe, it, expect, beforeEach } from "vitest";
import { claimPostUpdateReload, __resetPostUpdateReloadForTests } from "./postUpdateReload.js";

// Issue #1008 — main.tsx's registerSW() onNeedReload and
// ServerInfoSection.tsx's update-status-poll setTimeout both route through
// claimPostUpdateReload() before calling window.location.reload(). This
// tests the shared gate directly rather than either call site: the gate is
// the actual fix, and it's the only part that can be tested deterministically
// without standing up a real service worker or a real page reload.
describe("claimPostUpdateReload", () => {
  beforeEach(() => {
    __resetPostUpdateReloadForTests();
  });

  it("returns true the first time it's called", () => {
    expect(claimPostUpdateReload()).toBe(true);
  });

  it("returns false on every call after the first — simulating both triggers firing in the same tick", () => {
    // First trigger (e.g. the service-worker onNeedReload) wins the claim
    // and proceeds to reload.
    expect(claimPostUpdateReload()).toBe(true);
    // Second trigger (e.g. ServerInfoSection's setTimeout, landing a moment
    // later) must NOT also reload — this is the double-reload issue #1008
    // fixes.
    expect(claimPostUpdateReload()).toBe(false);
    expect(claimPostUpdateReload()).toBe(false);
  });

  it("a fresh reset allows a new claim (models a real subsequent page load)", () => {
    expect(claimPostUpdateReload()).toBe(true);
    expect(claimPostUpdateReload()).toBe(false);

    __resetPostUpdateReloadForTests();

    expect(claimPostUpdateReload()).toBe(true);
  });
});
