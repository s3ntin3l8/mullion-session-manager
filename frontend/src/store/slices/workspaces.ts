import type { StateCreator } from "zustand";
import { api } from "../../api.js";
import type { DashboardState, WorkspacesSlice } from "../types.js";

export const createWorkspacesSlice: StateCreator<DashboardState, [], [], WorkspacesSlice> = (
  set,
  get,
) => ({
  workspaces: [],
  groups: [],

  refreshWorkspaces: async () => {
    set({ workspaces: await api.listWorkspaces() });
  },

  createWorkspace: async (name) => {
    const workspace = await api.createWorkspace(name);
    await get().refreshWorkspaces();
    return workspace;
  },

  renameWorkspace: async (id, name) => {
    await api.renameWorkspace(id, name);
    await get().refreshWorkspaces();
  },

  deleteWorkspace: async (id) => {
    await api.deleteWorkspace(id);
    await get().refreshWorkspaces();
  },

  setWorkspaceGroup: async (id, groupId, position) => {
    await api.setWorkspaceGroup(id, groupId, position);
    await get().refreshWorkspaces();
  },

  reorderWorkspaces: async (updates) => {
    if (updates.length === 0) return;
    set((state) => ({
      workspaces: state.workspaces.map((w) => {
        const u = updates.find((x) => x.id === w.id);
        return u ? { ...w, groupId: u.groupId, position: u.position } : w;
      }),
    }));
    await Promise.all(updates.map((u) => api.setWorkspaceGroup(u.id, u.groupId, u.position)));
    await get().refreshWorkspaces();
  },

  saveWorkspaceLayout: async (id, layout) => {
    try {
      const updated = await api.saveWorkspaceLayout(id, layout);
      set((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === id ? updated : w)),
      }));
    } catch (err) {
      console.error("[store] failed to save workspace layout:", err);
    }
  },

  refreshGroups: async () => {
    set({ groups: await api.listGroups() });
  },

  createGroup: async (name, color) => {
    const group = await api.createGroup(name, color);
    await get().refreshGroups();
    return group;
  },

  updateGroup: async (id, patch) => {
    await api.updateGroup(id, patch);
    await get().refreshGroups();
  },

  deleteGroup: async (id) => {
    await api.deleteGroup(id);
    // A group's member workspaces get groupId set null server-side (ON
    // DELETE SET NULL) — refresh both so they reappear ungrouped instead of
    // looking like they vanished with the group.
    await Promise.all([get().refreshGroups(), get().refreshWorkspaces()]);
  },
});
