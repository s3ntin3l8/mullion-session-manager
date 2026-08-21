// Project CRUD/discovery + its directly project-scoped sub-resources: saved
// URLs (SavedUrlModal.tsx/store.ts) and agent-rules files (AgentRulesPanel.tsx)
// — both are always reached through a projectId path segment and have no
// other natural home in the domain list. Split out of the former flat
// frontend/src/api.ts (PR 22 of the refactoring roadmap).
import { request } from "./client.js";
import type {
  Project,
  CreateProjectDirOptions,
  CreateProjectResult,
  DiscoveredProject,
  ProjectUrl,
  AgentRuleTarget,
} from "./types.js";
import type { Launcher } from "../../../src/shared/types.js";

export const projectsApi = {
  listProjects: () => request<Project[]>("/api/projects"),

  createProject: (name: string, cwd: string, hostId?: string, opts?: CreateProjectDirOptions) =>
    request<CreateProjectResult>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        cwd,
        ...(hostId ? { hostId } : {}),
        ...(opts?.createDir ? { createDir: true } : {}),
        ...(opts?.gitInit ? { gitInit: true } : {}),
      }),
    }),

  updateProject: (
    id: number,
    patch: Partial<
      Pick<
        Project,
        | "name"
        | "cwd"
        | "devServerUrl"
        | "defaultAgent"
        | "defaultReviewAgent"
        | "mergeOnApprove"
        | "autoApprove"
        | "maxAutoReturnRounds"
        | "conventionalCommitTitles"
      >
    > & { autoFetch?: boolean | null } & CreateProjectDirOptions,
  ) =>
    request<CreateProjectResult>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteProject: (id: number) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),

  discoverProjects: (hostId?: string) =>
    request<DiscoveredProject[]>(
      `/api/projects/discover${hostId ? `?hostId=${encodeURIComponent(hostId)}` : ""}`,
    ),

  listProjectActions: (projectId: number) =>
    request<Launcher[]>(`/api/projects/${projectId}/actions`),

  // Issue #431 — the full target list (all agents, both scopes), content
  // inlined for whatever exists. Never 204s — see routes/agent-rules.ts's
  // own comment on why the target LIST itself is never "not applicable",
  // only individual targets' `exists` flags are.
  listAgentRules: (projectId: number) =>
    request<AgentRuleTarget[]>(`/api/projects/${projectId}/agent-rules`),

  writeProjectAgentRule: (projectId: number, targetId: string, content: string) =>
    request<AgentRuleTarget>(
      `/api/projects/${projectId}/agent-rules/${encodeURIComponent(targetId)}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    ),

  deleteProjectAgentRule: (projectId: number, targetId: string) =>
    request<void>(`/api/projects/${projectId}/agent-rules/${encodeURIComponent(targetId)}`, {
      method: "DELETE",
    }),

  listProjectUrls: (projectId: number) => request<ProjectUrl[]>(`/api/projects/${projectId}/urls`),

  listFavoriteUrls: () => request<ProjectUrl[]>("/api/browser-urls/favorites"),

  createProjectUrl: (projectId: number, label: string, url: string, favorite?: boolean) =>
    request<ProjectUrl>(`/api/projects/${projectId}/urls`, {
      method: "POST",
      body: JSON.stringify({ label, url, favorite }),
    }),

  updateProjectUrl: (
    projectId: number,
    urlId: number,
    patch: Partial<Pick<ProjectUrl, "label" | "url" | "favorite">>,
  ) =>
    request<ProjectUrl>(`/api/projects/${projectId}/urls/${urlId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteProjectUrl: (projectId: number, urlId: number) =>
    request<void>(`/api/projects/${projectId}/urls/${urlId}`, { method: "DELETE" }),

  reorderProjectUrls: (projectId: number, ids: number[]) =>
    request<void>(`/api/projects/${projectId}/urls/reorder`, {
      method: "PATCH",
      body: JSON.stringify({ ids }),
    }),
};
