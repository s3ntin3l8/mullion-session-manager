import { describe, it, expect } from "vitest";
import { resolveTaskMaster } from "./taskConfig.js";
import { DEFAULT_SETTINGS } from "./api/index.js";
import { makeTaskMasterEnv } from "./test/fixtures.js";

// Mirrors test/services/task-config.test.ts on the backend — same
// algorithm, same assertions, kept in sync deliberately (see taskConfig.ts's
// own doc comment on why this is a DOM-free duplicate of the backend
// resolver rather than a shared package).
const ENV_DEFAULTS = makeTaskMasterEnv();

describe("resolveTaskMaster", () => {
  it("falls through to every env default when every field is at its inherit sentinel", () => {
    const resolved = resolveTaskMaster(DEFAULT_SETTINGS.taskMaster, ENV_DEFAULTS);
    expect(resolved).toEqual({
      enabled: false,
      autoClaimPaused: false,
      maxConcurrent: 2,
      budgetMinutes: 120,
      progressCommentMinutes: 15,
      rateLimitGraceMinutes: 5,
      rateLimitMaxParkHours: 24,
      skipPermissions: false,
      reviewCiWaitMinutes: 15,
      workerStartTimeoutMinutes: 10,
      maxAutoReturnRounds: 10,
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

  it("#3234 — rateLimitMaxParkHours inherits on -1 and 0 is a real value", () => {
    expect(resolveTaskMaster(DEFAULT_SETTINGS.taskMaster, ENV_DEFAULTS).rateLimitMaxParkHours).toBe(
      24,
    );
    expect(
      resolveTaskMaster({ ...DEFAULT_SETTINGS.taskMaster, rateLimitMaxParkHours: 0 }, ENV_DEFAULTS)
        .rateLimitMaxParkHours,
    ).toBe(0);
    expect(
      resolveTaskMaster({ ...DEFAULT_SETTINGS.taskMaster, rateLimitMaxParkHours: 72 }, ENV_DEFAULTS)
        .rateLimitMaxParkHours,
    ).toBe(72);
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

  it("passes maxAutoReturnRounds through unconditionally — 0 (unlimited) included", () => {
    expect(
      resolveTaskMaster({ ...DEFAULT_SETTINGS.taskMaster, maxAutoReturnRounds: 0 }, ENV_DEFAULTS)
        .maxAutoReturnRounds,
    ).toBe(0);
    expect(resolveTaskMaster(DEFAULT_SETTINGS.taskMaster, ENV_DEFAULTS).maxAutoReturnRounds).toBe(
      10,
    );
  });

  it("passes reviewCiWaitMinutes through unconditionally — no sentinel, no env counterpart", () => {
    expect(
      resolveTaskMaster({ ...DEFAULT_SETTINGS.taskMaster, reviewCiWaitMinutes: 0 }, ENV_DEFAULTS)
        .reviewCiWaitMinutes,
    ).toBe(0);
  });

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
});
