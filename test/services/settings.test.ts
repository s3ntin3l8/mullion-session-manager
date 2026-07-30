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

  it("clamps an out-of-range staleBusySeconds to its default (issue #320 follow-up)", () => {
    const dirty = mergeSettings({ sessions: { staleBusySeconds: 0 } });
    expect(dirty.sessions.staleBusySeconds).toBe(DEFAULT_SETTINGS.sessions.staleBusySeconds);
  });

  it("passes an in-range staleBusySeconds through untouched", () => {
    const result = mergeSettings({ sessions: { staleBusySeconds: 3600 } });
    expect(result.sessions.staleBusySeconds).toBe(3600);
  });

  it("issue #213: eventPersistence defaults off and eventRetentionDays defaults to 30", () => {
    expect(DEFAULT_SETTINGS.sessions.eventPersistence).toBe(false);
    expect(DEFAULT_SETTINGS.sessions.eventRetentionDays).toBe(30);
  });

  it("issue #213: clamps a negative eventRetentionDays to its default", () => {
    const dirty = mergeSettings({ sessions: { eventRetentionDays: -5 } });
    expect(dirty.sessions.eventRetentionDays).toBe(DEFAULT_SETTINGS.sessions.eventRetentionDays);
  });

  it("issue #213: passes 0 (unlimited/no sweep) through untouched, not as an out-of-range value", () => {
    const result = mergeSettings({ sessions: { eventRetentionDays: 0 } });
    expect(result.sessions.eventRetentionDays).toBe(0);
  });

  it("issue #213: passes an in-range eventRetentionDays through untouched", () => {
    const result = mergeSettings({ sessions: { eventRetentionDays: 90 } });
    expect(result.sessions.eventRetentionDays).toBe(90);
  });

  it("issue #213: clamps an out-of-range (>3650) eventRetentionDays to its default", () => {
    const dirty = mergeSettings({ sessions: { eventRetentionDays: 999_999 } });
    expect(dirty.sessions.eventRetentionDays).toBe(DEFAULT_SETTINGS.sessions.eventRetentionDays);
  });

  it("issue #213: eventPersistence toggles via deepMerge like any other boolean setting", () => {
    const result = mergeSettings({ sessions: { eventPersistence: true } });
    expect(result.sessions.eventPersistence).toBe(true);
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

// Issue #405 — gates the SessionStart auto-inject pointer to the per-session
// agent guide copy (src/plugins/hooks.ts); default true (see
// DEFAULT_SETTINGS.sessions.injectAgentGuide's own doc comment for the
// "cheap and the point is discovery" rationale).
describe("DEFAULT_SETTINGS.sessions.injectAgentGuide (issue #405)", () => {
  it("defaults to true", () => {
    expect(DEFAULT_SETTINGS.sessions.injectAgentGuide).toBe(true);
  });

  it("can be overridden to false via mergeSettings", () => {
    const result = mergeSettings({ sessions: { injectAgentGuide: false } });
    expect(result.sessions.injectAgentGuide).toBe(false);
  });

  it("ignores a type-mismatched patch value instead of corrupting the field", () => {
    const result = mergeSettings({ sessions: { injectAgentGuide: "nope" } });
    expect(result.sessions.injectAgentGuide).toBe(true);
  });
});

// Phase 5 (Track B, issue #193 5.3b) — hard cap on live children per parent
// enforced by createSessionRecord (routes/sessions.ts), not just described
// here; this is the sanitizeSettings clamp half of that guardrail.
describe("DEFAULT_SETTINGS.sessions.maxChildSessionsPerParent", () => {
  it("defaults to 5", () => {
    expect(DEFAULT_SETTINGS.sessions.maxChildSessionsPerParent).toBe(5);
  });

  it("can be overridden via mergeSettings", () => {
    const result = mergeSettings({ sessions: { maxChildSessionsPerParent: 10 } });
    expect(result.sessions.maxChildSessionsPerParent).toBe(10);
  });

  it("floors a 0 (or negative) value to its default — a cap of 0 would silently disable spawn_child entirely, not intentionally block it", () => {
    const dirty = mergeSettings({ sessions: { maxChildSessionsPerParent: 0 } });
    expect(dirty.sessions.maxChildSessionsPerParent).toBe(
      DEFAULT_SETTINGS.sessions.maxChildSessionsPerParent,
    );
  });

  it("clamps an out-of-range (>50) value to its default", () => {
    const dirty = mergeSettings({ sessions: { maxChildSessionsPerParent: 999 } });
    expect(dirty.sessions.maxChildSessionsPerParent).toBe(
      DEFAULT_SETTINGS.sessions.maxChildSessionsPerParent,
    );
  });
});

// Phase 5 (Track B, issue #194 5.4) — gates ONLY whether a spawned child's
// dockview panel auto-opens (App.tsx); the child itself always shows in the
// sidebar regardless. Default false since this is the codebase's first
// backend-state-driven panel add.
describe("DEFAULT_SETTINGS.sessions.autoOpenChildPanels", () => {
  it("defaults to false", () => {
    expect(DEFAULT_SETTINGS.sessions.autoOpenChildPanels).toBe(false);
  });

  it("can be overridden to true via mergeSettings", () => {
    const result = mergeSettings({ sessions: { autoOpenChildPanels: true } });
    expect(result.sessions.autoOpenChildPanels).toBe(true);
  });

  it("ignores a type-mismatched patch value instead of corrupting the field", () => {
    const result = mergeSettings({ sessions: { autoOpenChildPanels: "yes" } });
    expect(result.sessions.autoOpenChildPanels).toBe(false);
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
