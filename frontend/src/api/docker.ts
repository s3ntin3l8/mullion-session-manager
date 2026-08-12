// Dock.tsx's backend surface: a project's persistent dock controls (the
// merged view and the raw, unmerged .crs/dock.json editor pair) plus Docker
// Compose service management for a discovered dock control. Both "dock" and
// "docker" concerns share this one file — they're two facets of the same
// panel and the plan names only "docker" in its suggested domain list; see
// this PR's write-up for the deviation note. Split out of the former flat
// frontend/src/api.ts (PR 22 of the refactoring roadmap).
import { request } from "./client.js";
import type {
  DockConfigResult,
  DockControlInput,
  DockerUpdateCheckResult,
  DockerUpdateResult,
} from "./types.js";
import type { DockControl } from "../../../src/shared/types.js";

export const dockerApi = {
  listProjectDock: (projectId: number) => request<DockControl[]>(`/api/projects/${projectId}/dock`),

  // U4 — the raw, per-project `.crs/dock.json` (unmerged — see
  // DockConfigResult's own doc comment). Distinct from listProjectDock
  // above, which returns the merged, Docker-discovery-enriched view
  // Dock.tsx renders from; this pair is for the editor only.
  getProjectDockConfig: (projectId: number) =>
    request<DockConfigResult>(`/api/projects/${projectId}/dock/config`),

  writeProjectDockConfig: (projectId: number, controls: DockControlInput[]) =>
    request<DockConfigResult>(`/api/projects/${projectId}/dock/config`, {
      method: "PUT",
      body: JSON.stringify({ controls }),
    }),

  // Issue #73 — Docker Compose service management for a discovered dock
  // control (control.docker). Both scoped to a `controlId` the server
  // re-resolves against this project's own discovery result server-side —
  // never trust-on-sight.
  checkDockerUpdate: (projectId: number, controlId: string) =>
    request<DockerUpdateCheckResult>(`/api/projects/${projectId}/docker/check-update`, {
      method: "POST",
      body: JSON.stringify({ controlId }),
    }),

  updateDockerStack: (projectId: number, controlId: string) =>
    request<DockerUpdateResult>(`/api/projects/${projectId}/docker/update`, {
      method: "POST",
      body: JSON.stringify({ controlId }),
    }),
};
