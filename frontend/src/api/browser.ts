// BrowserPanel.tsx's backend surface: dev-server reachability probing and
// preview registration/minting (project-scoped or external URL). Not one of
// the plan's suggested domains — it doesn't fit "projects" cleanly since
// createExternalPreview and getPreview/deletePreview/mintPreviewToken are
// keyed by an opaque preview slug, not a projectId. Split out on its own
// rather than force-fit; see this PR's write-up for the deviation note.
// Split out of the former flat frontend/src/api.ts (PR 22 of the
// refactoring roadmap).
import { request } from "./client.js";
import type { Preview } from "./types.js";

export const browserApi = {
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
