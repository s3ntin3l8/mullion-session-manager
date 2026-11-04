import { describe, it, expect } from "vitest";
import { derivePairingStage } from "./hostPairing.js";

describe("derivePairingStage (issue #2449)", () => {
  const hosts = [
    { id: "up", health: "online" as const },
    { id: "down", health: "offline" as const },
    { id: "new", health: "pending" as const },
  ];
  it("keeps pending, expired and revoked as they are", () => {
    for (const state of ["pending", "expired", "revoked"] as const) {
      expect(derivePairingStage({ state, host_id: null }, hosts)).toBe(state);
    }
  });
  it("separates paired from connected on transport reachability", () => {
    expect(derivePairingStage({ state: "paired", host_id: "up" }, hosts)).toBe("connected");
    expect(derivePairingStage({ state: "paired", host_id: "down" }, hosts)).toBe("paired");
    expect(derivePairingStage({ state: "paired", host_id: "new" }, hosts)).toBe("paired");
    expect(derivePairingStage({ state: "paired", host_id: "gone" }, hosts)).toBe("paired");
  });
});
