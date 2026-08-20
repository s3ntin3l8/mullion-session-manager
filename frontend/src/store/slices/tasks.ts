import type { StateCreator } from "zustand";
import { api } from "../../api/index.js";
import { connectTasksStream } from "../../tasksClient.js";
import { resolveTaskMaster } from "../../taskConfig.js";
import type { DashboardState, TasksSlice } from "../types.js";

// Dedups overlapping refreshTasks() calls (same shape as
// gitStatusesRefreshInFlight in slices/git.ts). taskMasterEnv (the six
// deploy-time MULLION_TASK_* values) IS server-restart-only, so it's
// fetched via GET /api/server-info once and cached in state rather than on
// every refreshTasks tick. taskMasterEnabled itself, however, is no longer
// restart-only as of the Task Master Settings UI follow-up — it's derived
// fresh from settings.taskMaster (which can change at any time via
// updateSettings) combined with this cached env, recomputed in slices/ui.ts's
// applySettings rather than only here. A failed first env fetch just
// retries on the next call (taskMasterEnvLoaded stays false).
// clearTaskMasterEnvCacheForTests below resets it between test cases — same
// precedent as agent-detect.ts's clearAgentsCacheForTests.
let tasksRefreshInFlight: Promise<void> | null = null;
// Independent review, PR #477 — a plain "return the in-flight promise"
// dedup (refreshGitStatuses's own shape) is wrong for refreshTasks
// specifically: every task mutation (createTask/updateTask/...) calls
// refreshTasks() *after* its own write lands, precisely to pick that write
// up. If a refresh was already in flight when the mutation's PATCH/POST
// resolved, that in-flight GET was very likely issued *before* the write —
// deduping onto it silently drops the mutation's own result, visible for
// up to a full TASKS_REFRESH_EVERY_N_TICKS tick (~60s). Set when a call
// arrives while one is already running; the running call's own loop
// re-fetches once more before resolving, so every caller's returned
// promise reflects state at least as fresh as when IT was called.
let tasksRefreshQueued = false;
let taskMasterEnvLoaded = false;

export function clearTaskMasterEnvCacheForTests(): void {
  taskMasterEnvLoaded = false;
}

export const createTasksSlice: StateCreator<DashboardState, [], [], TasksSlice> = (set, get) => {
  // #488 — debounces a burst of task-transition events (e.g. several tasks
  // reconciling on the same reconciler tick) into a single refreshTasks()
  // call, rather than one refetch per event.
  let tasksEventRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const TASKS_EVENT_REFRESH_DEBOUNCE_MS = 250;

  return {
    tasks: [],
    taskMasterEnabled: false,
    taskMasterEnv: null,
    tasksLoaded: false,

    // Phase 6 Task Master (6.5/#218) — hardened to refreshGitStatuses's own
    // pattern (in-flight dedup, swallow-and-keep-prior-state on failure).
    // Unlike the Phase 2.5 thin slice, GET /api/tasks is always fetched —
    // 6.9's local board works regardless of taskMasterEnabled — and
    // server-info's taskMasterEnv is only fetched once per page load (see
    // taskMasterEnvLoaded's own doc comment above) rather than on every
    // tick, since it's genuinely restart-only. taskMasterEnabled itself is
    // NOT restart-only anymore (Settings UI follow-up) — it's recomputed
    // here against the settings already in state, and independently
    // recomputed by slices/ui.ts's applySettings whenever settings change.
    refreshTasks: () => {
      if (tasksRefreshInFlight) {
        // See tasksRefreshQueued's own doc comment above — this makes the
        // running call loop once more instead of just deduping onto a fetch
        // that may already be stale relative to this call.
        tasksRefreshQueued = true;
        return tasksRefreshInFlight;
      }

      const fetchOnce = async () => {
        if (!taskMasterEnvLoaded) {
          try {
            const info = await api.getServerInfo();
            set({
              taskMasterEnv: info.taskMasterEnv,
              taskMasterEnabled: resolveTaskMaster(get().settings.taskMaster, info.taskMasterEnv)
                .enabled,
            });
            taskMasterEnvLoaded = true;
          } catch (err) {
            console.warn("[tasks] failed to load taskMasterEnv", err);
          }
        }
        try {
          const tasks = await api.listTasks();
          set({ tasks, tasksLoaded: true });
        } catch (err) {
          console.warn("[tasks] refreshTasks failed", err);
          // Swallow — keep the last-known-good list rather than blanking it
          // to [] on a transient failure (same posture as refreshGitStatuses).
          // tasksLoaded still flips to true here, on the FIRST ATTEMPT
          // rather than the first success — deliberately different from
          // sessionsLoaded above, which only flips on success. Gating
          // UnifiedBoard.tsx's "No tasks yet." empty state on this flag
          // means a dead backend has to fall through to that empty state
          // (same as an empty task list would) rather than being stuck on a
          // permanent loading skeleton with no success and no error ever
          // reaching the UI.
          set({ tasksLoaded: true });
        }
      };

      const run = async () => {
        do {
          tasksRefreshQueued = false;
          await fetchOnce();
        } while (tasksRefreshQueued);
      };

      tasksRefreshInFlight = run().finally(() => {
        tasksRefreshInFlight = null;
      });
      return tasksRefreshInFlight;
    },

    createTask: async (projectId, title, body, opts) => {
      const task = await api.createTask(projectId, title, body, opts);
      void get().refreshTasks();
      return task;
    },

    updateTask: async (id, patch) => {
      const task = await api.updateTask(id, patch);
      void get().refreshTasks();
      return task;
    },

    deleteTask: async (id) => {
      await api.deleteTask(id);
      void get().refreshTasks();
    },

    claimTask: async (id, opts) => {
      const task = await api.claimTask(id, opts);
      // Task-claim queueing (rate-limit-storm fix) — claim now only queues;
      // no session exists yet to open, so refreshSessions() here is a no-op
      // in the common case (kept anyway — harmless, and covers the rare
      // case dispatch already ran by the time this response lands). Still
      // best-effort (Hermes review, PR #281 — same reasoning as before): a
      // transient refresh failure must not surface as "claim failed" when
      // the queue write already succeeded.
      void Promise.all([get().refreshSessions(), get().refreshTasks()]).catch(() => {});
      return task;
    },

    approveTask: async (id) => {
      const task = await api.approveTask(id);
      void get().refreshTasks();
      return task;
    },

    mergeTask: async (id) => {
      const task = await api.mergeTask(id);
      void get().refreshTasks();
      return task;
    },

    rejectTask: async (id, feedback) => {
      const task = await api.rejectTask(id, feedback);
      // A reject can re-seed a fresh session in the same worktree
      // (routes/tasks.ts's reseedIfSessionExited) — refresh sessions too so
      // the task detail's embedded timeline picks up the new session id.
      void Promise.all([get().refreshSessions(), get().refreshTasks()]).catch(() => {});
      return task;
    },

    retryTask: async (id, opts) => {
      const session = await api.retryTask(id, opts);
      // Same dual-refresh reasoning as claimTask above — a new session was
      // just spawned, so the sessions list needs it too.
      void Promise.all([get().refreshSessions(), get().refreshTasks()]).catch(() => {});
      return session;
    },

    giveUpTask: async (id, reason) => {
      const task = await api.giveUpTask(id, reason);
      void get().refreshTasks();
      return task;
    },

    startTasksStream: () => {
      // Debounced refetch, not payload-driven patching — refreshTasks()
      // already has queue-once-more semantics (tasksRefreshQueued, above)
      // that make a refetch safe to call from here without a second dedup
      // mechanism. The 60s poll (SessionsSlice's startLiveRefresh) stays as
      // the fallback for whenever this channel is disconnected or
      // reconnecting.
      const handle = connectTasksStream(() => {
        if (tasksEventRefreshTimer) clearTimeout(tasksEventRefreshTimer);
        tasksEventRefreshTimer = setTimeout(() => {
          tasksEventRefreshTimer = null;
          void get().refreshTasks();
        }, TASKS_EVENT_REFRESH_DEBOUNCE_MS);
      });
      return () => {
        handle.close();
        if (tasksEventRefreshTimer) {
          clearTimeout(tasksEventRefreshTimer);
          tasksEventRefreshTimer = null;
        }
      };
    },
  };
};
