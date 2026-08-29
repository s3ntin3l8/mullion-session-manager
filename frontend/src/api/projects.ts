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
        | "autoTagRelease"
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

  // Issue: per-project Mullion briefing authored from the UI — a DB row
  // (project-tooling.ts), not a file, so unlike the agent-rules trio above
  // there's no target list and no host-branching to reflect: each field is
  // `null` when the project has no DB-authored content for it yet (the
  // ordinary case), never 404. PR-5 extended the row with `skill`/
  // `reviewerAgent` alongside `briefing` — GET returns all three together.
  getProjectTooling: (projectId: number) =>
    request<{ briefing: string | null; skill: string | null; reviewerAgent: string | null }>(
      `/api/projects/${projectId}/tooling`,
    ),

  writeProjectTooling: (projectId: number, briefing: string) =>
    request<{ briefing: string | null }>(`/api/projects/${projectId}/tooling`, {
      method: "PUT",
      body: JSON.stringify({ briefing }),
    }),

  // Deletes the row entirely — NOT the same as writing an empty string, see
  // deleteProjectBriefing's own doc comment (project-tooling.ts) for why:
  // this restores the project's own committed AGENTS.md/CLAUDE.md region,
  // if any, rather than overriding it with a blank briefing.
  deleteProjectTooling: (projectId: number) =>
    request<void>(`/api/projects/${projectId}/tooling`, { method: "DELETE" }),

  // PR-5 — same posture as the briefing trio above, independent field
  // (deleting the skill leaves briefing/reviewerAgent on the same row
  // untouched — see project-tooling.ts's clearToolingColumn).
  writeProjectSkill: (projectId: number, skill: string) =>
    request<{ skill: string | null }>(`/api/projects/${projectId}/tooling/skill`, {
      method: "PUT",
      body: JSON.stringify({ skill }),
    }),

  deleteProjectSkill: (projectId: number) =>
    request<void>(`/api/projects/${projectId}/tooling/skill`, { method: "DELETE" }),

  writeProjectReviewerAgent: (projectId: number, reviewerAgent: string) =>
    request<{ reviewerAgent: string | null }>(`/api/projects/${projectId}/tooling/reviewer-agent`, {
      method: "PUT",
      body: JSON.stringify({ reviewerAgent }),
    }),

  deleteProjectReviewerAgent: (projectId: number) =>
    request<void>(`/api/projects/${projectId}/tooling/reviewer-agent`, { method: "DELETE" }),

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
