import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GateRegistry, type GateRegistryHost } from "../../src/services/gate-registry.js";

describe("GateRegistry", () => {
  let events: Array<[string, Record<string, unknown>]>;
  let attentionClears: number;
  let host: GateRegistryHost;
  let reg: GateRegistry;
  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    attentionClears = 0;
    host = {
      emitEvent: (kind, payload) => events.push([kind, payload]),
      clearReviewGateAttention: () => {
        attentionClears++;
      },
    };
    reg = new GateRegistry(host);
  });
  afterEach(() => vi.useRealTimers());

  it("starts idle", () => {
    expect([reg.state, reg.prompt, reg.at, reg.pendingIds()]).toEqual(["idle", null, null, []]);
  });

  it("the first gate sets the summary; later gates leave prompt/at on the OLDEST", () => {
    vi.setSystemTime(1000);
    reg.register("a", "first");
    vi.setSystemTime(2000);
    reg.register("b", "second");
    expect(reg.state).toBe("waiting");
    expect(reg.prompt).toBe("first");
    expect(reg.at).toBe(1000);
    expect(reg.pendingIds()).toEqual(["a", "b"]);
    expect(reg.entries()).toEqual([
      { gateId: "a", prompt: "first", at: 1000 },
      { gateId: "b", prompt: "second", at: 2000 },
    ]);
  });

  it("resolving one of several re-points the summary at the new oldest and leaves attention alone", () => {
    vi.setSystemTime(1000);
    reg.register("a", "first");
    vi.setSystemTime(2000);
    reg.register("b", "second");
    reg.resolve("a", "approved");
    expect(events).toEqual([["review_gate", { state: "approved", gateId: "a", prompt: "first" }]]);
    expect(reg.state).toBe("waiting");
    expect(reg.prompt).toBe("second");
    expect(reg.at).toBe(2000);
    expect(attentionClears).toBe(0);
  });

  it("resolving the last gate sets the terminal decision, nulls the summary and clears attention", () => {
    reg.register("a", "p");
    reg.resolve("a", "denied", "nope");
    expect(events[0]).toEqual([
      "review_gate",
      { state: "denied", gateId: "a", prompt: "p", reason: "nope" },
    ]);
    expect([reg.state, reg.prompt, reg.at]).toEqual(["denied", null, null]);
    expect(attentionClears).toBe(1);
  });

  it("an unknown or already-resolved gate id is a silent no-op", () => {
    reg.register("a", "p");
    reg.resolve("zzz", "approved");
    expect(events).toEqual([]);
    reg.resolve("a", "approved");
    events.length = 0;
    reg.resolve("a", "approved");
    expect(events).toEqual([]);
    expect(reg.state).toBe("approved");
  });

  it("clearStale resolves every pending gate as lapsed AND resets the summary to idle (#1528)", () => {
    reg.register("a", "p1");
    reg.register("b", "p2");
    reg.clearStale();
    expect(events.map(([, p]) => [p.gateId, p.state, p.reason])).toEqual([
      ["a", "lapsed", "stale gate cleared"],
      ["b", "lapsed", "stale gate cleared"],
    ]);
    expect([reg.state, reg.prompt, reg.at, reg.pendingIds()]).toEqual(["idle", null, null, []]);
    // the live map is empty, so a later gate is "first" again
    reg.register("c", "p3");
    expect(reg.prompt).toBe("p3");
  });

  it("resetSummary only touches the summary, not the live map", () => {
    reg.register("a", "p");
    reg.resetSummary();
    expect([reg.state, reg.prompt, reg.at]).toEqual(["idle", null, null]);
    expect(reg.pendingIds()).toEqual(["a"]);
  });

  it("lapseRestoredSummary marks the summary lapsed without emitting or touching attention", () => {
    reg.state = "waiting";
    reg.prompt = "stale";
    reg.at = 5;
    reg.lapseRestoredSummary();
    expect([reg.state, reg.prompt, reg.at]).toEqual(["lapsed", null, null]);
    expect(events).toEqual([]);
    expect(attentionClears).toBe(0);
  });
});
