// Barrel for the split frontend/src/api/ directory (PR 22 of the
// refactoring roadmap — a MECHANICAL split of the former flat
// frontend/src/api.ts, not a rewrite; see .claude/plans/can-we-do-a-warm-
// cocke.md's own "Deliberately NOT doing" table). Every name this module
// exports — the flat `api.xxx()` object, `ApiError`, `normalizeAgentId`,
// `DEFAULT_SETTINGS`, `TASK_STATUSES`/`TaskStatus`/`LOCAL_HOST_ID`, and
// every type below — is exactly what frontend/src/api.ts used to export
// under the same names. The former `frontend/src/api.ts` resolution shim
// (`export * from "./api/index.js"`) is gone as of Wave 5's folder-taxonomy
// PR — every import site now points at `./api/index.js` / `../api/index.js`
// directly.
//
// A handful of type shapes re-exported below used to be hand-mirrored 1:1
// copies of a backend declaration (each annotated "Mirrors src/services/
// X.ts's Y 1:1"), kept in sync by hand with zero compiler enforcement.
// Those physically live in src/shared/types.ts (repo root, NOT this
// frontend workspace — see that file's own header) and are just
// re-exported here.
import type {
  SessionStatus,
  SessionSeverity,
  NotificationEvent,
  SkillAgent,
  SkillScope,
  SkillInfo,
  GitBranchInfo,
  GitWorktreeInfo,
  GitFileStatusCode,
  GitFileStatus,
  GitStatus,
  GitDiffStats,
  LauncherKind,
  Launcher,
  DockerServiceInfo,
  DockControl,
  Theme,
  CursorStyle,
  SidebarDensity,
  SoundName,
} from "../../../src/shared/types.js";

export type {
  SessionStatus,
  SessionSeverity,
  NotificationEvent,
  SkillAgent,
  SkillScope,
  SkillInfo,
  GitBranchInfo,
  GitWorktreeInfo,
  GitFileStatusCode,
  GitFileStatus,
  GitStatus,
  GitDiffStats,
  LauncherKind,
  Launcher,
  DockerServiceInfo,
  DockControl,
  Theme,
  CursorStyle,
  SidebarDensity,
  SoundName,
};

// TASK_STATUSES/LOCAL_HOST_ID are runtime VALUES (not type-only shapes —
// see above), so these are plain imports, not `import type`, and
// physically live in src/shared/constants.ts (repo root, NOT this frontend
// workspace). Re-exported below so every existing import of them from
// "./api/index.js" elsewhere in the frontend keeps working unchanged.
import { TASK_STATUSES, type TaskStatus, LOCAL_HOST_ID } from "../../../src/shared/constants.js";

export { TASK_STATUSES, type TaskStatus, LOCAL_HOST_ID };

// The rest of the former api.ts's local (frontend-only) types — see
// ./types.ts's own header for why these didn't move to src/shared/.
export type {
  AuthStatus,
  Project,
  CreateProjectDirOptions,
  CreateProjectResult,
  DiscoveredProject,
  HostHealthStatus,
  Host,
  HostConfig,
  HostUpdateStatus,
  GitHubAppStatus,
  SetGitHubAppResult,
  GitHubIntegration,
  DeviceFlowState,
  DeviceFlowStatus,
  BrowserCookieProfile,
  SubagentInfo,
  BackgroundTask,
  Session,
  StoredEventRow,
  EventHistoryPage,
  Workspace,
  Group,
  CodexHookTrust,
  Agent,
  GitHubIssueOrPr,
  GitHubActionsRun,
  GitHubCiStatus,
  GitHubPROrWithChecks,
  GitHubPRsStatus,
  GitHubStatus,
  GitHubJob,
  GitHubStep,
  GitHubLogResponse,
  WebhookRegistrationResult,
  GitBranchesResult,
  DeleteBranchReason,
  DeleteBranchResult,
  RemoveWorktreeReason,
  RemoveWorktreeResult,
  AgentRuleAgent,
  AgentRuleScope,
  AgentRuleStatus,
  AgentRuleTarget,
  GitFileDiffResponse,
  GitStatusesBatchResult,
  DockConfigResult,
  DockControlInput,
  DockerUpdateCheckResult,
  DockerUpdateResult,
  Preview,
  ProjectUrl,
  ServerInfo,
  Task,
  TaskBlocker,
  UpdateCheckResult,
  UpdatePhase,
  UpdateStatus,
  AppSettings,
  SettingsPatch,
  PushSubscriptionPayload,
} from "./types.js";

export { ApiError, AuthExpiredError } from "./client.js";

export { normalizeAgentId } from "./system.js";
export { DEFAULT_SETTINGS } from "./settings.js";

import { projectsApi } from "./projects.js";
import { sessionsApi } from "./sessions.js";
import { tasksApi } from "./tasks.js";
import { githubApi } from "./github.js";
import { gitApi } from "./git.js";
import { hostsApi } from "./hosts.js";
import { workspacesApi } from "./workspaces.js";
import { settingsApi } from "./settings.js";
import { dockerApi } from "./docker.js";
import { skillsApi } from "./skills.js";
import { browserApi } from "./browser.js";
import { systemApi } from "./system.js";

// The single flat namespace object every call site in the frontend calls
// through (`api.listProjects()`, `api.createSession(...)`, etc.) — assembled
// from the per-domain objects above. Each domain module's own keys are
// unique across the whole set (verified 1:1 against the former flat
// api.ts's 108 method names when this split was made), so this spread is a
// lossless reassembly, not a merge that could silently drop or shadow one.
export const api = {
  ...projectsApi,
  ...sessionsApi,
  ...tasksApi,
  ...githubApi,
  ...gitApi,
  ...hostsApi,
  ...workspacesApi,
  ...settingsApi,
  ...dockerApi,
  ...skillsApi,
  ...browserApi,
  ...systemApi,
};
