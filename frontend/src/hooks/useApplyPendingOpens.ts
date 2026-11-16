import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { DockviewApi } from "dockview-react";
import { api as http } from "../api/index.js";
import type { PendingOpen, Project, Session } from "../api/index.js";
import { terminalCellPx } from "../dock/dockHelpers.js";
import type { LayoutPresentation } from "../lib/layoutTier.js";
import { isTiledGroup, placePendingOpen } from "../panelUtils.js";
import type { GroupRect } from "../panelUtils.js";
import { initialPaneTitle } from "../paneTitle.js";
import { useDashboardStore } from "../store/index.js";
import { usePolling } from "./usePolling.js";

// How often a desktop client asks for opens made on the fold or the phone.
// The owner opens a session on the fold, then sits down at the desk: a few
// seconds is soon enough, and a hidden tab does not ask at all.
export const PENDING_OPENS_POLL_MS = 5000;

export interface UseApplyPendingOpensParams {
  dockviewApi: DockviewApi | null;
  activeWorkspaceId: number | null;
  presentation: LayoutPresentation;
  sessions: Session[];
  sessionsLoaded: boolean;
  projects: Project[];
  terminalFontSize: number;
  restoringRef: RefObject<boolean>;
  restoredWorkspaceIdRef: RefObject<number | null>;
  /** useWorkspacePersistence's: true while a change would not be saved. */
  isSaveSuspended: () => boolean;
}

// #3033 — a session opened in a workspace on the fold or the phone reaches
// the shared workspace layout. Those clients never save the layout; they
// record the open on the server (useFoldHalves), and this hook, on a desktop
// client showing that workspace, adds the pane with its own dockview API by
// the owner's placement rule (placePendingOpen), then acknowledges it. The
// normal autosave (useWorkspacePersistence) persists the result.
//
// Same gates as useAutoOpenChildPanels: the active workspace's restore has
// finished and `restoringRef` is down (#447: a pane added while it is up is
// taken for the restore's own echo and never saved), plus the save not being
// suspended (a phone or halves presentation, or the phone taint that
// outlives unfolding). An open is added, then acknowledged; the acknowledge
// is one atomic delete on the server, and a pane already present is only
// acknowledged, so a failed acknowledge heals on the next poll and a second
// desktop tab adds nothing once the pane reaches its layout. Two desktop tabs
// on the same workspace that both poll before either acknowledges each add
// the pane to their own copy of the layout; the saved layout holds it once.
export function useApplyPendingOpens({
  dockviewApi,
  activeWorkspaceId,
  presentation,
  sessions,
  sessionsLoaded,
  projects,
  terminalFontSize,
  restoringRef,
  restoredWorkspaceIdRef,
  isSaveSuspended,
}: UseApplyPendingOpensParams): void {
  const [pending, setPending] = useState<{ workspaceId: number; opens: PendingOpen[] } | null>(
    null,
  );
  // Opens this client is acknowledging now, so a re-run of the effect does
  // not add the same pane twice while the request is in flight.
  const handled = useRef<Set<string>>(new Set());
  const desktop = presentation === "grid";

  usePolling(
    (isCancelled) => {
      const workspaceId = activeWorkspaceId;
      if (workspaceId === null) return;
      http
        .listPendingOpens(workspaceId)
        .then((opens) => {
          if (isCancelled()) return;
          // An empty list again changes nothing: no re-render every poll.
          setPending((prev) =>
            prev?.workspaceId === workspaceId && prev.opens.length === 0 && opens.length === 0
              ? prev
              : { workspaceId, opens },
          );
        })
        .catch(() => {
          // A failed poll is retried on the next tick.
        });
    },
    PENDING_OPENS_POLL_MS,
    {
      enabled: desktop && activeWorkspaceId !== null,
      pauseWhenHidden: true,
      deps: [activeWorkspaceId],
    },
  );

  // #3122 — a closed panel loses its "new" mark. A move between groups does
  // not fire onDidRemovePanel (dockview skips it while moving), so a pane
  // dragged elsewhere keeps its mark until it is shown.
  useEffect(() => {
    if (!dockviewApi) return;
    const disposable = dockviewApi.onDidRemovePanel((panel) => {
      useDashboardStore.getState().clearPanelNew(panel.id);
    });
    return () => disposable.dispose();
  }, [dockviewApi]);

  useEffect(() => {
    if (!dockviewApi || !pending || !desktop || !sessionsLoaded) return;
    const workspaceId = pending.workspaceId;
    if (workspaceId !== activeWorkspaceId) return;
    if (restoredWorkspaceIdRef.current !== workspaceId || restoringRef.current) return;
    if (isSaveSuspended()) return;

    const keyOf = (open: PendingOpen) => `${workspaceId}:${open.sessionId}`;
    // Forget what the server no longer lists: acknowledged, or withdrawn.
    const listed = new Set(pending.opens.map(keyOf));
    for (const key of handled.current) {
      if (key.startsWith(`${workspaceId}:`) && !listed.has(key)) handled.current.delete(key);
    }

    for (const open of pending.opens) {
      const key = keyOf(open);
      if (handled.current.has(key)) continue;
      const session = sessions.find((s) => s.id === open.sessionId);
      // Not in this client's list yet (a session created on the fold a moment
      // ago): wait for the sessions poll. A killed session's opens are dropped
      // on the server when it is killed.
      if (!session) continue;
      handled.current.add(key);
      const panelId = `session-${session.id}`;
      try {
        if (session.status === "active" && !dockviewApi.getPanel(panelId)) {
          addPendingPanel(dockviewApi, session, open, projects, terminalFontSize);
          // #3122 — added in the background: PaneTab marks it "new" until it
          // is first shown here.
          useDashboardStore.getState().markPanelNew(panelId);
        }
      } catch (err) {
        // A failed add (a group gone mid-change) is not acknowledged: the
        // next poll tries it again, as after a failed acknowledge.
        handled.current.delete(key);
        console.warn("[pending-opens] could not add the pane", err);
        continue;
      }
      http.acknowledgePendingOpen(workspaceId, session.id).catch(() => handled.current.delete(key));
    }
  }, [
    pending,
    sessions,
    sessionsLoaded,
    dockviewApi,
    activeWorkspaceId,
    desktop,
    projects,
    terminalFontSize,
    restoringRef,
    restoredWorkspaceIdRef,
    isSaveSuspended,
  ]);
}

function groupRects(api: DockviewApi): GroupRect[] {
  return api.groups.filter(isTiledGroup).map((group) => {
    const r = group.element.getBoundingClientRect();
    return { id: group.id, x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

function addPendingPanel(
  api: DockviewApi,
  session: Session,
  open: PendingOpen,
  projects: Project[],
  fontSize: number,
): void {
  const referencePanel =
    open.referenceSessionId === null
      ? undefined
      : api.getPanel(`session-${open.referenceSessionId}`);
  const placement = placePendingOpen({
    groups: groupRects(api),
    referenceGroupId: referencePanel?.group?.id ?? null,
    activeGroupId: api.activeGroup?.id ?? null,
    metrics: terminalCellPx(fontSize),
  });
  const referenceGroup = placement ? api.getGroup(placement.referenceGroup) : undefined;
  const position =
    placement && referenceGroup
      ? "tab" in placement
        ? { referenceGroup, direction: "within" as const }
        : { referenceGroup, direction: placement.direction }
      : undefined;
  const projectName = projects.find((p) => p.id === session.projectId)?.name ?? undefined;
  api.addPanel({
    id: `session-${session.id}`,
    component: "terminal",
    tabComponent: "terminal",
    title: initialPaneTitle(session, projectName),
    params: { sessionId: session.id },
    // The desk keeps showing what it showed (rule 6).
    inactive: true,
    ...(position ? { position } : {}),
  });
}
