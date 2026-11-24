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
import type { BrowserDestinations } from "./browserDestinationTypes.js";

/** Which preview shows a page of the agent's browser (#3373). */
export type PreviewForAgentAddress =
  | {
      kind: "project";
      previewSlug?: string;
      targetId?: string;
      label: string;
      path: string;
    }
  | { kind: "external"; url: string }
  | { kind: "disabled"; reason: string };

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

  // #3373 — the Browser pane's ⇄ button. Read-only on the server: neither
  // binds nor launches the session's browser. `slug` names one of the
  // project's previews (absent: the checkout's dev server), never the
  // iframe's address, so the preview token is never sent.
  getAgentAddressForPreview: (sessionId: number, slug?: string) =>
    request<{ ok: true; url: string } | { ok: false; reason: string }>(
      `/api/sessions/${sessionId}/browser/address-for-preview` +
        (slug ? `?slug=${encodeURIComponent(slug)}` : ""),
    ),
  getPreviewForAgentAddress: (sessionId: number, url: string) =>
    // A POST so the agent's page address stays out of the request log.
    request<PreviewForAgentAddress>(`/api/sessions/${sessionId}/browser/preview-for-address`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  getProjectPreviewTargets: (projectId: number) =>
    request<ProjectPreviewConfig>(`/api/projects/${projectId}/preview-targets`),
  saveProjectPreviewTargets: (projectId: number, config: ProjectPreviewConfig) =>
    request<ProjectPreviewConfig>(`/api/projects/${projectId}/preview-targets`, {
      method: "PUT",
      body: JSON.stringify(config),
    }),
  // #3003 — the Browser pane's quick pick: what the project runs now and
  // what it has saved. Read-only.
  getBrowserDestinations: (projectId: number) =>
    request<BrowserDestinations>(`/api/projects/${projectId}/browser-destinations`),

  // #3003 — the preview serving a running entry's port (created on first
  // use). The server finds the port from the entry's key; 409 without
  // PREVIEW_BASE_HOST, 404 once the service stopped.
  openDestinationPreview: (projectId: number, key: string) =>
    request<{ slug: string; label: string }>(
      `/api/projects/${projectId}/browser-destinations/preview`,
      { method: "POST", body: JSON.stringify({ key }) },
    ),

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
