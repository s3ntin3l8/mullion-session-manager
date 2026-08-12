// PR 26 of the refactoring roadmap (.claude/plans/can-we-do-a-warm-cocke.md)
// — store.ts (formerly ~1700 lines, one flat DashboardState + one giant
// `create()` callback) sliced into per-domain zustand StateCreator slices:
// projects / sessions / git / github / tasks / events / workspaces / hosts /
// ui. Stays ONE store object — `create<DashboardState>()((...a) => ({
// ...createProjectsSlice(...a), ... }))` below just spreads each slice's
// returned fields into a single flat state object, so every existing
// `useDashboardStore(s => s.x)` selector across the app is unchanged. See
// store/types.ts's own doc comment on DashboardState for why every slice
// creator is typed `StateCreator<DashboardState, [], [], XSlice>` (the
// combined state, not just that slice's own piece of it) — that's what
// lets a slice's action call `get()`/`set()` against another slice's
// fields and still type-check (e.g. GitSlice's refreshGitStatuses reading
// ProjectsSlice's `projects`, or UiSlice's applySettings writing
// TasksSlice's `taskMasterEnabled`).
//
// No middleware wraps this store today (no persist/devtools/
// subscribeWithSelector) — nothing to preserve here beyond the plain
// `create<T>()(...)` curried form itself.
import { create } from "zustand";
import type { DashboardState } from "./types.js";
import { createProjectsSlice } from "./slices/projects.js";
import { createSessionsSlice } from "./slices/sessions.js";
import { createGitSlice } from "./slices/git.js";
import { createGithubSlice } from "./slices/github.js";
import { createTasksSlice, clearTaskMasterEnvCacheForTests } from "./slices/tasks.js";
import { createEventsSlice } from "./slices/events.js";
import { createWorkspacesSlice } from "./slices/workspaces.js";
import { createHostsSlice } from "./slices/hosts.js";
import { createUiSlice } from "./slices/ui.js";

export const useDashboardStore = create<DashboardState>()((...a) => ({
  ...createProjectsSlice(...a),
  ...createSessionsSlice(...a),
  ...createGitSlice(...a),
  ...createGithubSlice(...a),
  ...createTasksSlice(...a),
  ...createEventsSlice(...a),
  ...createWorkspacesSlice(...a),
  ...createHostsSlice(...a),
  ...createUiSlice(...a),
}));

// --- Public re-exports -----------------------------------------------
// The exact same 11 names store.ts exported before the split (verified via
// `grep -c '^export'` against the pre-split file) — every external
// `from "./store.js"` import site keeps resolving the same symbols.
export {
  LIVE_REFRESH_INTERVAL_MS,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  FALLBACK_TASK_MASTER_ENV,
} from "./constants.js";
export { eventKey } from "./helpers.js";
export type { Theme, ViewMode, TerminalPrefs, SplitRequest } from "./types.js";
export { clearTaskMasterEnvCacheForTests };
