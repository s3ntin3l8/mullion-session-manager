import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { DockviewApi } from "dockview-react";
import type { Session, Workspace } from "../api/index.js";
import { parseDeepLinkSessionId } from "../panelUtils.js";

export interface UseSessionDeepLinkParams {
  dockviewApi: DockviewApi | null;
  activeWorkspaceId: number | null;
  sessionsLoaded: boolean;
  sessions: Session[];
  // Never read directly in this hook's effect body, but `workspaceRestored`
  // below depends on the restore effect (useWorkspacePersistence) having
  // already run for the current activeWorkspaceId — and that effect's own
  // gate is `workspaces.find(...)`, so it can't complete until `workspaces`
  // has loaded. Listed as a dependency so a load order where sessions
  // resolve before workspaces would still retry this effect once workspaces
  // finally arrives.
  workspaces: Workspace[];
  // Reuses onOpenSession rather than reimplementing its cross-workspace-
  // switch logic (find which workspace the session's panel actually lives
  // in, switch to it if different) — that function already does exactly
  // what a deep link needs. Identity matters: it's listed in this hook's own
  // effect dependency array, and App.tsx's onOpenSession is itself a stable
  // useCallback, so this doesn't cause spurious re-runs.
  onOpenSession: (session: Session) => void;
  // Returned from useWorkspacePersistence SPECIFICALLY so this hook (and the
  // auto-open-child-panel/push-message effects still in App.tsx) can keep
  // reading the exact same ref objects that hook's own restore effect writes
  // to — see useWorkspacePersistence.ts's own
  // UseWorkspacePersistenceResult doc comments. Both are ordinary refs
  // (mutated in place, never reassigned): passing them through as params
  // preserves that shared identity rather than creating this hook's own,
  // disconnected refs.
  restoringRef: MutableRefObject<boolean>;
  restoredWorkspaceIdRef: MutableRefObject<number | null>;
}

// Extracted from App.tsx (PR 34g of the hook-extraction series) — the
// `?session=<id>` deep-link effect (issue #95 prerequisite): a push
// notification's notificationclick handler (or any external link) can't
// reach into dockview state the way an in-page click can, so it points at
// "/" plus this query param to have the app open a specific session on load.
//
// LOAD-BEARING COUPLING — read before touching this hook's call site in
// App.tsx: this hook must be called AFTER useWorkspacePersistence(...) in
// App.tsx's render body, and must be passed the EXACT SAME
// restoringRef/restoredWorkspaceIdRef objects that hook returns (not private
// refs of its own). The retry timer below relies on
// useWorkspacePersistence's own restore effect having scheduled its
// re-arming `setTimeout(0)` FIRST in the same synchronous effect flush —
// same-delay macrotasks fire in scheduling order, so as long as
// useWorkspacePersistence's hook call (and therefore its effect
// registration) comes first, this hook's own retry timer is guaranteed to
// observe `restoringRef.current === false` by the time it fires. See
// useWorkspacePersistence.ts's own header comment and
// UseWorkspacePersistenceResult doc comments for the other side of this
// contract.
export function useSessionDeepLink({
  dockviewApi,
  activeWorkspaceId,
  sessionsLoaded,
  sessions,
  workspaces,
  onOpenSession,
  restoringRef,
  restoredWorkspaceIdRef,
}: UseSessionDeepLinkParams): void {
  // Issue #95 prerequisite — a deep link (e.g. a push notification's
  // notificationclick) should only ever be consumed once per page load, not
  // re-applied on every subsequent render once its gate conditions hold.
  const deepLinkHandledRef = useRef(false);
  // Forces the deep-link effect below to retry once restoringRef.current
  // flips false, since that's a bare ref write and triggers no re-render on
  // its own — see the effect's own comment for the scheduling argument.
  const [deepLinkRetryTick, setDeepLinkRetryTick] = useState(0);

  // Issue #95 prerequisite — deep-link a session via ?session=<id> (e.g. a
  // push notification's notificationclick handler, which can't reach into
  // dockview state the way an in-page click can). Query param, not a path
  // segment: there's no client-side router in this app and
  // src/plugins/static.ts serves the build with no SPA rewrite, so
  // /session/3 would 404 while /?session=3 is still "/".
  //
  // Gated the same way the auto-open-child-panel effect (still in App.tsx)
  // is (workspace restore complete, not mid-restore, sessions loaded) — same
  // reasoning: opening a panel before the restore effect has applied the
  // CURRENT workspace's saved layout would get silently wiped by that
  // effect's dockviewApi.clear()+fromJSON() a moment later. Reuses
  // onOpenSession rather than reimplementing its cross-workspace-switch
  // logic (find which workspace the session's panel actually lives in,
  // switch to it if different) — that function already does exactly what a
  // deep link needs. onOpenSession itself calls setState
  // (setActiveWorkspaceId/setSidebarOpen) — deferred via setTimeout(0), same
  // pattern useWorkspacePersistence's own restore effect uses, since this repo's
  // react-hooks/set-state-in-effect lint rule disallows calling a
  // setState-triggering function synchronously from inside an effect body.
  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    const workspaceRestored =
      activeWorkspaceId !== null && restoredWorkspaceIdRef.current === activeWorkspaceId;
    if (!dockviewApi || !workspaceRestored || !sessionsLoaded) return;
    if (restoringRef.current) {
      // restoringRef flips to false via a bare ref write in the restore
      // effect's own re-arm setTimeout(0) (useWorkspacePersistence.ts) —
      // that write triggers no re-render, so without an explicit retry this
      // effect would sit stalled until an unrelated store update happens to
      // re-render this component. Both setTimeout(0)s are scheduled in the
      // same synchronous effect flush, the restore effect's first (App.tsx
      // calls useWorkspacePersistence before this hook) — macrotasks with
      // equal delay run in scheduling order, so by the time this one fires,
      // restoringRef.current is already false and the retry succeeds
      // deterministically.
      const timer = setTimeout(() => setDeepLinkRetryTick((t) => t + 1), 0);
      return () => clearTimeout(timer);
    }

    deepLinkHandledRef.current = true;
    const url = new URL(window.location.href);
    const sessionId = parseDeepLinkSessionId(url.search);
    if (sessionId !== null) {
      // Clears only the `session` param regardless of whether a matching
      // session is found, so a reload never re-triggers this for a session
      // that's since been killed/renamed away, and the URL doesn't linger
      // looking "sticky" — while leaving any other query params/hash intact.
      url.searchParams.delete("session");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      const session = sessions.find((s) => s.id === sessionId);
      // Killed sessions stay in `sessions` (see App.tsx's panel-cleanup
      // effect); opening one would show a panel that the next `sessions`
      // update closes right back out from under the user.
      if (session && session.status !== "killed") {
        // Cleaned up on unmount (dev HMR, app teardown) — same reasoning as
        // the restoringRef retry timer above, since onOpenSession reads
        // dockviewApi by closure and would otherwise run against a
        // torn-down instance if unmount lands inside this window.
        const timer = setTimeout(() => onOpenSession(session), 0);
        return () => clearTimeout(timer);
      }
    }
  }, [
    dockviewApi,
    activeWorkspaceId,
    sessionsLoaded,
    sessions,
    onOpenSession,
    deepLinkRetryTick,
    // workspaces itself is never read directly in this effect body, but
    // workspaceRestored above depends on the restore effect having already
    // run for the current activeWorkspaceId — and that effect's own gate is
    // `workspaces.find(...)`, so it can't complete until workspaces has
    // loaded. Without this dependency, a load order where sessions resolve
    // before workspaces would leave this effect's gate unsatisfiable with no
    // dependency change to retry on once workspaces finally arrives.
    workspaces,
    // restoringRef/restoredWorkspaceIdRef come from useWorkspacePersistence's
    // return value rather than a bare useRef() in this hook, so eslint's
    // exhaustive-deps rule can no longer statically prove they're stable ref
    // identities and flags them as missing — listed here purely to satisfy
    // the lint rule; both are ordinary refs (mutated in place, never
    // reassigned), so including them has no effect on when this effect
    // re-runs.
    restoringRef,
    restoredWorkspaceIdRef,
  ]);
}
