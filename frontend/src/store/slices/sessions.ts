import type { StateCreator } from "zustand";
import { api, AuthExpiredError, RateLimitedError } from "../../api/index.js";
import { BACKEND_UNREACHABLE_THRESHOLD, LIVE_REFRESH_INTERVAL_MS } from "../constants.js";
import { pruneDismissedEventKeys, pruneSessionKeyedRecord } from "../helpers.js";
import { writeDismissedEventKeys } from "../../lib/persistedState.js";
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

// In-flight coalescing (issue #1008) — refreshSessions had no dedupe at
// all, unlike its sibling refreshGitStatuses' gitStatusesRefreshInFlight
// (slices/git.ts): Sidebar.tsx's own mount fetch and startLiveRefresh's
// immediate first tick both call it independently, which is what actually
// fired 3 near-simultaneous GET /api/sessions in the 0.3.8 incident.
//
// Deliberately NOT a bare "return the currently-running promise" dedup
// like refreshGitStatuses/refreshGitRefs use — those are safe because
// every caller only wants "whatever the latest periodic fetch returns."
// refreshSessions is different: createSession/renameSession/deleteSession/
// promoteSession/declinePromote all `await get().refreshSessions()`
// specifically to see their OWN just-completed mutation reflected. If a
// concurrent call arrived, a bare dedup could hand a mutation's caller
// back an already-in-flight fetch that STARTED BEFORE that mutation's own
// POST even resolved — the mutation would appear to silently not have
// happened until the next unrelated refresh.
//
// So: a call that arrives while a fetch is already running does NOT share
// that fetch. It shares a QUEUED run instead — one fresh fetch that starts
// only after the current one finishes, guaranteeing its own GET fires
// strictly after whatever the caller just awaited (its mutation's POST).
// Concurrent queuers share the same queued run (further coalescing), which
// is safe: they all only need "the next state after whatever's currently
// in flight resolves," and they all get exactly that.
let refreshSessionsActiveRun: Promise<void> | null = null;
let refreshSessionsQueuedRun: Promise<void> | null = null;

export function __resetRefreshSessionsInFlightForTests(): void {
  refreshSessionsActiveRun = null;
  refreshSessionsQueuedRun = null;
}

export const createSessionsSlice: StateCreator<DashboardState, [], [], SessionsSlice> = (
  set,
  get,
) => ({
  sessions: [],
  sessionsLoaded: false,
  backendReachable: true,
  sessionExpired: false,

  refreshSessions: () => {
    const runOnce = async (): Promise<void> => {
      try {
        const sessions = await api.listSessions();
        // Prune the three per-session-id maps down to only currently-live
        // session ids — see pruneSessionKeyedRecord's own doc comment
        // (store/helpers.ts) for the exact boundary (gone-from-the-API-
        // entirely, not merely killed) and why this runs only on the
        // success path: a transient fetch failure must never be read as
        // "every session is gone" and wipe event history that's still
        // valid.
        const liveIds = new Set(sessions.map((s) => s.id));
        // dismissedEventKeys is persisted to localStorage (issue #1427) —
        // unlike events/lastSeenSeq (in-memory only), a prune here has to
        // also write through, or a deleted session's dismissed keys just
        // linger in storage until some unrelated future dismissEvent call
        // happens to overwrite the whole map. Computed once, outside the
        // updater, so the `!==` no-op check below (pruneDismissedEventKeys
        // returns the SAME reference when nothing changed) can skip the
        // write on the overwhelmingly common case: nothing to prune this
        // tick.
        const dismissedEventKeys = pruneDismissedEventKeys(get().dismissedEventKeys, liveIds);
        if (dismissedEventKeys !== get().dismissedEventKeys) {
          writeDismissedEventKeys(dismissedEventKeys);
        }
        set((state) => ({
          sessions,
          sessionsLoaded: true,
          events: pruneSessionKeyedRecord(state.events, liveIds),
          lastSeenSeq: pruneSessionKeyedRecord(state.lastSeenSeq, liveIds),
          dismissedEventKeys,
        }));
        if (consecutiveSessionFetchFailures > 0 || !get().backendReachable) {
          consecutiveSessionFetchFailures = 0;
          set({ backendReachable: true });
        }
        // Auto-clear on any success, same as backendReachable above — if a
        // background poll got through without the user ever clicking
        // "Sign in" (e.g. the gateway session was refreshed some other
        // way), the banner shouldn't keep asserting a problem that's
        // already resolved.
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
        // neither "backend down" nor something this same fetch retrying
        // can ever fix — keep it entirely out of the backendReachable/
        // consecutiveSessionFetchFailures bookkeeping below, which exists
        // for genuine transport/process failures. By the time this is
        // reachable, client.ts has already attempted one silent top-level
        // reload for this session (AuthExpiredError only reaches a caller
        // once that reload's own guard has already fired), so there's no
        // "just retry" recovery left — only the explicit sign-in-again
        // action App.tsx renders for sessionExpired.
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
    };

    // Coalesce concurrent callers WITHOUT sharing an already-in-flight
    // fetch (see the long comment on refreshSessionsActiveRun/
    // refreshSessionsQueuedRun above for why a bare "return the current
    // promise" dedup — safe for refreshGitStatuses/refreshGitRefs — is
    // wrong here). A call that arrives while one is running gets a shared
    // QUEUED run instead: one fresh runOnce() that starts only once the
    // current one settles (success or failure — .catch(() => {}) below
    // exists purely to normalize that outcome so the queued run always
    // starts, never inherits the current run's rejection).
    if (refreshSessionsActiveRun) {
      if (!refreshSessionsQueuedRun) {
        refreshSessionsQueuedRun = refreshSessionsActiveRun
          .catch(() => {})
          .then(() => {
            refreshSessionsQueuedRun = null;
            if (get().sessionExpired) {
              throw new AuthExpiredError();
            }
            refreshSessionsActiveRun = runOnce().finally(() => {
              refreshSessionsActiveRun = null;
            });
            return refreshSessionsActiveRun;
          });
      }
      return refreshSessionsQueuedRun;
    }

    refreshSessionsActiveRun = runOnce().finally(() => {
      refreshSessionsActiveRun = null;
    });
    return refreshSessionsActiveRun;
  },

  createSession: async (projectId, command, opts) => {
    const session = await api.createSession(projectId, command, opts);
    await get().refreshSessions();
    return session;
  },

  renameSession: async (id, name) => {
    // The name the session had before this rename, captured BEFORE the
    // optimistic write below. Without it there is nothing to roll back
    // to: the rename is optimistic (the row shows the new name
    // immediately, before the PATCH lands), so a failed rename used to
    // leave the session showing a name the server never accepted — and
    // the rejection was dropped by every one of the three call sites
    // (PaneTab.tsx, Sidebar.tsx, MobileSessionBar.tsx all `void`ed it),
    // so the user was never told (audit finding 9).
    const previous = get().sessions.find((s) => s.id === id);
    // Set nameLocked optimistically (same pattern as reorderWorkspaces in
    // slices/workspaces.ts) — closes the narrow window between PaneTab's
    // immediate `props.api.setTitle(value)` and this PATCH+refresh
    // resolving, during which a live OSC title event (issue #69) would
    // otherwise still see nameLocked: false in the store and override the
    // just-committed rename.
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, name, nameLocked: true } : s)),
    }));
    try {
      await api.renameSession(id, name);
    } catch (err) {
      // Roll the optimistic write back to the name the server still has,
      // so the row stops claiming a rename that did not happen. The
      // error is rethrown so the CALLER can tell the user — the store is
      // not the place that decides how a failure is surfaced.
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id
            ? {
                ...s,
                name: previous?.name ?? s.name,
                nameLocked: previous?.nameLocked ?? false,
              }
            : s,
        ),
      }));
      throw err;
    }
    // The re-sync is NOT part of the mutation. The server has already
    // accepted the rename, so a failure of the follow-up GET must not
    // reject the call: the caller would report "Could not rename the
    // session." for a rename the server accepted, PaneTab and
    // MobileSessionBar would roll the tab title back to a name the server
    // no longer has, and the store's own rollback (above) would not run —
    // so the row kept the new name while the tab showed the old one.
    //
    // The re-sync's own failure modes are surfaced elsewhere, and
    // separately: the backend-outage banner (transport), the sign-in
    // banner (AuthExpiredError) and the live-poll backoff (429). See
    // refreshSessions' own catch for how each is recorded.
    await get()
      .refreshSessions()
      .catch(() => {});
  },

  deleteSession: async (id) => {
    await api.deleteSession(id);
    // Same reason as renameSession above: the delete already happened on
    // the server, so a failed re-sync must not be reported as a failed
    // kill. Without this, a 429 on the follow-up GET turned a successful
    // kill into "Failed to kill — try again".
    await get()
      .refreshSessions()
      .catch(() => {});
  },

  promoteSession: async (id, opts) => {
    const session = await api.promoteSession(id, opts);
    // Same reason as renameSession above. PromoteDialog calls this with
    // `void ...then(...)` and no catch, so a rejected re-sync left the
    // dialog stuck on its submitting state even though the promotion had
    // succeeded.
    await get()
      .refreshSessions()
      .catch(() => {});
    return session;
  },

  declinePromote: async (id, reason) => {
    await api.declinePromote(id, reason);
    // Same reason as promoteSession above: PromoteDialog closes the
    // dialog in the `.then()`, so a rejected re-sync left it open.
    await get()
      .refreshSessions()
      .catch(() => {});
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
      // If the gateway forward-auth session is expired, halt the cascade
      // so repeated ticks do not send unauthenticated API calls or trigger
      // competing reload flows.
      if (get().sessionExpired) {
        return;
      }
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
