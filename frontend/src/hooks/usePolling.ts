import { useEffect, useRef } from "react";
import type { DependencyList } from "react";

// Shared `setInterval`-on-mount hook, extracted from the ~9 near-identical
// hand-rolled copies across the frontend (GitHubDeviceFlowModal, GitPanel,
// Dock, Settings x2, App.tsx x2, BrowserPanel — see each call site's own
// comment for which options it needs). store.ts's own `startLiveRefresh` is
// deliberately NOT one of these call sites: it's a Zustand store action (not
// a component-owned effect), multiplexes four different refreshes onto one
// timer via a tick counter, and is invoked exactly once from App.tsx via
// `useEffect(() => useDashboardStore.getState().startLiveRefresh(), [])` —
// folding it into this hook would either lose the multiplexing or force a
// bespoke `fn` shape just for one caller. It stays hand-written; this hook's
// `pauseWhenHidden` option mirrors the same "stop polling while the tab is
// hidden" behavior it already has, ported to the two component-level sites
// (GitPanel, Settings' HostsSection) that had independently grown a softer
// version of the same idea (skip the tick's call instead of tearing the
// timer down — see that option's own doc comment below).
//
// `fn` is read through a ref that's kept current every render (same
// technique GitHubDeviceFlowModal.tsx's own `onConnectedRef` already used
// pre-extraction), so passing a fresh inline closure each render — the
// common case — never tears down and recreates the interval. Only
// `ms`/`enabled`/`pauseWhenHidden`/`immediate`/`deps` control that.
//
// `fn` receives an `isCancelled()` check, true from the moment the
// *current* interval instance is torn down (a `deps` change or unmount)
// onward — for a caller doing async work that must not apply a stale
// response after that happens, same as the hand-rolled `cancelled` guard
// Dock.tsx's own Docker-status poll had pre-extraction (that one restarts
// on `dockConfigRefreshTrigger`, a real mid-lifetime restart, unlike most
// other converted call sites whose `deps` never actually change under a
// live instance — see each call site's own comment on whether it needs
// this). Sites that don't need it just ignore the parameter.
export interface UsePollingOptions {
  /** Extra values that restart the interval when they change — the same
   * role `useEffect`'s own dependency array plays, since `fn` itself is
   * deliberately NOT part of the restart trigger (see above). Defaults to
   * `[]`. Needed by e.g. Dock.tsx's Docker-status poll, which must refetch
   * immediately (not wait out the poll interval) when a dock config save
   * bumps `dockConfigRefreshTrigger`. */
  deps?: DependencyList;
  /** Whether the interval runs at all. Included in the restart-trigger set
   * (unlike `pauseWhenHidden`, an `enabled` flip is expected to visibly
   * start/stop polling with correct phase — e.g. Settings.tsx's
   * update-apply poll, which must fire its first check exactly
   * `UPDATE_STATUS_POLL_MS` after `applying` becomes true, not at some
   * arbitrary offset into an interval that had been quietly running all
   * along). Defaults to `true`. */
  enabled?: boolean;
  /** Call `fn` once synchronously when the interval (re)starts, in addition
   * to every `ms`. Defaults to `true` — most existing call sites want an
   * immediate first fetch on mount. Two poll-until-terminal-state sites
   * (GitHubDeviceFlowModal, Settings' update-apply poll) pass `false`: their
   * first check is deliberately the first *interval* tick, matching their
   * pre-extraction behavior. */
  immediate?: boolean;
  /** Skip invoking `fn` on any tick where the tab is hidden
   * (`document.visibilityState !== "visible"`) — the interval itself keeps
   * running at its normal cadence; hidden ticks just become no-ops, same
   * "soft pause" GitPanel.tsx and Settings.tsx's HostsSection already did
   * by hand before this extraction (as opposed to store.ts's
   * `startLiveRefresh`, which stops/restarts the timer itself via a
   * `visibilitychange` listener — behaviorally equivalent from `fn`'s point
   * of view, just a different implementation this hook doesn't need to
   * replicate). Defaults to `false`: verified against the ~9 real call
   * sites, only 2 had any hidden-tab guard at all, so `false` matches the
   * majority's existing behavior — call sites need to opt in, not opt out. */
  pauseWhenHidden?: boolean;
}

export function usePolling(
  fn: (isCancelled: () => boolean) => void,
  ms: number,
  options: UsePollingOptions = {},
): void {
  const { deps = [], enabled = true, immediate = true, pauseWhenHidden = false } = options;

  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const isCancelled = () => cancelled;

    const tick = () => {
      if (pauseWhenHidden && document.visibilityState !== "visible") return;
      fnRef.current(isCancelled);
    };

    if (immediate) tick();
    const id = setInterval(tick, ms);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // `deps` is a caller-supplied dependency list, mirroring `useEffect`'s
    // own contract (same pattern this repo already accepts for `fn` itself
    // via a ref) — eslint can't statically verify a spread array here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, immediate, ms, pauseWhenHidden, ...deps]);
}
