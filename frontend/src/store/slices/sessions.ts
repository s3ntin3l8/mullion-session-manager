import type { StateCreator } from "zustand";
import { api, AuthExpiredError, RateLimitedError } from "../../api/index.js";
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

// Earliest wall-clock time the live poll may fire its next tick
// (issue #959). Set when refreshSessions catches a RateLimitedError, so
// the cascade (refreshSessions + refreshGitStatuses + refreshGitDiffStats
// — three endpoints on the same 100/min bucket) is skipped wholesale for
// the server's Retry-After window. A 429 is NOT a transport failure: it
// does not increment consecutiveSessionFetchFailures, so the
// genuine-outage banner never flips on rate-limit pressure alone. Read
// by startLiveRefresh's tick (this file) and by the /ws/events push
// throttle (store/slices/events.ts) so the push channel can't bypass the
// backoff the live poll already established.
let sessionRefreshBlockedUntil = 0;

export function getSessionRefreshBlockedUntil(): number {
  return sessionRefreshBlockedUntil;
}

// Visible for tests: a tiny helper to reset the module-scoped state
// without `vi.resetModules()` (which would also wipe every other
// module-level in the test file). The api/client.ts breaker has the
// same shape — see __resetRateLimitBreakerForTests there.
export function __resetSessionRefreshBlockForTests(): void {
  sessionRefreshBlockedUntil = 0;
  consecutiveSessionFetchFailures = 0;
}

export const createSessionsSlice: StateCreator<DashboardState, [], [], SessionsSlice> = (
  set,
  get,
) => ({
  sessions: [],
  sessionsLoaded: false,
  backendReachable: true,
  sessionExpired: false,

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
      // Auto-clear on any success, same as backendReachable above — if a
      // background poll got through without the user ever clicking "Sign
      // in" (e.g. the gateway session was refreshed some other way), the
      // banner shouldn't keep asserting a problem that's already resolved.
      if (get().sessionExpired) set({ sessionExpired: false });
    } catch (err) {
      // A 429 (issue #959) is a "back off and retry" signal, not a
      // transport failure. Distinct from the AuthExpiredError branch
      // (which is the gateway forward-auth signal and the genuine-
      // outage path below: the breaker in api/client.ts owns the
      // "wait Retry-After" semantics; this slice just records the
      // window so the next live-poll tick skips the entire cascade
      // (refreshSessions + refreshGitStatuses + refreshGitDiffStats)
      // instead of hammering the same bucket. Do NOT fold into
      // consecutiveSessionFetchFailures — that counter is for genuine
      // transport/process failures, and the genuine-outage banner's
      // "Mullion server unreachable" subtext is wrong here.
      if (err instanceof RateLimitedError) {
        sessionRefreshBlockedUntil = Math.max(
          sessionRefreshBlockedUntil,
          Date.now() + err.retryAfterMs,
        );
        throw err;
      }
      // A gateway forward-auth session expiry (see api/client.ts) is
      // neither "backend down" nor something this same fetch retrying can
      // ever fix — keep it entirely out of the backendReachable/
      // consecutiveSessionFetchFailures bookkeeping below, which exists for
      // genuine transport/process failures. By the time this is reachable,
      // client.ts has already attempted one silent top-level reload for
      // this session (AuthExpiredError only reaches a caller once that
      // reload's own guard has already fired), so there's no "just retry"
      // recovery left — only the explicit sign-in-again action App.tsx
      // renders for sessionExpired.
      if (err instanceof AuthExpiredError) {
        set({ sessionExpired: true });
        throw err;
      }
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
      // 429 backoff (issue #959): while a Retry-After window is still in
      // the future, the entire cascade is skipped. The three calls below
      // all share the same 100/min bucket behind a Traefik-fronted
      // deployment, so hammering one (or all of them) on the next tick
      // would only extend the block — refreshSessions's own
      // RateLimitedError catch already updated sessionRefreshBlockedUntil
      // to the server's Retry-After when the 429 landed. Reads the
      // module-scoped timestamp rather than store state so the events WS
      // throttle (store/slices/events.ts) and any other caller can
      // observe the same window without subscribing to a re-rendering
      // slice.
      if (Date.now() < sessionRefreshBlockedUntil) {
        return;
      }
      // `.catch(() => {})` on each call site (not a global suppression) is
      // load-bearing: these are fire-and-forget from the tick's
      // perspective, and a RateLimitedError — or any other transient
      // failure — would otherwise surface as an unhandled rejection.
      // refreshSessions() already records what it needs in its own catch
      // (the breaker entry, sessionRefreshBlockedUntil, the
      // consecutiveSessionFetchFailures counter); there's nothing for
      // this tick to do with the rejection.
      void get()
        .refreshSessions()
        .catch(() => {});
      void get()
        .refreshGitStatuses()
        .catch(() => {});
      void get()
        .refreshGitDiffStats()
        .catch(() => {});
      tickCount++;
      if (tickCount % GIT_REFS_REFRESH_EVERY_N_TICKS === 0) {
        void get()
          .refreshGitRefs()
          .catch(() => {});
      }
      if (tickCount % TASKS_REFRESH_EVERY_N_TICKS === 0) {
        void get()
          .refreshTasks()
          .catch(() => {});
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
