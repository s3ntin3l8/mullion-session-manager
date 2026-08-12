import type { StateCreator } from "zustand";
import { api } from "../../api/index.js";
import type { DashboardState, HostsSlice } from "../types.js";

export const createHostsSlice: StateCreator<DashboardState, [], [], HostsSlice> = (set, get) => ({
  hosts: [],

  refreshHosts: async () => {
    set({ hosts: await api.listHosts() });
  },

  createHost: async (name, baseUrl, token) => {
    const host = await api.createHost(name, baseUrl, token);
    await get().refreshHosts();
    return host;
  },

  updateHost: async (id, patch) => {
    await api.updateHost(id, patch);
    await get().refreshHosts();
  },

  deleteHost: async (id, opts) => {
    await api.deleteHost(id, opts);
    // A cascade delete also removes the host's projects/sessions
    // server-side — refresh all three so the sidebar doesn't keep
    // showing now-deleted rows until the next unrelated refresh.
    await Promise.all([get().refreshHosts(), get().refreshProjects(), get().refreshSessions()]);
  },

  pingHost: async (id) => {
    const { online } = await api.pingHost(id);
    return online;
  },
});
