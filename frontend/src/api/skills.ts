// Agent skills discovery/toggling (issue #432/#463). Split out of the
// former flat frontend/src/api.ts (PR 22 of the refactoring roadmap).
import { request } from "./client.js";
import type { SkillInfo, SkillAgent } from "../../../src/shared/types.js";

export const skillsApi = {
  // Issue #432 — global + builtin skills only, no project context (Settings'
  // read-only "resolved skill dirs" listing).
  listGlobalSkills: () => request<SkillInfo[]>("/api/skills"),

  // Project-scope skills for `projectId`, plus every global/builtin one on
  // that project's own host (local or remote — see routes/skills.ts).
  listProjectSkills: (projectId: number) =>
    request<SkillInfo[]>(`/api/projects/${projectId}/skills`),

  // Issue #463 — body-only {agent, name, enabled} (see routes/skills.ts's
  // own header for why no path params). Returns the freshly re-resolved
  // SkillInfo row; SkillsPanel still does a full listProjectSkills refetch
  // afterward anyway (same non-optimistic pattern as
  // writeProjectAgentRule/AgentRulesPanel) rather than patching just this
  // one row into client state.
  writeSkillEnabled: (projectId: number, agent: SkillAgent, name: string, enabled: boolean) =>
    request<SkillInfo>(`/api/projects/${projectId}/skills`, {
      method: "PUT",
      body: JSON.stringify({ agent, name, enabled }),
    }),
};
