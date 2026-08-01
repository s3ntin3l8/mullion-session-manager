import { describe, it, expect } from "vitest";
import { resolveTaskMaster } from "./taskConfig.js";
import { DEFAULT_SETTINGS } from "./api.js";

// Mirrors test/services/task-config.test.ts on the backend — same
// algorithm, same assertions, kept in sync deliberately (see taskConfig.ts's
// own doc comment on why this is a DOM-free duplicate of the backend
// resolver rather than a shared package).
const ENV_DEFAULTS = {
  enabled: false,
  maxConcurrent: 2,
  budgetMinutes: 120,
  progressCommentMinutes: 15,
  issueLabel: "mullion-task",
  pollIntervalSeconds: 60,
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
});
