import { describe, it, expect } from "vitest";
import { resolveTaskMaster } from "../../src/services/task-config.js";
import { DEFAULT_SETTINGS } from "../../src/services/settings.js";

const ENV_DEFAULTS = {
  enabled: false,
  maxConcurrent: 2,
  budgetMinutes: 120,
  progressCommentMinutes: 15,
  skipPermissions: false,
};

describe("resolveTaskMaster", () => {
  it("falls through to every env default when every field is at its inherit sentinel", () => {
    const resolved = resolveTaskMaster(DEFAULT_SETTINGS.taskMaster, ENV_DEFAULTS);
    expect(resolved).toEqual({
      enabled: false,
      autoClaimPaused: false,
      maxConcurrent: 2,
      budgetMinutes: 120,
      progressCommentMinutes: 15,
      skipPermissions: false,
      reviewCiWaitMinutes: 15,
    });
  });

  it("resolves enabled: on/off as a real override regardless of the env default", () => {
    expect(
      resolveTaskMaster(
        { ...DEFAULT_SETTINGS.taskMaster, enabled: "on" },
        { ...ENV_DEFAULTS, enabled: false },
      ).enabled,
    ).toBe(true);
    expect(
      resolveTaskMaster(
        { ...DEFAULT_SETTINGS.taskMaster, enabled: "off" },
        { ...ENV_DEFAULTS, enabled: true },
      ).enabled,
    ).toBe(false);
  });

  it("resolves a concrete maxConcurrent as a real override", () => {
    const resolved = resolveTaskMaster(
      { ...DEFAULT_SETTINGS.taskMaster, maxConcurrent: 5 },
      ENV_DEFAULTS,
    );
    expect(resolved.maxConcurrent).toBe(5);
  });

  // The case most likely to be got wrong: 0 is a legitimate, meaningful
  // value for budgetMinutes ("unlimited") and progressCommentMinutes ("no
  // throttle") — it must resolve as a real override, not be mistaken for
  // "unset" the way the -1 sentinel is. This is the opposite failure mode
  // from settings.ts's own clamp tests, which check that maxConcurrent's 0
  // is REJECTED (see test/services/settings.test.ts) — here, budget/
  // throttle's 0 must be ACCEPTED.
  it("resolves an explicit 0 for budgetMinutes/progressCommentMinutes as a real override, not inherit", () => {
    const resolved = resolveTaskMaster(
      { ...DEFAULT_SETTINGS.taskMaster, budgetMinutes: 0, progressCommentMinutes: 0 },
      ENV_DEFAULTS,
    );
    expect(resolved.budgetMinutes).toBe(0);
    expect(resolved.progressCommentMinutes).toBe(0);
  });

  it("passes autoClaimPaused through unconditionally — it has no sentinel/inherit concept", () => {
    expect(
      resolveTaskMaster({ ...DEFAULT_SETTINGS.taskMaster, autoClaimPaused: true }, ENV_DEFAULTS)
        .autoClaimPaused,
    ).toBe(true);
  });

  it("passes reviewCiWaitMinutes through unconditionally — no sentinel, no env counterpart", () => {
    expect(
      resolveTaskMaster({ ...DEFAULT_SETTINGS.taskMaster, reviewCiWaitMinutes: 0 }, ENV_DEFAULTS)
        .reviewCiWaitMinutes,
    ).toBe(0);
  });

  // skipPermissions (Task Master unattended-spawn fix) mirrors `enabled`'s
  // own "inherit"/"on"/"off" sentinel shape exactly, not a numeric -1 —
  // same coverage pattern as the `enabled` test above.
  it("resolves skipPermissions: on/off as a real override regardless of the env default", () => {
    expect(
      resolveTaskMaster(
        { ...DEFAULT_SETTINGS.taskMaster, skipPermissions: "on" },
        { ...ENV_DEFAULTS, skipPermissions: false },
      ).skipPermissions,
    ).toBe(true);
    expect(
      resolveTaskMaster(
        { ...DEFAULT_SETTINGS.taskMaster, skipPermissions: "off" },
        { ...ENV_DEFAULTS, skipPermissions: true },
      ).skipPermissions,
    ).toBe(false);
  });

  it("resolves skipPermissions: inherit to the env default", () => {
    expect(
      resolveTaskMaster(
        { ...DEFAULT_SETTINGS.taskMaster, skipPermissions: "inherit" },
        { ...ENV_DEFAULTS, skipPermissions: true },
      ).skipPermissions,
    ).toBe(true);
  });
});
