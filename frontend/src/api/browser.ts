// BrowserPanel.tsx's backend surface: dev-server reachability probing and
// preview registration/minting (project-scoped or external URL). Not one of
// the plan's suggested domains — it doesn't fit "projects" cleanly since
// createExternalPreview and getPreview/deletePreview/mintPreviewToken are
// keyed by an opaque preview slug, not a projectId. Split out on its own
// rather than force-fit; see this PR's write-up for the deviation note.
// Split out of the former flat frontend/src/api.ts (PR 22 of the
// refactoring roadmap).
import { request } from "./client.js";
import type { Preview, ProjectPreviewConfig } from "./types.js";

export const browserApi = {
  // Drops a session's browser binding (DELETE /api/sessions/:id/browser): the
  // way out of a `binding_unavailable` browser — its checkout or host is gone —
  // so the next attach resolves the session's current host and checkout.
  unbindSessionBrowser: (sessionId: number) =>
    request<{ ok: boolean; unbound: number }>(`/api/sessions/${sessionId}/browser`, {
      method: "DELETE",
    }),

  // The browser bindings a session has (GET /api/sessions/:id/browser): one
  // per target its browser pane has attached to, empty when the session has
  // never opened a browser. Read before mounting a BrowserPane, because
  // attaching one is what launches (and binds) the browser.
  getSessionBrowserBindings: (sessionId: number) =>
    request<unknown[]>(`/api/sessions/${sessionId}/browser`),

  getProjectPreviewTargets: (projectId: number) =>
    request<ProjectPreviewConfig>(`/api/projects/${projectId}/preview-targets`),
  saveProjectPreviewTargets: (projectId: number, config: ProjectPreviewConfig) =>
    request<ProjectPreviewConfig>(`/api/projects/${projectId}/preview-targets`, {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  createTargetPreview: (projectId: number, targetId: string) =>
    request<Preview>("/api/previews", {
      method: "POST",
      body: JSON.stringify({ kind: "target", projectId, targetId }),
    }),

  getDevServerStatus: (projectId: number) =>
    request<{ online: boolean }>(`/api/projects/${projectId}/dev-server-status`),

  // Idempotent by projectId — reopening the same project's browser pane
  // reuses its existing preview row/slug rather than minting a new one (see
  // src/services/preview-registry.ts).
  createProjectPreview: (projectId: number) =>
    request<Preview>("/api/previews", {
      method: "POST",
      body: JSON.stringify({ kind: "project", projectId }),
    }),

  // Issues #2016/#2018 — starts (or reuses) the preview of a branch: the
  // project's preview dock control running in a worktree of that branch.
  // Idempotent per (project, branch). Refusals carry an ApiError `code`
  // (no_preview_control, remote_unsupported, unknown_branch, …).
  createBranchPreview: (projectId: number, branch: string) =>
    request<Preview>("/api/previews", {
      method: "POST",
      body: JSON.stringify({ kind: "project", projectId, branch }),
    }),

  // Issue #2018 — the same, for a PR's head branch (resolved server-side).
  createPrPreview: (projectId: number, prNumber: number) =>
    request<Preview>(`/api/projects/${projectId}/github/prs/${prNumber}/preview`, {
      method: "POST",
    }),

  listPreviews: () => request<Preview[]>("/api/previews"),

  createExternalPreview: (url: string) =>
    request<Preview>("/api/previews", {
      method: "POST",
      body: JSON.stringify({ kind: "external", url }),
    }),

  getPreview: (slug: string) => request<Preview>(`/api/previews/${encodeURIComponent(slug)}`),

  deletePreview: (slug: string) =>
    request<void>(`/api/previews/${encodeURIComponent(slug)}`, { method: "DELETE" }),

  // Issue #383 — mints the 60-second bootstrap token BrowserPanel.tsx
  // appends to a preview iframe's URL when previewAuthRequired is true (see
  // ./types.ts's ServerInfo). Only called when that flag is set; a no-op
  // path otherwise.
  mintPreviewToken: (slug: string) =>
    request<{ token: string }>(`/api/previews/${encodeURIComponent(slug)}/token`, {
      method: "POST",
    }),
};
