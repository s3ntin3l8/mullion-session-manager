import type { StateCreator } from "zustand";
import type { DashboardState, ProjectSettingsSlice, ProjectSettingsTarget } from "../types.js";

// #3406 — the Project settings dialog (Agent Rules, Mullion Briefing,
// Scaffold Mullion, Dock) and the Project view's Skills drill-in. In the store
// rather than App state so every opener (the sidebar's Project view, the
// palette's "Project ›" rows, the Dock's "configure" affordances, the
// scaffold offer) reaches it without a dockview or a prop chain, and so App's
// global Escape can ask the dialog to close.

let seq = 0;

export const createProjectSettingsSlice: StateCreator<
  DashboardState,
  [],
  [],
  ProjectSettingsSlice
> = (set, get) => ({
  projectSettings: null,
  projectSettingsDirty: false,
  projectSettingsLeave: null,
  projectSkillsRequest: null,

  openProjectSettings: (projectId, section, dockView) => {
    seq += 1;
    const next: ProjectSettingsTarget = { projectId, section, dockView, rev: seq };
    const { projectSettings: open, projectSettingsDirty: dirty } = get();
    // Another project replaces the dialog's editors, and with them a draft.
    if (open && open.projectId !== projectId && dirty) {
      set({ projectSettingsLeave: { next } });
      return;
    }
    set({
      projectSettings: next,
      projectSettingsLeave: null,
      ...(open?.projectId === projectId ? {} : { projectSettingsDirty: false }),
    });
  },

  requestCloseProjectSettings: () => {
    const { projectSettings: open, projectSettingsDirty: dirty, projectSettingsLeave } = get();
    if (!open) return;
    if (projectSettingsLeave) set({ projectSettingsLeave: null });
    else if (dirty) set({ projectSettingsLeave: { next: null } });
    else set({ projectSettings: null });
  },

  confirmLeaveProjectSettings: () => {
    const leave = get().projectSettingsLeave;
    if (!leave) return;
    set({ projectSettings: leave.next, projectSettingsLeave: null, projectSettingsDirty: false });
  },

  cancelLeaveProjectSettings: () => set({ projectSettingsLeave: null }),

  setProjectSettingsDirty: (dirty) => set({ projectSettingsDirty: dirty }),

  openProjectSkills: (projectId) => {
    seq += 1;
    set({ projectSkillsRequest: { projectId, nonce: seq } });
    get().openRightSidebarView("project", projectId);
  },

  clearProjectSkillsRequest: () => set({ projectSkillsRequest: null }),
});
