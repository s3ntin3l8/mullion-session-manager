import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { DockviewApi } from "dockview-react";
import type { Session } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

export interface UseOpenSessionRequestParams {
  dockviewApi: DockviewApi | null;
  activeWorkspaceId: number | null;
  sessionsLoaded: boolean;
  sessions: Session[];
  onOpenSession: (session: Session) => void;
  restoringRef: MutableRefObject<boolean>;
  restoredWorkspaceIdRef: MutableRefObject<number | null>;
}

// Extracted alongside useSessionDeepLink.ts (issue #1429) — resolves
// store/slices/ui.ts's requestOpenSession "intent": a desktop OS
// notification's onclick handler (useAttentionNotifications.ts) has no
// direct access to onOpenSession (App.tsx's usePanelOpener owns it), so it
// goes through this store request instead. Same gates/retry shape as
// useSessionDeepLink.ts's own effect (dockviewApi/workspace-restored/
// sessionsLoaded/!restoringRef.current, a setTimeout(0) retry while
// restoring) — see that hook's own header comment for the load-bearing
// ordering/macrotask argument, which applies here identically: this hook
// too must be called AFTER useWorkspacePersistence(...) in App.tsx's
// render body, with the SAME restoringRef/restoredWorkspaceIdRef objects.
//
// Deliberately its own resolvedNonceRef/retry state, not App.tsx's own
// push-message effect's pendingPushSessionIdRef/pushRetryTimerRef: that
// effect returns early with no service worker at all, which has nothing to
// do with this in-app path, and sharing its ref would let an open-session
// request silently clobber a push click still mid-retry.
export function useOpenSessionRequest({
  dockviewApi,
  activeWorkspaceId,
  sessionsLoaded,
  sessions,
  onOpenSession,
  restoringRef,
  restoredWorkspaceIdRef,
}: UseOpenSessionRequestParams): void {
  const openSessionRequest = useDashboardStore((s) => s.openSessionRequest);
  // Only ever advances to the LATEST resolved nonce — a request whose gates
  // aren't satisfied yet must not be treated as handled just because this
  // effect happened to re-run for an unrelated dependency change (e.g.
  // sessionsLoaded flipping while a workspace restore is still in flight).
  const resolvedNonceRef = useRef(0);
  // Forces a retry once restoringRef.current flips false, mirroring
  // useSessionDeepLink.ts's own deepLinkRetryTick — a bare ref write
  // triggers no re-render on its own.
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!openSessionRequest || openSessionRequest.nonce === resolvedNonceRef.current) return;
    const workspaceRestored =
      activeWorkspaceId !== null && restoredWorkspaceIdRef.current === activeWorkspaceId;
    if (!dockviewApi || !workspaceRestored || !sessionsLoaded) return;
    if (restoringRef.current) {
      const timer = setTimeout(() => setRetryTick((t) => t + 1), 0);
      return () => clearTimeout(timer);
    }

    // Self-review — resolvedNonceRef must NOT be set here (synchronously,
    // before the deferred call below actually runs): sessions gets a fresh
    // identity on effectively every relevant tick (App.tsx's own push-
    // message effect has the identical comment), which is exactly this
    // effect's own dependency list. If a tick like that lands in the gap
    // between scheduling the timer below and it firing, cleanup clears the
    // timer — the request is never actually delivered — and marking the
    // nonce resolved too early would make the NEXT run of this effect
    // silently give up instead of retrying, permanently dropping the
    // request. Setting it inside the timeout instead means a request is
    // only ever considered resolved once it's actually been acted on (or
    // definitively dropped for a missing/killed session), so a cleared
    // timer always gets a fresh retry.
    const nonce = openSessionRequest.nonce;
    const sessionId = openSessionRequest.sessionId;
    const timer = setTimeout(() => {
      resolvedNonceRef.current = nonce;
      const session = sessions.find((s) => s.id === sessionId);
      // A session id that isn't found (killed/reaped between the click and
      // resolution, or a stale click on an id that never existed) is
      // dropped here — matching the push-message and ?session= deep-link
      // effects' own equivalent lookups.
      if (session && session.status !== "killed") {
        useDashboardStore.getState().markSessionRead(session.id);
        onOpenSession(session);
      }
    }, 0);
    // Cleaned up on unmount, same reasoning as useSessionDeepLink.ts's own
    // timer: onOpenSession reads dockviewApi by closure and would otherwise
    // run against a torn-down instance if unmount lands inside this window.
    return () => clearTimeout(timer);
  }, [
    openSessionRequest,
    dockviewApi,
    activeWorkspaceId,
    sessionsLoaded,
    sessions,
    onOpenSession,
    retryTick,
    restoringRef,
    restoredWorkspaceIdRef,
  ]);
}
