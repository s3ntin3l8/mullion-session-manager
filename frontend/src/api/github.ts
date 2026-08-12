// GitHub integration: per-project repo status/PRs/Actions, webhooks, and the
// account-level connect/device-flow/App credential management. Split out of
// the former flat frontend/src/api.ts (PR 22 of the refactoring roadmap).
import { request } from "./client.js";
import type {
  GitHubStatus,
  GitHubPRsStatus,
  GitHubJob,
  GitHubLogResponse,
  WebhookRegistrationResult,
  GitHubIntegration,
  SetGitHubAppResult,
  DeviceFlowStatus,
} from "./types.js";

export const githubApi = {
  // undefined for the 204 "not applicable" response (see ./types.ts's
  // GitHubStatus) — request() already returns undefined for a 204 body,
  // this just gives that case an honest return type instead of asserting
  // GitHubStatus.
  getProjectGitHub: (projectId: number) =>
    request<GitHubStatus | undefined>(`/api/projects/${projectId}/github`),

  // Per-PR CI status (issue #102) — reads from the server-side poller's
  // warm cache. Returns undefined (204) when the poller hasn't run yet or
  // the repo has no open PRs. Optional `branch` (issue #202) filters down
  // to whichever PR (if any) has that branch as its head — not used by the
  // sidebar's per-session rows (which fetch the unfiltered list once per
  // project and match `headBranch` client-side instead, to avoid one
  // request per session), but exposed here since the backend route
  // supports it and any future single-session/detail view can use it
  // directly.
  getProjectGitHubPRs: (projectId: number, branch?: string) =>
    request<GitHubPRsStatus | undefined>(
      `/api/projects/${projectId}/github/prs${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`,
    ),

  // Phase 2 — jobs and logs for a workflow run (issue #102 follow-up).
  getGitHubRunJobs: (projectId: number, runId: number) =>
    request<GitHubJob[]>(`/api/projects/${projectId}/github/actions/${runId}/jobs`),

  getGitHubLogs: (projectId: number, runId: number, jobId: number, lines?: number) =>
    request<GitHubLogResponse>(
      `/api/projects/${projectId}/github/actions/${runId}/jobs/${jobId}/logs${lines ? `?lines=${lines}` : ""}`,
    ),

  enableGitHubWebhooks: () =>
    request<WebhookRegistrationResult>("/api/integrations/github/webhooks", {
      method: "POST",
    }),

  disableGitHubWebhooks: () =>
    request<void>("/api/integrations/github/webhooks", {
      method: "DELETE",
    }),

  getGitHubWebhookStatus: () =>
    request<{ enabled: boolean; reposSucceeded?: number; reposFailed?: number }>(
      "/api/integrations/github/webhooks/status",
    ),

  getGitHubIntegration: () => request<GitHubIntegration>("/api/integrations/github"),

  setGitHubToken: (token: string) =>
    request<GitHubIntegration>("/api/integrations/github/token", {
      method: "PUT",
      body: JSON.stringify({ token }),
    }),

  disconnectGitHub: () => request<void>("/api/integrations/github", { method: "DELETE" }),

  // #489 remaining scope — write-only, matching setGitHubToken's own
  // never-echo-secrets shape: the response never carries the key itself.
  // #514 — no longer an empty 204: the backend now verifies the credential
  // against GitHub first, so the response reports whether that succeeded
  // (see ./types.ts's SetGitHubAppResult). A rejected/mismatched credential
  // throws instead (a 400 ApiError), same as any other validation failure
  // on this route.
  setGitHubApp: (appId: string, privateKey: string) =>
    request<SetGitHubAppResult>("/api/integrations/github/app", {
      method: "PUT",
      body: JSON.stringify({ appId, privateKey }),
    }),

  clearGitHubApp: () => request<void>("/api/integrations/github/app", { method: "DELETE" }),

  startGitHubDeviceFlow: () =>
    request<DeviceFlowStatus>("/api/integrations/github/device/start", { method: "POST" }),

  getGitHubDeviceFlowStatus: () =>
    request<DeviceFlowStatus>("/api/integrations/github/device/status"),
};
