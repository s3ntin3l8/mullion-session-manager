import { describe, it, expect } from "vitest";
import {
  deepMerge,
  sanitizeSettings,
  mergeSettings,
  DEFAULT_SETTINGS,
} from "../../src/services/settings.js";

describe("deepMerge", () => {
  it("never writes a property name sourced from the patch, so __proto__ can't pollute", () => {
    // JSON.parse builds "__proto__" as an ordinary own-enumerable key
    // (it bypasses the accessor), so a PATCH body reaching deepMerge is an
    // attacker-controlled source — this is the shape a prototype-pollution
    // payload takes. deepMerge only ever writes keys drawn from `base`, so
    // "__proto__" (absent from base) is never touched.
    const patch = JSON.parse('{"__proto__":{"polluted":"yes"},"theme":"light"}') as unknown;

    const result = deepMerge({ theme: "dark" }, patch) as Record<string, unknown>;

    expect(result.theme).toBe("light");
    expect(Object.prototype as Record<string, unknown>).not.toHaveProperty("polluted");
  });

  it("silently drops patch keys that aren't part of base's known shape", () => {
    const base = { theme: "dark" };
    const result = deepMerge(base, { theme: "light", bogusUnknownField: "x" });
    expect(result).toEqual({ theme: "light" });
  });

  it("merges nested plain objects while leaving unrelated sibling keys untouched", () => {
    const base = { a: { x: 1, y: 2 }, b: "unchanged" };
    const result = deepMerge(base, { a: { x: 9 } });
    expect(result).toEqual({ a: { x: 9, y: 2 }, b: "unchanged" });
  });

  it("replaces arrays outright rather than merging element-wise", () => {
    const base = { list: [1, 2, 3] };
    const result = deepMerge(base, { list: [] });
    expect(result.list).toEqual([]);
  });

  it("ignores a type-mismatched leaf value instead of persisting it", () => {
    // A string where the base has a number (e.g. Settings.tsx's fontSize
    // slider paired with a hand-crafted PATCH body) must not corrupt the
    // field — getStoredSettings re-merges the same stored blob over
    // DEFAULT_SETTINGS on every read, so a wrong-typed value, once written,
    // would otherwise never self-heal.
    const base = { fontSize: 14 };
    const result = deepMerge(base, { fontSize: "huge" });
    expect(result.fontSize).toBe(14);
  });

  it("ignores a wrong-shape subtree instead of collapsing it to a scalar", () => {
    const base = { terminal: { fontSize: 14 } };
    const result = deepMerge(base, { terminal: 5 });
    expect(result).toEqual({ terminal: { fontSize: 14 } });
  });

  it("ignores a null patch value for a field that is never null", () => {
    const base = { terminal: { fontSize: 14 } };
    const result = deepMerge(base, { terminal: null });
    expect(result).toEqual({ terminal: { fontSize: 14 } });
  });
});

describe("sanitizeSettings", () => {
  it("clamps out-of-range and non-finite numeric fields to their defaults", () => {
    const dirty = mergeSettings({
      terminal: { fontSize: 999, padding: -1, scrollback: -1, reconnect: { maxAttempts: 0 } },
      notifications: { idleThresholdSeconds: 0 },
      sessions: { reconcileIntervalSeconds: 0 },
    });

    expect(dirty.terminal.fontSize).toBe(DEFAULT_SETTINGS.terminal.fontSize);
    expect(dirty.terminal.padding).toBe(DEFAULT_SETTINGS.terminal.padding);
    expect(dirty.terminal.scrollback).toBe(DEFAULT_SETTINGS.terminal.scrollback);
    expect(dirty.terminal.reconnect.maxAttempts).toBe(
      DEFAULT_SETTINGS.terminal.reconnect.maxAttempts,
    );
    expect(dirty.notifications.idleThresholdSeconds).toBe(
      DEFAULT_SETTINGS.notifications.idleThresholdSeconds,
    );
    expect(dirty.sessions.reconcileIntervalSeconds).toBe(
      DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds,
    );
  });

  it("passes in-range numeric fields through untouched", () => {
    const result = mergeSettings({
      terminal: { fontSize: 18, padding: 8 },
      sessions: { reconcileIntervalSeconds: 120 },
    });
    expect(result.terminal.fontSize).toBe(18);
    expect(result.terminal.padding).toBe(8);
    expect(result.sessions.reconcileIntervalSeconds).toBe(120);
  });

  it("clamps an out-of-range staleErrorSeconds to its default (fix: transient status clearing)", () => {
    const dirty = mergeSettings({ sessions: { staleErrorSeconds: 0 } });
    expect(dirty.sessions.staleErrorSeconds).toBe(DEFAULT_SETTINGS.sessions.staleErrorSeconds);
  });

  it("passes an in-range staleErrorSeconds through untouched", () => {
    const result = mergeSettings({ sessions: { staleErrorSeconds: 300 } });
    expect(result.sessions.staleErrorSeconds).toBe(300);
  });

  it("directly rejects a non-finite value passed straight to sanitizeSettings", () => {
    const dirty = { ...DEFAULT_SETTINGS, sessions: { ...DEFAULT_SETTINGS.sessions } };
    // Simulates a value that bypassed deepMerge's type guard entirely.
    dirty.sessions.reconcileIntervalSeconds = NaN;
    const result = sanitizeSettings(dirty);
    expect(result.sessions.reconcileIntervalSeconds).toBe(
      DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds,
    );
  });
});

describe("DEFAULT_SETTINGS.notifications.notificationMatrix", () => {
  it("has 14 entries — one per SessionStatus", () => {
    const matrix = DEFAULT_SETTINGS.notifications.notificationMatrix;
    expect(Object.keys(matrix)).toHaveLength(14);
  });

  it("notificationMatrix defaults have correct notify values matching STATUS_PRESENTATION.defaultNotify", () => {
    // STATUS_PRESENTATION is a frontend-only file, so we inline the expected
    // defaultNotify truth table here. Notify=true for statuses that should fire
    // by default: api_error, tool_failure, awaiting_permission, awaiting_plan,
    // awaiting_review_gate, awaiting_promote, awaiting_elicitation, needs_input.
    // Notify=false for the rest.
    const shouldNotify = [
      "api_error",
      "tool_failure",
      "awaiting_permission",
      "awaiting_plan",
      "awaiting_review_gate",
      "awaiting_promote",
      "awaiting_elicitation",
      "needs_input",
    ];
    const shouldNotNotify = ["exited", "finished", "compacting", "subagent", "working", "idle"];

    const matrix = DEFAULT_SETTINGS.notifications.notificationMatrix;
    for (const status of shouldNotify) {
      expect(matrix[status]?.notify).toBe(true);
    }
    for (const status of shouldNotNotify) {
      expect(matrix[status]?.notify).toBe(false);
    }
  });

  it("all entries start with sound=false and autoFocus=false", () => {
    const matrix = DEFAULT_SETTINGS.notifications.notificationMatrix;
    for (const entry of Object.values(matrix)) {
      expect(entry.sound).toBe(false);
      expect(entry.autoFocus).toBe(false);
    }
  });
});
