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

  it("issue #213: eventRetentionPerSession defaults to 0 (unlimited)", () => {
    expect(DEFAULT_SETTINGS.sessions.eventRetentionPerSession).toBe(0);
  });

  it("issue #213: clamps a negative eventRetentionPerSession to its default", () => {
    const dirty = mergeSettings({ sessions: { eventRetentionPerSession: -5 } });
    expect(dirty.sessions.eventRetentionPerSession).toBe(
      DEFAULT_SETTINGS.sessions.eventRetentionPerSession,
    );
  });

  it("issue #213: passes 0 (unlimited/no cap) through untouched, not as an out-of-range value", () => {
    const result = mergeSettings({ sessions: { eventRetentionPerSession: 0 } });
    expect(result.sessions.eventRetentionPerSession).toBe(0);
  });

  it("issue #213: passes an in-range eventRetentionPerSession through untouched", () => {
    const result = mergeSettings({ sessions: { eventRetentionPerSession: 500 } });
    expect(result.sessions.eventRetentionPerSession).toBe(500);
  });

  // Hermes review, PR #563 (round 4) — deliberately NOT the same behavior
  // as eventRetentionDays' own out-of-range-high test above: that field's
  // fallback (30) is still a bounded value, but this field's fallback (0)
  // IS "unlimited" — falling back on a too-high value here would silently
  // disable the cap instead of honoring the operator's clear "I want a
  // large cap" intent. Clamps to the bound instead (safeSentinelNumber,
  // same reasoning as maxConcurrent's own clamp-to-bound elsewhere in this
  // file).
  it("issue #213: clamps an out-of-range (>100_000) eventRetentionPerSession to 100_000, not to its default", () => {
    const dirty = mergeSettings({ sessions: { eventRetentionPerSession: 999_999_999 } });
    expect(dirty.sessions.eventRetentionPerSession).toBe(100_000);
  });

  it("issue #213: a fractional eventRetentionPerSession is NOT rounded/truncated by sanitizeSettings — sweepSessionEventCap truncates it instead", () => {
    // safeSentinelNumber validates range/finiteness but not integer-ness
    // (same gap safeNumber has) — this is intentionally documenting, not
    // asserting a fix belongs here. The actual defense is
    // sweepSessionEventCap's own Math.trunc (event-history.ts).
    const result = mergeSettings({ sessions: { eventRetentionPerSession: 2.9 } });
    expect(result.sessions.eventRetentionPerSession).toBe(2.9);
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

  // Task Master Settings UI follow-up — settings.taskMaster's four
  // overridable fields each use a same-typed sentinel (-1 / "inherit") to
  // mean "no override, fall through to the env default" (see
  // settings.ts's doc comment on the taskMaster field for the full
  // rationale). sanitizeSettings must repair a NaN/non-numeric value back
  // to the sentinel, must never let the sentinel collide with a legitimate
  // real value, and — per Hermes review, PR #480 — must CLAMP a merely
  // out-of-range-HIGH value to the nearest bound rather than discarding it
  // to the sentinel (silently reverting to a completely different
  // env-derived number is worse than honoring "I typed a big number" by
  // capping it). Only a genuinely dangerous LOW value (0-or-below for
  // maxConcurrent specifically — env.ts's own "0 caps 429s every claim
  // forever" reasoning) still repairs to the sentinel instead of clamping.
  describe("taskMaster", () => {
    it("a {taskMaster:{maxConcurrent:5}} patch survives deepMerge end to end (the failure mode that would ship a silently-no-op Settings UI)", () => {
      const result = mergeSettings({ taskMaster: { maxConcurrent: 5 } });
      expect(result.taskMaster.maxConcurrent).toBe(5);
    });

    it("passes the -1 inherit sentinel through untouched for every numeric field", () => {
      const result = mergeSettings({
        taskMaster: { maxConcurrent: -1, budgetMinutes: -1, progressCommentMinutes: -1 },
      });
      expect(result.taskMaster.maxConcurrent).toBe(-1);
      expect(result.taskMaster.budgetMinutes).toBe(-1);
      expect(result.taskMaster.progressCommentMinutes).toBe(-1);
    });

    it("repairs maxConcurrent's 0 (or any negative value) to the inherit sentinel — 0 has no 'unlimited' reading here (a 0 cap 429s every claim forever)", () => {
      expect(mergeSettings({ taskMaster: { maxConcurrent: 0 } }).taskMaster.maxConcurrent).toBe(-1);
      expect(mergeSettings({ taskMaster: { maxConcurrent: -5 } }).taskMaster.maxConcurrent).toBe(
        -1,
      );
    });

    it("clamps an out-of-range-HIGH maxConcurrent to its max, rather than discarding it to the inherit sentinel (Hermes review, PR #480)", () => {
      expect(mergeSettings({ taskMaster: { maxConcurrent: 999 } }).taskMaster.maxConcurrent).toBe(
        20,
      );
    });

    it("passes budgetMinutes' 0 through as a real 'unlimited' value, not the inherit sentinel", () => {
      const result = mergeSettings({ taskMaster: { budgetMinutes: 0 } });
      expect(result.taskMaster.budgetMinutes).toBe(0);
    });

    it("passes progressCommentMinutes' 0 through as a real 'no throttle' value, not the inherit sentinel", () => {
      const result = mergeSettings({ taskMaster: { progressCommentMinutes: 0 } });
      expect(result.taskMaster.progressCommentMinutes).toBe(0);
    });

    it("clamps an out-of-range budgetMinutes/progressCommentMinutes to the nearest bound — neither field has a dangerous floor to guard, unlike maxConcurrent", () => {
      const result = mergeSettings({
        taskMaster: { budgetMinutes: 999_999, progressCommentMinutes: -5 },
      });
      expect(result.taskMaster.budgetMinutes).toBe(10080);
      expect(result.taskMaster.progressCommentMinutes).toBe(0);
    });

    it("repairs a non-numeric or NaN taskMaster field to the inherit sentinel", () => {
      const dirty = { ...DEFAULT_SETTINGS, taskMaster: { ...DEFAULT_SETTINGS.taskMaster } };
      dirty.taskMaster.maxConcurrent = NaN;
      expect(sanitizeSettings(dirty).taskMaster.maxConcurrent).toBe(-1);
    });

    it("accepts on/off/inherit for enabled and repairs an unknown string to the default", () => {
      expect(mergeSettings({ taskMaster: { enabled: "on" } }).taskMaster.enabled).toBe("on");
      expect(mergeSettings({ taskMaster: { enabled: "off" } }).taskMaster.enabled).toBe("off");
      expect(mergeSettings({ taskMaster: { enabled: "inherit" } }).taskMaster.enabled).toBe(
        "inherit",
      );
      const dirty = { ...DEFAULT_SETTINGS, taskMaster: { ...DEFAULT_SETTINGS.taskMaster } };
      // Simulates a value that bypassed deepMerge's own type guard (which
      // only proves "a string", not "a known union member") — e.g. a
      // hand-crafted request body or a value from a future release rolled
      // back to this one.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately invalid union member
      (dirty.taskMaster as any).enabled = "bogus";
      expect(sanitizeSettings(dirty).taskMaster.enabled).toBe(DEFAULT_SETTINGS.taskMaster.enabled);
    });

    it("autoClaimPaused merges like any other boolean, with no sentinel involved", () => {
      const result = mergeSettings({ taskMaster: { autoClaimPaused: true } });
      expect(result.taskMaster.autoClaimPaused).toBe(true);
    });

    // #741 — the two Task Master agent defaults are plain strings with no
    // sentinel semantics (they have no env counterpart to inherit), so they
    // must survive deepMerge end to end like any other string leaf.
    it("defaultAgent/defaultReviewAgent merge like any other string, with no sentinel involved", () => {
      const result = mergeSettings({
        taskMaster: { defaultAgent: "codex", defaultReviewAgent: "agy" },
      });
      expect(result.taskMaster.defaultAgent).toBe("codex");
      expect(result.taskMaster.defaultReviewAgent).toBe("agy");
    });

    // skipPermissions (Task Master unattended-spawn fix) mirrors `enabled`'s
    // own "inherit"/"on"/"off" sentinel shape, not a numeric -1 — same
    // coverage pattern as the `enabled` tests above.
    it("accepts on/off/inherit for skipPermissions and repairs an unknown string to the default", () => {
      expect(
        mergeSettings({ taskMaster: { skipPermissions: "on" } }).taskMaster.skipPermissions,
      ).toBe("on");
      expect(
        mergeSettings({ taskMaster: { skipPermissions: "off" } }).taskMaster.skipPermissions,
      ).toBe("off");
      expect(
        mergeSettings({ taskMaster: { skipPermissions: "inherit" } }).taskMaster.skipPermissions,
      ).toBe("inherit");
      const dirty = { ...DEFAULT_SETTINGS, taskMaster: { ...DEFAULT_SETTINGS.taskMaster } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately invalid union member
      (dirty.taskMaster as any).skipPermissions = "bogus";
      expect(sanitizeSettings(dirty).taskMaster.skipPermissions).toBe(
        DEFAULT_SETTINGS.taskMaster.skipPermissions,
      );
    });
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

// agent-briefing follow-up to #405 — gates the SessionStart injection of a
// PROJECT's own briefing, independently of injectAgentGuide above (see
// DEFAULT_SETTINGS.sessions.injectProjectBriefing's own doc comment for why
// it's a separate key rather than reusing injectAgentGuide). Same
// default-true / mergeSettings / type-mismatch coverage shape as the block
// above, deliberately kept as its own describe rather than parameterized
// together — the two settings are independent and a shared test helper
// would obscure that.
describe("DEFAULT_SETTINGS.sessions.injectProjectBriefing (agent-briefing follow-up to #405)", () => {
  it("defaults to true", () => {
    expect(DEFAULT_SETTINGS.sessions.injectProjectBriefing).toBe(true);
  });

  it("can be overridden to false via mergeSettings", () => {
    const result = mergeSettings({ sessions: { injectProjectBriefing: false } });
    expect(result.sessions.injectProjectBriefing).toBe(false);
  });

  it("ignores a type-mismatched patch value instead of corrupting the field", () => {
    const result = mergeSettings({ sessions: { injectProjectBriefing: "nope" } });
    expect(result.sessions.injectProjectBriefing).toBe(true);
  });

  it("is independent of injectAgentGuide — overriding one leaves the other at its default", () => {
    const result = mergeSettings({ sessions: { injectAgentGuide: false } });
    expect(result.sessions.injectAgentGuide).toBe(false);
    expect(result.sessions.injectProjectBriefing).toBe(true);
  });
});

// Phase 5 (Track B, issue #193 5.3b) — hard cap on live children per parent
// enforced by createSessionRecord (services/session-lifecycle.ts), not just described
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
  // Issue #428 added "background", bringing this from 14 to 15.
  // "awaiting_question" was missing entirely until issue #95's push-delivery
  // work found it (no default meant no channel — browser, sound, or push —
  // could ever be enabled for it), bringing this to the full 16-member
  // SessionStatus union.
  it("has 16 entries — one per SessionStatus", () => {
    const matrix = DEFAULT_SETTINGS.notifications.notificationMatrix;
    expect(Object.keys(matrix)).toHaveLength(16);
  });

  it("notificationMatrix defaults have correct notify values matching STATUS_PRESENTATION.defaultNotify", () => {
    // STATUS_PRESENTATION is a frontend-only file, so we inline the expected
    // defaultNotify truth table here. Notify=true for statuses that should fire
    // by default: api_error, tool_failure, awaiting_permission, awaiting_plan,
    // awaiting_review_gate, awaiting_promote, awaiting_elicitation,
    // awaiting_question, needs_input. Notify=false for the rest.
    const shouldNotify = [
      "api_error",
      "tool_failure",
      "awaiting_permission",
      "awaiting_plan",
      "awaiting_review_gate",
      "awaiting_promote",
      "awaiting_elicitation",
      "awaiting_question",
      "needs_input",
    ];
    const shouldNotNotify = [
      "exited",
      "finished",
      "compacting",
      "subagent",
      "background",
      "working",
      "idle",
    ];

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

// Tablet tier plan (PR 4) — layoutMode mirrors taskMaster.enabled's own
// explicit-membership sanitization shape (see that describe block above);
// tabletPaneCap is a two-value discrete set rather than a numeric range, so
// it isn't a safeNumber candidate.
describe("DEFAULT_SETTINGS.layoutMode / tabletPaneCap (tablet tier)", () => {
  it("defaults to auto / 2", () => {
    expect(DEFAULT_SETTINGS.layoutMode).toBe("auto");
    expect(DEFAULT_SETTINGS.tabletPaneCap).toBe(2);
  });

  it("accepts auto/phone/tablet/desktop for layoutMode and repairs an unknown string to the default", () => {
    expect(mergeSettings({ layoutMode: "phone" }).layoutMode).toBe("phone");
    expect(mergeSettings({ layoutMode: "tablet" }).layoutMode).toBe("tablet");
    expect(mergeSettings({ layoutMode: "desktop" }).layoutMode).toBe("desktop");
    expect(mergeSettings({ layoutMode: "auto" }).layoutMode).toBe("auto");

    const dirty = { ...DEFAULT_SETTINGS };
    // Simulates a value that bypassed deepMerge's own type guard (which only
    // proves "a string", not "a known union member").
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately invalid union member
    (dirty as any).layoutMode = "bogus";
    expect(sanitizeSettings(dirty).layoutMode).toBe(DEFAULT_SETTINGS.layoutMode);
  });

  it("accepts 2 or 3 for tabletPaneCap and repairs any other value to 2", () => {
    expect(mergeSettings({ tabletPaneCap: 3 }).tabletPaneCap).toBe(3);
    expect(mergeSettings({ tabletPaneCap: 2 }).tabletPaneCap).toBe(2);

    const dirty = { ...DEFAULT_SETTINGS, tabletPaneCap: 4 } as typeof DEFAULT_SETTINGS;
    expect(sanitizeSettings(dirty).tabletPaneCap).toBe(2);

    const negative = { ...DEFAULT_SETTINGS, tabletPaneCap: -1 } as typeof DEFAULT_SETTINGS;
    expect(sanitizeSettings(negative).tabletPaneCap).toBe(2);
  });
});
