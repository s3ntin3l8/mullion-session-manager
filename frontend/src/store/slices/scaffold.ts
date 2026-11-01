import type { StateCreator } from "zustand";
import type { DashboardState, ScaffoldDraft, ScaffoldSlice } from "../types.js";

// Issue #2478 — the Scaffold panel's form and result, per project. The panel
// unmounts when the user switches workspace or hub tab, and a finished agent
// preview costs a full agent turn, so none of it may live in component state.

/** The server drops a preview after this long (PREVIEW_TTL_MS in
 * src/services/scaffold-generate-jobs.ts). */
export const SCAFFOLD_PREVIEW_TTL_MS = 15 * 60 * 1000;

export const EMPTY_SCAFFOLD_DRAFT: ScaffoldDraft = {
  path: "agent",
  slug: "",
  includeContributingPointer: false,
  symlinkAgentsSkills: false,
  includeDockConfig: false,
  existingInstructions: "keep",
  preview: null,
  previewCreatedAt: null,
  applyResult: null,
  generateJob: null,
  offerRefresh: false,
  refreshSkill: false,
  refreshReviewer: false,
  error: null,
};

export const createScaffoldSlice: StateCreator<DashboardState, [], [], ScaffoldSlice> = (set) => ({
  scaffoldDrafts: {},
  patchScaffoldDraft: (projectId, patch) =>
    set((state) => ({
      scaffoldDrafts: {
        ...state.scaffoldDrafts,
        [projectId]: { ...EMPTY_SCAFFOLD_DRAFT, ...state.scaffoldDrafts[projectId], ...patch },
      },
    })),
  clearScaffoldDraft: (projectId) =>
    set((state) => {
      if (!(projectId in state.scaffoldDrafts)) return state;
      const rest = { ...state.scaffoldDrafts };
      delete rest[projectId];
      return { scaffoldDrafts: rest };
    }),
});
