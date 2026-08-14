import { useEffect } from "react";
import { useDashboardStore } from "../store/index.js";

// Extracted from App.tsx (PR 34e of the hook-extraction series) — the four
// effects that establish this app's live data feeds from the backend: the
// ~4s session-status poll plus the three push-WS channels (/ws/events,
// /ws/tasks, /ws/github). Each of the underlying store actions
// (SessionsSlice's startLiveRefresh, EventsSlice's startEventsStream,
// TasksSlice's startTasksStream, GithubSlice's connectGitHubWS — see
// store/slices/*.ts) already owns its own connect/reconnect/cleanup logic
// and returns a `() => void` disposer; every effect here is a one-line
// `useEffect(() => useDashboardStore.getState().xxx(), [])` that just wires
// that disposer up as the effect's own cleanup, mount-once (empty deps).
// The store actions' own WS-connect/reconnect/message-parsing/error-handling
// behavior is covered by their own dedicated test files (store.events.test.ts,
// store.tasksStream.test.ts, store.githubWS.test.ts) — this hook's tests
// (useAppStreams.test.ts) verify only the wiring: each stream starts exactly
// once on mount, and each one's disposer is invoked on unmount.
//
// Ordering/coupling analysis: like useGlobalShortcuts (PR 34d), this is NOT
// load-bearing position — confirmed by reading every other effect in
// App.tsx. All four effects here call `useDashboardStore.getState().xxx()`
// (a live read at call time, not a subscribed value), take no parameters
// derived from this component's props/state/refs, and depend on nothing
// this component computes — the store actions internally reach into other
// store slices themselves (e.g. startLiveRefresh's tick calls
// get().refreshGitStatuses()/refreshTasks(), independent of anything in
// App.tsx). No other effect in App.tsx reads a ref or piece of local state
// that any of these four effects write (they write only into store state,
// which every consumer subscribes to independently via useDashboardStore —
// not via effect-run-order), and no other effect's own body depends on one
// of these four having already run this render (unlike
// useWorkspacePersistence/useMobileLayout's restoringRef/isMobile
// hand-off — see those hooks' own header comments). App.tsx calls this hook
// at the exact position these four effects previously occupied purely to
// keep the diff minimal and the file's effect ordering easy to audit, same
// reasoning as useDockviewDrop/useGlobalShortcuts reached for their own
// effects.
//
// Connection-lifecycle correctness (verified by reading each slice, not
// assumed): none of the four store actions guards against being CALLED
// TWICE — each invocation unconditionally opens a fresh connection/timer
// and just overwrites the slice's own module-closure handle var
// (`eventsClientHandle` in events.ts, `gitHubWS` in github.ts, etc.), which
// is exactly what store.githubWS.test.ts's "a fresh connection's
// re-subscribe..." case demonstrates by calling connectGitHubWS() twice and
// asserting on two distinct WebSocket instances. startLiveRefresh (see
// sessions.ts) does have an internal `start()`/`stop()` guarded by a
// `timer` variable, but that guard is closure-local to ONE invocation of
// startLiveRefresh() — a second call creates an entirely new closure with
// its own independent `timer`, so it doesn't prevent a double-call from
// producing two intervals either. What prevents an actual double-connect in
// practice is this hook only ever calling each action once (mount-once,
// empty deps) and always running its disposer before any second mount could
// occur: `main.tsx` wraps the app in `<StrictMode>`, whose dev-only
// mount→cleanup→remount dance is exactly the double-invoke scenario that
// would otherwise trip this — each effect's cleanup (the disposer returned
// by the store action) runs during that synchronous first "unmount" and
// tears the socket/timer down before the remount's second call happens, so
// no window ever exists where two live connections coexist. This hook's own
// tests below assert exactly that sequencing (disposer called before any
// second start, per stream, independently).
export function useAppStreams(): void {
  // Starts the ~4s session-status poll once (paused while the tab is
  // hidden) so status badges reflect the backend without a mutation.
  useEffect(() => useDashboardStore.getState().startLiveRefresh(), []);

  // Connects the single /ws/events push channel once (issue #166) — not
  // per-pane, unlike TerminalPane.tsx's own per-session WS. Additive
  // alongside the poll above, which stays as the fallback for whenever this
  // channel is disconnected or reconnecting (see eventsClient.ts). As of
  // issue #673, this also throttled-triggers refreshSessions() on
  // status-bearing frames (slices/events.ts), so status badges/the tab-title
  // badge update well inside the poll's 4s interval and keep updating while
  // the tab is hidden and the poll itself is paused.
  useEffect(() => useDashboardStore.getState().startEventsStream(), []);

  // #488 — connects the /ws/tasks push channel once on mount so the Tasks
  // panel picks up a transition within ~1s instead of on the next 60s poll
  // tick. Additive alongside that poll, which stays as the fallback.
  useEffect(() => useDashboardStore.getState().startTasksStream(), []);

  // Phase 2 GitHub WS — connects the /ws/github push channel once on mount
  // so real-time PR/CI/issue updates from webhooks reach the store.
  useEffect(() => useDashboardStore.getState().connectGitHubWS(), []);
}
