import type { FastifyInstance } from "fastify";
import { getStoredSettings, type AppSettings } from "./settings.js";

// Phase 6 Task Master follow-up (Settings UI for the safety envelope) — the
// one place that understands settings.taskMaster's "inherit from env"
// sentinels (see settings.ts's doc comment on the taskMaster field for why
// they exist). Every call site that used to read app.config.MULLION_TASK_*
// directly for one of these four fields now goes through here instead, so a
// settings override takes effect without a restart.
//
// issueLabel and pollIntervalSeconds are NOT part of this — they stay
// env-only (see the plan's "Cut from scope": the label is effectively
// deploy identity, and the poll interval isn't worth the timer-reconfigure
// churn making it live would require).
export interface TaskMasterEnvDefaults {
  enabled: boolean;
  maxConcurrent: number;
  budgetMinutes: number;
  progressCommentMinutes: number;
  rateLimitGraceMinutes: number;
  skipPermissions: boolean;
}

export interface ResolvedTaskMasterConfig {
  enabled: boolean;
  autoClaimPaused: boolean;
  maxConcurrent: number;
  budgetMinutes: number;
  progressCommentMinutes: number;
  rateLimitGraceMinutes: number;
  skipPermissions: boolean;
  reviewCiWaitMinutes: number;
}

// Pure — takes plain values rather than a FastifyInstance so the frontend
// can mirror the exact same resolution algorithm (frontend/src/taskConfig.ts)
// without importing backend types, and so this is unit-testable without
// spinning up an app instance.
export function resolveTaskMaster(
  taskMaster: AppSettings["taskMaster"],
  envDefaults: TaskMasterEnvDefaults,
): ResolvedTaskMasterConfig {
  return {
    enabled: taskMaster.enabled === "inherit" ? envDefaults.enabled : taskMaster.enabled === "on",
    autoClaimPaused: taskMaster.autoClaimPaused,
    maxConcurrent:
      taskMaster.maxConcurrent === -1 ? envDefaults.maxConcurrent : taskMaster.maxConcurrent,
    budgetMinutes:
      taskMaster.budgetMinutes === -1 ? envDefaults.budgetMinutes : taskMaster.budgetMinutes,
    progressCommentMinutes:
      taskMaster.progressCommentMinutes === -1
        ? envDefaults.progressCommentMinutes
        : taskMaster.progressCommentMinutes,
    rateLimitGraceMinutes:
      taskMaster.rateLimitGraceMinutes === -1
        ? envDefaults.rateLimitGraceMinutes
        : taskMaster.rateLimitGraceMinutes,
    skipPermissions:
      taskMaster.skipPermissions === "inherit"
        ? envDefaults.skipPermissions
        : taskMaster.skipPermissions === "on",
    // No sentinel, no env counterpart — settings.ts's own doc comment on
    // this field explains why.
    reviewCiWaitMinutes: taskMaster.reviewCiWaitMinutes,
  };
}

function envDefaultsFromConfig(app: FastifyInstance): TaskMasterEnvDefaults {
  return {
    enabled: app.config.MULLION_TASK_MASTER_ENABLED,
    maxConcurrent: app.config.MULLION_TASK_MAX_CONCURRENT,
    budgetMinutes: app.config.MULLION_TASK_BUDGET_MINUTES,
    progressCommentMinutes: app.config.MULLION_TASK_PROGRESS_COMMENT_MINUTES,
    rateLimitGraceMinutes: app.config.MULLION_TASK_RATE_LIMIT_GRACE_MINUTES,
    skipPermissions: app.config.MULLION_TASK_SKIP_PERMISSIONS,
  };
}

// Resolves fresh from the DB every call — deliberately not cached, so a
// settings PATCH takes effect on the very next call (the next watcher sweep,
// the next claim, the next reconcile tick). Callers on a hot loop (the
// watcher sweep, the reconcile tick) should call this once per tick and
// thread the result down rather than calling it per task/per field.
export function resolveTaskMasterConfig(app: FastifyInstance): ResolvedTaskMasterConfig {
  const settings = getStoredSettings(app.db);
  return resolveTaskMaster(settings.taskMaster, envDefaultsFromConfig(app));
}
