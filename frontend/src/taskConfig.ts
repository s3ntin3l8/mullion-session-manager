// DOM-free mirror of src/services/task-config.ts's resolveTaskMaster —
// same algorithm, same sentinel semantics, kept in its own module (the
// tasksBoard.ts/kanban.ts convention) so it's independently unit-testable
// and keeps Settings.tsx react-refresh-clean. See settings.ts's doc comment
// on the backend's taskMaster field for the full sentinel rationale.
import type { AppSettings, ServerInfo } from "./api/index.js";

export interface ResolvedTaskMasterConfig {
  enabled: boolean;
  autoClaimPaused: boolean;
  maxConcurrent: number;
  budgetMinutes: number;
  progressCommentMinutes: number;
  skipPermissions: boolean;
  reviewCiWaitMinutes: number;
}

export function resolveTaskMaster(
  taskMaster: AppSettings["taskMaster"],
  envDefaults: ServerInfo["taskMasterEnv"],
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
    skipPermissions:
      taskMaster.skipPermissions === "inherit"
        ? envDefaults.skipPermissions
        : taskMaster.skipPermissions === "on",
    reviewCiWaitMinutes: taskMaster.reviewCiWaitMinutes,
  };
}
