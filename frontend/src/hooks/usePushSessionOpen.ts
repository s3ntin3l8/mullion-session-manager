/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { RefObject } from "react";
import type { DockviewApi } from "dockview-react";
import type { Session } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.
// Must run after useWorkspacePersistence (same restoringRef /
// restoredWorkspaceIdRef objects) and after useSyncSessionOpenerRefs,
// which publishes the sessions/onOpenSession refs this effect reads.

export interface UsePushSessionOpenParams {
  dockviewApi: DockviewApi | null;
  activeWorkspaceId: number | null;
  sessionsLoaded: boolean;
  sessionsRef: RefObject<Session[]>;
  onOpenSessionRef: RefObject<(session: Session) => void>;
  restoringRef: RefObject<boolean>;
  restoredWorkspaceIdRef: RefObject<number | null>;
  pendingPushSessionIdRef: RefObject<number | null>;
  pushRetryTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
}

export function usePushSessionOpen({
  dockviewApi,
  activeWorkspaceId,
  sessionsLoaded,
  sessionsRef,
  onOpenSessionRef,
  restoringRef,
  restoredWorkspaceIdRef,
  pendingPushSessionIdRef,
  pushRetryTimerRef,
}: UsePushSessionOpenParams): void {
  // A message that arrives before the app is actually ready to open a panel
  // would otherwise be silently dropped or raced (Hermes review): gating on
  // dockviewApi alone isn't enough — if sessions are still loading, the
  // pending id would be cleared without ever finding a match once they
  // arrive; if it lands mid workspace-restore, opening immediately would
  // get wiped right back out by the restore effect's own clear()+fromJSON().
  // Reuses the exact same three gates as the ?session= deep-link effect in
  // useSessionDeepLink.ts
  // (workspaceRestored/sessionsLoaded/!restoringRef.current).
  //
  // Owns its own retry timer (pushRetryTimerRef) rather than riding on the
  // deep-link effect's deepLinkRetryTick, as an earlier version of this
  // comment claimed (Hermes review, sixth pass — a real bug, not just a
  // stale comment): deepLinkHandledRef flips true unconditionally the
  // first time the deep-link effect clears its gates, whether or not a
  // ?session= param was even present, and every later run of that effect
  // short-circuits before ever reaching the code that bumps
  // deepLinkRetryTick. That tick is therefore only alive during the
  // initial-mount race and permanently dead afterward — a push click
  // landing during a LATER workspace-switch restore had no retry source at
  // all. This effect's own timer re-arms itself directly (scheduled for
  // the next macrotask, by which point restoringRef.current has settled,
  // same reasoning as the deep-link effect's own timer) regardless of
  // anything the deep-link effect does or doesn't do.

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const tryOpenPendingSession = () => {
      const sessionId = pendingPushSessionIdRef.current;
      if (sessionId == null) return;
      const workspaceRestored =
        activeWorkspaceId !== null && restoredWorkspaceIdRef.current === activeWorkspaceId;
      if (!dockviewApi || !workspaceRestored || !sessionsLoaded) return;
      if (restoringRef.current) {
        if (pushRetryTimerRef.current == null) {
          pushRetryTimerRef.current = setTimeout(() => {
            pushRetryTimerRef.current = null;
            tryOpenPendingSession();
          }, 0);
        }
        return;
      }
      // Once every gate above passes, a session id that still isn't found
      // (killed/reaped between push delivery and click, or a stale click on
      // an id that never existed) is dropped here rather than kept pending
      // indefinitely — deliberately matching the ?session= deep-link
      // effect's own equivalent lookup, which has the same drop semantics
      // once its gates are satisfied (Hermes review, third pass).
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      pendingPushSessionIdRef.current = null;
      if (session && session.status !== "killed") {
        // Issue #1429 — a push click used to open the session's terminal
        // without ever clearing its unread badge, unlike every other "tap a
        // notification" path (the bell rows, the phone sheet).
        useDashboardStore.getState().markSessionRead(session.id);
        // Issue #1430 — a push click is a real, explicit open.
        useDashboardStore.getState().ackAttention(session.id);
        onOpenSessionRef.current(session);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "mullion-open-session") return;
      pendingPushSessionIdRef.current = event.data.sessionId;
      tryOpenPendingSession();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    tryOpenPendingSession();
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      // Each effect incarnation owns its own timer — clearing here (both on
      // unmount and whenever a dependency change re-runs this effect) so a
      // stale timer never fires a tryOpenPendingSession closure built from
      // an outdated dockviewApi/activeWorkspaceId/sessionsLoaded.
      if (pushRetryTimerRef.current != null) {
        clearTimeout(pushRetryTimerRef.current);
        pushRetryTimerRef.current = null;
      }
    };
  }, [
    dockviewApi,
    activeWorkspaceId,
    sessionsLoaded,
    // See useAutoOpenChildPanels.ts's comment on why these two are listed
    // here despite never changing identity.
    restoringRef,
    restoredWorkspaceIdRef,
  ]);
}
