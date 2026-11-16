import { useEffect, useRef, useState } from "react";
import type { DockviewApi } from "dockview-react";
import type { IDockviewPanel } from "dockview";
import { EMPTY_FOLD_HALVES, halfOf, paneForPhone, panesToReopen } from "../lib/foldHalves.js";
import type { FoldHalvesState } from "../lib/foldHalves.js";
import type { LayoutPresentation } from "../lib/layoutTier.js";
import { isTiledPanel, sessionIdFromPanelId, setHalvesRouter } from "../panelUtils.js";
import { useDashboardStore } from "../store/index.js";
import { api as http } from "../api/index.js";

function currentHalves(): FoldHalvesState {
  const { foldHalves, activeWorkspaceId } = useDashboardStore.getState();
  return activeWorkspaceId === null
    ? EMPTY_FOLD_HALVES
    : (foldHalves[activeWorkspaceId] ?? EMPTY_FOLD_HALVES);
}

/** Shows a pane on its half: the right half beside the grid, or the left by
 * maximizing its group (the phone's one-pane presentation). */
export function showPaneOnItsHalf(api: DockviewApi, panel: IDockviewPanel): boolean {
  const store = useDashboardStore.getState();
  if (halfOf(currentHalves(), panel.id) === "right") {
    // It becomes the right half's session. A sidebar view covering the half
    // stays: this path also runs for automatic focus (a session asking for
    // attention), and only an explicit tap uncovers the half (App's rail
    // and "To right" handlers close the view themselves).
    store.showRightPane(panel.id);
    if (!store.rightSidebarOpen) store.setFocusedHalf("right");
    return true;
  }
  // A float cannot be maximized; leave it to the ordinary path.
  if (!isTiledPanel(panel)) return false;
  panel.api.setActive();
  api.maximizeGroup(panel);
  store.noteLeftPane(panel.id);
  store.setFocusedHalf("left");
  return true;
}

/** The pane each one-pane presentation should start on (design 9.2): the
 * phone shows the one used last, the halves' left the one it showed. */
export function preferredPaneFor(presentation: LayoutPresentation): string | null {
  const halves = currentHalves();
  if (presentation === "phone") return paneForPhone(halves);
  if (presentation === "halves") {
    return halves.shownLeft !== null && halfOf(halves, halves.shownLeft) === "left"
      ? halves.shownLeft
      : null;
  }
  return null;
}

interface ShownPanes {
  left: string | null;
  right: string | null;
  active: string | null;
}

const NO_SHOWN_PANES: ShownPanes = { left: null, right: null, active: null };

function shownPanes(api: DockviewApi): ShownPanes {
  const halves = currentHalves();
  return { left: halves.shownLeft, right: halves.shownRight, active: api.activePanel?.id ?? null };
}

/**
 * #3033 — records on the server the sessions opened in this workspace on the
 * fold or the phone, for a desktop client to add, and withdraws the ones
 * closed here before it did. Closing stays local otherwise: the desk's pane
 * is not touched. Each open names the session it replaced on its half (the
 * phone: the pane on show before it), which the desk places it beside.
 * Fire and forget: a failed record leaves the session opened here only.
 */
/** The session of a terminal pane (`session-<id>`); null for any other pane,
 * including a session's timeline or browser pane. */
function terminalSessionId(panelId: string | null): number | null {
  const match = panelId?.match(/^session-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function syncPendingOpens(
  workspaceId: number,
  opened: readonly string[],
  closed: readonly string[],
  before: ShownPanes,
): void {
  const halves = currentHalves();
  for (const panelId of opened) {
    const sessionId = terminalSessionId(panelId);
    if (sessionId === null) continue;
    const replaced =
      (halfOf(halves, panelId) === "right" ? before.right : before.left) ?? before.active;
    const referenceSessionId = terminalSessionId(replaced);
    void http
      .recordPendingOpen(
        workspaceId,
        sessionId,
        referenceSessionId === sessionId ? null : referenceSessionId,
      )
      .catch(() => {});
  }
  for (const panelId of closed) {
    const sessionId = terminalSessionId(panelId);
    if (sessionId === null) continue;
    void http.withdrawPendingOpen(workspaceId, sessionId).catch(() => {});
  }
}

// Set by RightSidebar just before it reopens, on unfolding, the view it
// closed for the phone (design 9.2); consumed by the next view-open below.
let viewRestored = false;
export function markViewRestored(): void {
  viewRestored = true;
}

export interface UseFoldHalvesParams {
  dockviewApi: DockviewApi | null;
  presentation: LayoutPresentation;
  activeWorkspaceId: number | null;
  /** Bumped on every layout change (App's panelsVersion). */
  panelsVersion: number;
  /** True once the active workspace's layout has been restored. */
  isRestored: () => boolean;
  /** True once the sessions list has loaded (reopening needs it). */
  sessionsLoaded: boolean;
  /** Reopens a session's pane in the grid (App's openSessionPanel). False
   *  when the session is gone or ended. */
  reopenSession: (sessionId: number) => boolean;
}

// #3010 — the two halves between 800 and 1099px. Registers the router every
// focus/open path consults, keeps the device-local assignment in step with
// the panes actually open, and keeps a left-half pane on show on the left.
// None of it touches the saved layout: saves are suspended while the halves
// are on screen (useWorkspacePersistence).
export function useFoldHalves({
  dockviewApi,
  presentation,
  activeWorkspaceId,
  panelsVersion,
  isRestored,
  sessionsLoaded,
  reopenSession,
}: UseFoldHalvesParams): void {
  // The workspace whose remembered panes were reopened after its restore.
  const reopenedFor = useRef<number | null>(null);
  // The panes seen open last time, per workspace: a pane gone since then was
  // closed and is forgotten. The first look after a workspace (re)loads only
  // records, since a restored layout lacks what the halves opened.
  const lastSeen = useRef<{
    workspaceId: number | null;
    ids: string[] | null;
    // The panes on show at that look: a session opened since replaced one
    // of them (#3033's reference session).
    shown: ShownPanes;
  }>({
    workspaceId: null,
    ids: null,
    shown: NO_SHOWN_PANES,
  });
  // The restore marks itself done a tick after it bumps panelsVersion, so the
  // effect below can run while it still reads "restoring": it checks again
  // shortly, a bounded number of times per workspace.
  const [retryTick, setRetryTick] = useState(0);
  const retries = useRef<{ workspaceId: number | null; count: number }>({
    workspaceId: null,
    count: 0,
  });
  const active = presentation === "halves";
  const rightKey = useDashboardStore((s) =>
    s.activeWorkspaceId === null ? "" : (s.foldHalves[s.activeWorkspaceId]?.right ?? []).join(","),
  );
  const viewOpen = useDashboardStore((s) => s.rightSidebarOpen);

  useEffect(() => {
    useDashboardStore.getState().setFoldHalvesActive(active);
    if (!active) return;
    setHalvesRouter(showPaneOnItsHalf);
    return () => {
      setHalvesRouter(null);
      useDashboardStore.getState().setFoldHalvesActive(false);
    };
  }, [active]);

  // Forget panes that closed. Only against a restored layout: mid-restore the
  // grid is briefly empty.
  //
  // The halves never save the layout, so first, once per restore, reopen the
  // sessions this device had open here (after a reload, or coming back to
  // the workspace). Quietly: the router is off meanwhile, so reopening does
  // not change which pane each half shows.
  useEffect(() => {
    if (!dockviewApi || activeWorkspaceId === null) return;
    if (!isRestored()) {
      if (retries.current.workspaceId !== activeWorkspaceId) {
        retries.current = { workspaceId: activeWorkspaceId, count: 0 };
      }
      if (retries.current.count >= 40) return;
      retries.current.count += 1;
      const timer = setTimeout(() => setRetryTick((t) => t + 1), 50);
      return () => clearTimeout(timer);
    }
    if (!active) {
      reopenedFor.current = null;
    } else if (reopenedFor.current !== activeWorkspaceId) {
      if (!sessionsLoaded) return;
      reopenedFor.current = activeWorkspaceId;
      const missing = panesToReopen(
        currentHalves(),
        dockviewApi.panels.map((p) => p.id),
      );
      if (missing.length > 0) {
        const gone: string[] = [];
        setHalvesRouter(null);
        try {
          for (const panelId of missing) {
            const sessionId = sessionIdFromPanelId(panelId);
            if (sessionId === null || !reopenSession(sessionId)) gone.push(panelId);
          }
        } finally {
          setHalvesRouter(showPaneOnItsHalf);
        }
        // A session that ended meanwhile cannot come back: forget it.
        useDashboardStore.getState().forgetFoldPanes(gone);
      }
      // The panes as reopened are the baseline for spotting closes.
      lastSeen.current = { workspaceId: null, ids: null, shown: NO_SHOWN_PANES };
    }
    const store = useDashboardStore.getState();
    const ids = dockviewApi.panels.map((p) => p.id);
    const seen = lastSeen.current;
    if (seen.workspaceId === activeWorkspaceId && seen.ids !== null) {
      const closed = seen.ids.filter((id) => !ids.includes(id));
      store.forgetFoldPanes(closed);
      // #3033 — a session opened here reaches the shared workspace: the
      // desk adds its pane (useApplyPendingOpens). Only a pane seen opening
      // counts, not one reopened from this device's memory after a restore
      // (the baseline above already holds those), and only off the desk:
      // a grid client saves its own layout.
      if (presentation !== "grid") {
        const opened = ids.filter((id) => !seen.ids!.includes(id));
        syncPendingOpens(activeWorkspaceId, opened, closed, seen.shown);
      }
    }
    lastSeen.current = { workspaceId: activeWorkspaceId, ids, shown: shownPanes(dockviewApi) };
    if (active) store.noteFoldOpen(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panelsVersion is the layout-change signal
  }, [
    dockviewApi,
    panelsVersion,
    activeWorkspaceId,
    active,
    sessionsLoaded,
    retryTick,
    presentation,
  ]);

  // The left half always shows a left-half pane: after a restore, a move to
  // the right, or the shown pane closing.
  useEffect(() => {
    if (!active || !dockviewApi || !isRestored()) return;
    let halves = currentHalves();
    // #3053 — the left half is never empty while a pane is open. moveToHalf
    // refuses a move that would empty it, but closing the last left pane, or
    // a stale stored assignment on load, can leave every tiled pane on the
    // right: the right half's shown pane (else its first) moves left. On load
    // only once the remembered panes are back, which may include a left one.
    if (reopenedFor.current === activeWorkspaceId) {
      const tiled = dockviewApi.panels.filter(isTiledPanel);
      if (tiled.length > 0 && tiled.every((p) => halfOf(halves, p.id) === "right")) {
        const promote = tiled.find((p) => p.id === halves.shownRight) ?? tiled[0]!;
        const wasShown = promote.id === halves.shownRight;
        const store = useDashboardStore.getState();
        store.moveToHalf(
          promote.id,
          "left",
          tiled.map((p) => p.id),
        );
        store.setFocusedHalf("left");
        halves = currentHalves();
        // The right half showed the pane that moved: it falls back to the
        // one still assigned to it that went there last, rather than blank.
        if (wasShown && halves.right.length > 0) {
          store.showRightPane(halves.right.at(-1)!);
          halves = currentHalves();
        }
      }
    }
    const current = dockviewApi.activePanel;
    // The active panel's own group must be the maximized one: a bare
    // setActive() elsewhere can leave another group maximized on screen.
    const ownGroupShown =
      current !== null &&
      current !== undefined &&
      dockviewApi.hasMaximizedGroup() &&
      (current.group?.api.isMaximized?.() ?? true);
    if (
      current &&
      isTiledPanel(current) &&
      halfOf(halves, current.id) === "left" &&
      ownGroupShown
    ) {
      useDashboardStore.getState().noteLeftPane(current.id, false);
      return;
    }
    const left = dockviewApi.panels.filter(
      (p) => isTiledPanel(p) && halfOf(halves, p.id) === "left",
    );
    // A left pane just made active (a bare setActive() elsewhere) wins over
    // the one remembered; else the remembered one, else the first.
    const target =
      (current && left.find((p) => p.id === current.id)) ??
      left.find((p) => p.id === halves.shownLeft) ??
      left[0];
    if (!target) return;
    target.api.setActive();
    dockviewApi.maximizeGroup(target);
    useDashboardStore.getState().noteLeftPane(target.id, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panelsVersion is the layout-change signal
  }, [active, dockviewApi, panelsVersion, activeWorkspaceId, rightKey, retryTick, sessionsLoaded]);

  // Opening a sidebar view is "using" it, for the phone after folding. Not
  // when unfolding put back a view the fold closed (markViewRestored): the
  // session was used last, and a second fold should show it again.
  useEffect(() => {
    // A flag armed while the halves are not on screen is stale: it must not
    // swallow the next genuine view-open once they are.
    if (!active) viewRestored = false;
    if (!active || !viewOpen) return;
    if (viewRestored) {
      viewRestored = false;
      return;
    }
    useDashboardStore.getState().noteHalfUsed({ kind: "view" });
  }, [active, viewOpen]);
}
