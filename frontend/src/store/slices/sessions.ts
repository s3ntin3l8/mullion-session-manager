import type { StateCreator } from "zustand";
import { api } from "../../api/index.js";
import { BACKEND_UNREACHABLE_THRESHOLD, LIVE_REFRESH_INTERVAL_MS } from "../constants.js";
import { pruneDismissedEventKeys, pruneSessionKeyedRecord } from "../helpers.js";
import type { DashboardState, SessionsSlice } from "../types.js";

// Consecutive failed session-fetches (from any caller — the live poll,
// Sidebar's own mount fetch, etc.) before the design's "whole backend down"
// banner shows. Module-scoped (not component state) — refreshSessions() is
// called from many places (the live poll, Sidebar's mount effect,
// onSessionEnded flows), and all of them should share one counter/recovery
// signal rather than each tracking its own.
let consecutiveSessionFetchFailures = 0;

export const createSessionsSlice: StateCreator<DashboardState, [], [], SessionsSlice> = (
  set,
  get,
) => ({
  sessions: [],
  sessionsLoaded: false,
  backendReachable: true,

  refreshSessions: async () => {
    try {
      const sessions = await api.listSessions();
      // Prune the three per-session-id maps down to only currently-live
      // session ids — see pruneSessionKeyedRecord's own doc comment
      // (store/helpers.ts) for the exact boundary (gone-from-the-API-
      // entirely, not merely killed) and why this runs only on the success
      // path: a transient fetch failure must never be read as "every
      // session is gone" and wipe event history that's still valid.
      const liveIds = new Set(sessions.map((s) => s.id));
      set((state) => ({
        sessions,
        sessionsLoaded: true,
        events: pruneSessionKeyedRecord(state.events, liveIds),
        lastSeenSeq: pruneSessionKeyedRecord(state.lastSeenSeq, liveIds),
        dismissedEventKeys: pruneDismissedEventKeys(state.dismissedEventKeys, liveIds),
      }));
      if (consecutiveSessionFetchFailures > 0 || !get().backendReachable) {
        consecutiveSessionFetchFailures = 0;
        set({ backendReachable: true });
      }
    } catch (err) {
      consecutiveSessionFetchFailures += 1;
      if (consecutiveSessionFetchFailures >= BACKEND_UNREACHABLE_THRESHOLD) {
        set({ backendReachable: false });
      }
      throw err;
    }
  },

  createSession: async (projectId, command, opts) => {
    const session = await api.createSession(projectId, command, opts);
    await get().refreshSessions();
    return session;
  },

  renameSession: async (id, name) => {
    // Set nameLocked optimistically (same pattern as reorderWorkspaces in
    // slices/workspaces.ts) — closes the narrow window between PaneTab's
    // immediate `props.api.setTitle(value)` and this PATCH+refresh
    // resolving, during which a live OSC title event (issue #69) would
    // otherwise still see nameLocked: false in the store and override the
    // just-committed rename.
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, name, nameLocked: true } : s)),
    }));
    await api.renameSession(id, name);
    await get().refreshSessions();
  },

  deleteSession: async (id) => {
    await api.deleteSession(id);
    await get().refreshSessions();
  },

  promoteSession: async (id, opts) => {
    const session = await api.promoteSession(id, opts);
    await get().refreshSessions();
    return session;
  },

  declinePromote: async (id, reason) => {
    await api.declinePromote(id, reason);
    await get().refreshSessions();
  },

  startLiveRefresh: () => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let tickCount = 0;
    // ~60s at the 4s tick interval — throttles refreshGitRefs (branches/
    // worktrees/PRs) onto this same timer instead of a second dedicated
    // interval, at a cadence appropriate for data that changes far less
    // often than working-tree status (see that action's own doc comment).
    const GIT_REFS_REFRESH_EVERY_N_TICKS = 15;
    // Same ~60s cadence as git refs — the task watcher's own server-side
    // poll interval defaults to 60s (MULLION_TASK_POLL_INTERVAL), so
    // polling the list faster than that here wouldn't surface anything
    // new anyway. Sidebar's own mount effect covers the immediate load.
    const TASKS_REFRESH_EVERY_N_TICKS = 15;

    const tick = () => {
      void get().refreshSessions();
      void get().refreshGitStatuses();
      void get().refreshGitDiffStats();
      tickCount++;
      if (tickCount % GIT_REFS_REFRESH_EVERY_N_TICKS === 0) {
        void get().refreshGitRefs();
      }
      if (tickCount % TASKS_REFRESH_EVERY_N_TICKS === 0) {
        void get().refreshTasks();
      }
    };

    const start = () => {
      if (timer !== null) return;
      tick();
      timer = setInterval(tick, LIVE_REFRESH_INTERVAL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  },
});
