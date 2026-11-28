// Dockview workspaces + the groups that organize them in the sidebar.
// Groups have no independent existence outside organizing workspaces
// (setWorkspaceGroup is the only thing that links the two entities), so
// they're folded into this one module rather than getting their own file —
// see this PR's write-up for why that's a deliberate deviation from the
// roadmap's suggested domain list. Split out of the former flat
// frontend/src/api.ts (PR 22 of the refactoring roadmap).
import { request } from "./client.js";
import type { Workspace, Group, PendingOpen } from "./types.js";

export const workspacesApi = {
  listWorkspaces: () => request<Workspace[]>("/api/workspaces"),

  createWorkspace: (name: string) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  renameWorkspace: (id: number, name: string) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  saveWorkspaceLayout: (id: number, layout: Record<string, unknown>) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ layout }),
    }),

  setWorkspaceGroup: (id: number, groupId: number | null, position?: number) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ groupId, ...(position !== undefined ? { position } : {}) }),
    }),

  // #3537 — replaces the workspace's pinned projects; [] clears them.
  setWorkspacePinnedProjects: (id: number, pinnedProjectIds: number[]) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ pinnedProjectIds }),
    }),

  deleteWorkspace: (id: number) => request<void>(`/api/workspaces/${id}`, { method: "DELETE" }),

  // #3033 — sessions opened on the fold or the phone, for a desktop client to
  // add. The fold and the phone record and withdraw; the desktop lists and
  // acknowledges. None of these touch the saved layout.
  listPendingOpens: (workspaceId: number) =>
    request<PendingOpen[]>(`/api/workspaces/${workspaceId}/pending-opens`),

  recordPendingOpen: (workspaceId: number, sessionId: number, referenceSessionId: number | null) =>
    request<PendingOpen>(`/api/workspaces/${workspaceId}/pending-opens`, {
      method: "POST",
      body: JSON.stringify({ sessionId, referenceSessionId }),
    }),

  acknowledgePendingOpen: (workspaceId: number, sessionId: number) =>
    request<{ acknowledged: boolean }>(
      `/api/workspaces/${workspaceId}/pending-opens/${sessionId}/ack`,
      { method: "POST" },
    ),

  withdrawPendingOpen: (workspaceId: number, sessionId: number) =>
    request<void>(`/api/workspaces/${workspaceId}/pending-opens/${sessionId}`, {
      method: "DELETE",
    }),

  listGroups: () => request<Group[]>("/api/groups"),

  createGroup: (name: string, color?: string) =>
    request<Group>("/api/groups", {
      method: "POST",
      body: JSON.stringify(color !== undefined ? { name, color } : { name }),
    }),

  updateGroup: (
    id: number,
    patch: Partial<Pick<Group, "name" | "icon" | "color" | "collapsed" | "position">>,
  ) =>
    request<Group>(`/api/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteGroup: (id: number) => request<void>(`/api/groups/${id}`, { method: "DELETE" }),
};
