import type { StateCreator } from "zustand";
import { api } from "../../api/index.js";
import { describeError } from "../../lib/describeError.js";
import type { DashboardState, ProjectsSlice } from "../types.js";

export const createProjectsSlice: StateCreator<DashboardState, [], [], ProjectsSlice> = (
  set,
  get,
) => ({
  projects: [],
  projectUrls: {},
  // "Loading" and "failed" used to be the same state — an empty project
  // list — so the sidebar showed its "Welcome to Mullion" first-run empty
  // state both while the list was still in flight AND forever if the fetch
  // failed (see the audit's finding 14). These two fields separate the
  // three cases: still loading, loaded-and-empty, and failed.
  projectsLoaded: false,
  projectsError: null,

  refreshProjects: async () => {
    let projects;
    try {
      projects = await api.listProjects();
    } catch (err) {
      // The failure is recorded BEFORE it is rethrown, so a caller that
      // catches it (or doesn't) still leaves the UI able to say "the
      // project list could not be loaded" rather than "you have no
      // projects".
      set({ projectsError: describeError(err, "Could not load projects."), projectsLoaded: true });
      throw err;
    }
    set({ projects, projectsError: null, projectsLoaded: true });
    // Fire-and-forget: a project list change (create/rename/delete, or
    // just this tick's poll) shouldn't make every refreshProjects() caller
    // wait on N additional git-status round trips too.
    void get().refreshGitStatuses();
    // Same fire-and-forget shape as refreshGitStatuses above — branches/
    // worktrees/PRs (issue #202) only need to be current as of "whenever
    // the project list last changed," not this exact await.
    void get().refreshGitRefs();
  },

  createProject: async (name, cwd, hostId, opts) => {
    const project = await api.createProject(name, cwd, hostId, opts);
    // Best-effort (Hermes review, PR #620 — same pattern as claimTask's
    // own PR #281 fix): the create itself already succeeded and the
    // caller already has `project` to act on — a transient
    // refreshProjects() failure must not surface as "create failed" when
    // it actually succeeded, which would both show a false error AND
    // invite a retry that inserts a duplicate row (no unique constraint
    // on projects.name/cwd).
    void get()
      .refreshProjects()
      .catch(() => {});
    return project;
  },

  updateProject: async (id, patch) => {
    const project = await api.updateProject(id, patch);
    void get()
      .refreshProjects()
      .catch(() => {});
    return project;
  },

  deleteProject: async (id) => {
    await api.deleteProject(id);
    await Promise.all([get().refreshProjects(), get().refreshSessions()]);
  },

  refreshProjectUrls: async (projectId) => {
    const urls = await api.listProjectUrls(projectId);
    set((state) => ({
      projectUrls: { ...state.projectUrls, [projectId]: urls },
    }));
  },

  addProjectUrl: async (projectId, label, url, favorite) => {
    const created = await api.createProjectUrl(projectId, label, url, favorite);
    set((state) => ({
      projectUrls: {
        ...state.projectUrls,
        [projectId]: [...(state.projectUrls[projectId] ?? []), created],
      },
    }));
    return created;
  },

  updateProjectUrl: async (projectId, urlId, patch) => {
    await api.updateProjectUrl(projectId, urlId, patch);
    set((state) => ({
      projectUrls: {
        ...state.projectUrls,
        [projectId]:
          state.projectUrls[projectId]?.map((u) => (u.id === urlId ? { ...u, ...patch } : u)) ?? [],
      },
    }));
  },

  deleteProjectUrl: async (projectId, urlId) => {
    await api.deleteProjectUrl(projectId, urlId);
    set((state) => ({
      projectUrls: {
        ...state.projectUrls,
        [projectId]: state.projectUrls[projectId]?.filter((u) => u.id !== urlId) ?? [],
      },
    }));
  },
});
