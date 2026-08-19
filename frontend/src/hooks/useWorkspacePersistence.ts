import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { DockviewApi } from "dockview-react";
import { useDashboardStore } from "../store/index.js";
import type { Workspace } from "../api/index.js";
import { serializeForPersist, applyLayoutPresentation, closeLegacyPanels } from "../panelUtils.js";
import type { LayoutTier } from "../lib/layoutTier.js";

const AUTOSAVE_DEBOUNCE_MS = 800;

interface PendingSave {
  // Captured at *schedule* time, not read live at fire time — the load-
  // bearing property that keeps a fast A->B workspace switch from writing
  // A's (or a half-formed) layout into B's row, or vice versa. See the
  // flush call in the restore effect below.
  workspaceId: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface UseWorkspacePersistenceParams {
  dockviewApi: DockviewApi | null;
  activeWorkspaceId: number | null;
  workspaces: Workspace[];
  layoutTier: LayoutTier;
  // App.tsx owns this state (it's also bumped/read by unrelated effects and
  // rendering elsewhere in that component) — passed in rather than owned
  // here so there's still exactly one `panelsVersion` in the tree. Must be
  // the raw `useState` setter (stable identity forever) — an inline wrapper
  // (e.g. `(v) => setPanelsVersion(v)`) would get a fresh identity every
  // render and, being read in the autosave effect's dependency array,
  // re-subscribe `onDidLayoutChange` on every render.
  setPanelsVersion: Dispatch<SetStateAction<number>>;
}

export interface UseWorkspacePersistenceResult {
  // True only while a programmatic fromJSON() restore is in flight, so the
  // onDidLayoutChange events it fires aren't mistaken for a real edit and
  // echoed back into an autosave. Read by other effects that must not act
  // while a restore is still settling: the auto-open-child-panel effect and
  // the push-message effect (both still in App.tsx), plus useSessionDeepLink
  // (hooks/useSessionDeepLink.ts, PR 34g of the hook-extraction series —
  // extracted OUT of App.tsx, but still threaded this exact ref through as a
  // param) — returned here (rather than kept private) so those consumers can
  // keep sharing the exact same ref this hook's own restore effect writes to.
  restoringRef: MutableRefObject<boolean>;
  // Which workspace id the grid currently reflects a restore for. Lets the
  // restore effect safely list `workspaces` as a dependency (needed so it
  // retries once the initial fetch resolves, if dockviewApi became ready
  // first and saw an empty list) without re-restoring — and blowing away
  // in-progress edits — every time `workspaces` changes for an unrelated
  // reason (e.g. renaming some other workspace). Also read by the same set
  // of consumers listed above, to gate on "the CURRENT workspace's saved
  // layout has actually been applied" before acting.
  restoredWorkspaceIdRef: MutableRefObject<number | null>;
}

// Extracted from App.tsx (PR 34a of the hook-extraction series) — restores
// the active workspace's saved dockview layout on mount/workspace-switch,
// and autosaves layout changes back as they happen. Effect ordering here is
// load-bearing: App.tsx calls this hook at the exact same point in its
// render body that these two effects previously occupied, so their
// execution order relative to every other effect in App.tsx (in particular,
// the auto-open-child-panel/push-message effects further down in App.tsx,
// and useSessionDeepLink's own effect — hooks/useSessionDeepLink.ts, PR 34g,
// called from App.tsx after this hook — all of which read
// `restoringRef`/`restoredWorkspaceIdRef` and must observe a restore that
// has already run) is unchanged. See those consumers' own comments for why
// they depend on this ordering.
export function useWorkspacePersistence({
  dockviewApi,
  activeWorkspaceId,
  workspaces,
  layoutTier,
  setPanelsVersion,
}: UseWorkspacePersistenceParams): UseWorkspacePersistenceResult {
  const restoringRef = useRef(false);
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const restoredWorkspaceIdRef = useRef<number | null>(null);

  const flushPendingSave = useCallback((api: DockviewApi) => {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSaveRef.current = null;
    // Read *before* the caller clears/replaces the grid — this is still
    // the outgoing workspace's own layout at this point. Issue #85: goes
    // through serializeForPersist (not raw api.toJSON()) so a
    // workspace-switch save strips floating panels AND maximization the
    // same way the debounced scheduleSave below does — this previously
    // wrote the raw blob and leaked both.
    void useDashboardStore
      .getState()
      .saveWorkspaceLayout(
        pending.workspaceId,
        serializeForPersist(api) as unknown as Record<string, unknown>,
      );
  }, []);

  const scheduleSave = useCallback((api: DockviewApi, workspaceId: number) => {
    if (pendingSaveRef.current) clearTimeout(pendingSaveRef.current.timer);
    const timer = setTimeout(() => {
      pendingSaveRef.current = null;
      const serialized = serializeForPersist(api);
      void useDashboardStore
        .getState()
        .saveWorkspaceLayout(workspaceId, serialized as unknown as Record<string, unknown>);
    }, AUTOSAVE_DEBOUNCE_MS);
    pendingSaveRef.current = { workspaceId, timer };
  }, []);

  // Restore the active workspace's saved layout whenever it changes
  // (including the first time dockview itself becomes ready). `workspaces`
  // is deliberately in the dependency array — dockviewApi frequently becomes
  // ready before the initial refreshWorkspaces() fetch resolves, and without
  // it this effect would see an empty list, bail out once, and never get a
  // second chance to run once the real data arrived. The
  // restoredWorkspaceIdRef guard is what keeps that from also re-restoring
  // (and fighting in-progress edits) on every unrelated `workspaces` refetch,
  // e.g. after renaming some other workspace.
  useEffect(() => {
    if (!dockviewApi || activeWorkspaceId === null) return;
    if (restoredWorkspaceIdRef.current === activeWorkspaceId) return;
    const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!workspace) return;

    // Flush the OUTGOING workspace's pending autosave synchronously before
    // tearing down its layout below.
    flushPendingSave(dockviewApi);

    restoringRef.current = true;
    let closedKilledPanels = false;
    let closedLegacyPanels = false;
    try {
      dockviewApi.clear();
      if (workspace.layout) {
        dockviewApi.fromJSON(workspace.layout as unknown as Parameters<DockviewApi["fromJSON"]>[0]);
      }
      // Remove any panels that reference killed sessions — the restored
      // layout may have been saved before those sessions were killed.  This
      // catches stale layouts; the reactive `useEffect` below (commented
      // "Close any dockview panel whose session has been killed") catches
      // the case where sessions haven't loaded yet at this point.
      const currentSessions = useDashboardStore.getState().sessions;
      const stalePanelIds: string[] = [];
      for (const panel of dockviewApi.panels) {
        let sessionId = (panel.params as { sessionId?: number } | undefined)?.sessionId;
        if (sessionId == null) {
          const match = panel.id.match(/^(?:timeline|browserPane)-(\d+)$/);
          if (match) sessionId = parseInt(match[1], 10);
        }
        if (sessionId != null) {
          const session = currentSessions.find((s) => s.id === sessionId);
          if (panel.id.startsWith("session-")) {
            if (session?.status === "killed") {
              stalePanelIds.push(panel.id);
            }
          } else if (panel.id.startsWith("timeline-") || panel.id.startsWith("browserPane-")) {
            if (!session || session.status === "killed" || session.status === "exited") {
              stalePanelIds.push(panel.id);
            }
          }
        }
      }
      if (stalePanelIds.length > 0) {
        closedKilledPanels = true;
        for (const id of stalePanelIds) {
          dockviewApi.getPanel(id)?.api.close();
        }
      }
      // Self-heals a restored "tasks" panel away (see TasksPanelRedirect.tsx
      // and panelUtils.ts's own doc comments) — kept as its own flag rather
      // than folded into closedKilledPanels above since the two sweeps close
      // panels for unrelated reasons.
      closedLegacyPanels = closeLegacyPanels(dockviewApi);
    } catch (err) {
      // A corrupt or version-incompatible layout blob must never brick the
      // whole dashboard — this runs outside any panel's own ErrorBoundary,
      // since it's not inside a panel at all. Fall back to an empty grid.
      console.error("[workspace] failed to restore layout, resetting to empty grid", err);
      dockviewApi.clear();
    } finally {
      // fromJSON can fire onDidLayoutChange asynchronously for some panel
      // mount events — give it a tick before re-arming autosave so the
      // restore itself is never echoed back as a save.  If the post-restore
      // cleanup above closed any killed panels, persist the cleaned layout
      // explicitly (the close events were suppressed by restoringRef being
      // true, so the killed panels would otherwise stay in the blob).
      setTimeout(() => {
        restoringRef.current = false;
        if (closedKilledPanels || closedLegacyPanels) {
          scheduleSave(dockviewApi, activeWorkspaceId);
        }
      }, 0);
    }
    // Issue #85 — a layout restored from a blob saved on a different
    // breakpoint (desktop -> mobile, or a stale pre-#85 blob that still
    // carries a persisted maximizedNode) must present per the CURRENT
    // breakpoint, not whatever the blob implies. Deliberately OUTSIDE the
    // try/catch above: if this ever threw, landing in the catch would
    // dockviewApi.clear() and wipe a layout that had just restored
    // successfully. Placed here it's also safe on the error path — clear()
    // leaves an empty grid, and applyLayoutPresentation no-ops on that.
    // Safe regardless of whether restoringRef suppresses this call's own
    // onDidLayoutChange echo, since serializeForPersist strips
    // maximizedNode unconditionally on every future save.
    applyLayoutPresentation(dockviewApi, layoutTier);
    restoredWorkspaceIdRef.current = activeWorkspaceId;
  }, [dockviewApi, activeWorkspaceId, workspaces, flushPendingSave, layoutTier]);

  // Any real layout change (add/remove/move panel, or a splitter-drag
  // resize) schedules a debounced autosave, unless it's the restore
  // effect's own echo. Also bumps panelsVersion so the toolbar/mobile-tabs
  // pane count/list re-render (dockview's own panel list isn't otherwise
  // reactive from React's perspective).
  useEffect(() => {
    if (!dockviewApi || activeWorkspaceId === null) return;
    const workspaceId = activeWorkspaceId;
    const disposable = dockviewApi.onDidLayoutChange(() => {
      setPanelsVersion((v) => v + 1);
      if (restoringRef.current) return;
      scheduleSave(dockviewApi, workspaceId);
    });
    return () => disposable.dispose();
  }, [dockviewApi, activeWorkspaceId, scheduleSave, setPanelsVersion]);

  return { restoringRef, restoredWorkspaceIdRef };
}
