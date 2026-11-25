// DOM-free mirror of src/services/task-config.ts's resolveTaskMaster —
// same algorithm, same sentinel semantics, kept in its own module (the
// tasksBoard.ts/kanban.ts convention) so it's independently unit-testable
// and keeps Settings.tsx react-refresh-clean. See settings.ts's doc comment
// on the backend's taskMaster field for the full sentinel rationale.
import type { AppSettings, ServerInfo } from "./api/index.js";
import type { ResolvedTaskMasterConfig } from "../../src/shared/types.js";
export type { ResolvedTaskMasterConfig } from "../../src/shared/types.js";

export function resolveTaskMaster(
  taskMaster: AppSettings["taskMaster"],
  envDefaults: ServerInfo["taskMasterEnv"],
): ResolvedTaskMasterConfig {
  return {
    enabled: taskMaster.enabled === "inherit" ? envDefaults.enabled : taskMaster.enabled === "on",
    autoClaimPaused: taskMaster.autoClaimPaused,
    workerStartTimeoutMinutes: taskMaster.workerStartTimeoutMinutes ?? 10,
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
    rateLimitMaxParkHours:
      // Keep the `?? 24` fallback for pre-#3269 `/api/server-info` payloads in
      // mixed-build environments where `taskMasterEnv.rateLimitMaxParkHours` may be absent.
      taskMaster.rateLimitMaxParkHours === -1
        ? (envDefaults.rateLimitMaxParkHours ?? 24)
        : taskMaster.rateLimitMaxParkHours,
    skipPermissions:
      taskMaster.skipPermissions === "inherit"
        ? envDefaults.skipPermissions
        : taskMaster.skipPermissions === "on",
    reviewCiWaitMinutes: taskMaster.reviewCiWaitMinutes,
    maxAutoReturnRounds: taskMaster.maxAutoReturnRounds,
  };
}
