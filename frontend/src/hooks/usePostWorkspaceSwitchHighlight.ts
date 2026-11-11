/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { RefObject } from "react";
import type { DockviewApi } from "dockview-react";
import type { Project, Session } from "../api/index.js";
import type { LayoutContext } from "../lib/layoutTier.js";
import { focusPanelForTier, openSessionPanel } from "../panelUtils.js";
import { useDashboardStore } from "../store/index.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UsePostWorkspaceSwitchHighlightParams {
  dockviewApi: DockviewApi | null;
  activeWorkspaceId: number | null;
  sessions: Session[];
  layout: LayoutContext;
  projects: Project[];
  lastHandledHighlightRef: RefObject<string | null>;
}

export function usePostWorkspaceSwitchHighlight({
  dockviewApi,
  activeWorkspaceId,
  sessions,
  layout,
  projects,
  lastHandledHighlightRef,
}: UsePostWorkspaceSwitchHighlightParams): void {
  // Post-workspace-switch highlight: after a workspace restore creates the
  // target panel, focus it so the highlight flash is visible. Guarded by
  // lastHandledHighlightRef (keyed on the panel id itself, not just a
  // boolean) so the fallback's own sessions/layout/projects dependencies
  // — needed to call openSessionPanel with fresh data — don't also make
  // this effect re-run setActive()/openSessionPanel on every 4s live-refresh
  // poll tick that happens to land inside the ~1200ms highlight window
  // (store.ts's HIGHLIGHT_DURATION_MS); a fresh, different highlight still
  // has a different id and proceeds normally.
  useEffect(() => {
    if (!dockviewApi) return;
    const id = useDashboardStore.getState().highlightedPanelId;
    if (!id) {
      lastHandledHighlightRef.current = null;
      return;
    }
    if (lastHandledHighlightRef.current === id) return;
    const panel = dockviewApi.getPanel(id);
    if (panel) {
      focusPanelForTier(dockviewApi, panel, layout.tier);
      lastHandledHighlightRef.current = id;
      return;
    }
    // onOpenSession's cross-workspace branch only guarantees SOME panel
    // referencing this session existed in the target workspace's saved
    // layout — findSessionWorkspaces matches any panel type
    // (panelUtils.ts's extractSessionIds also walks timeline/browserPane's
    // own `sessionIds`), not necessarily this session's own terminal panel.
    // If the restore just completed and the terminal panel still isn't
    // there (e.g. the session was only ever referenced via a timeline
    // panel in that workspace), open it explicitly rather than leaving the
    // user on a workspace that switched but shows nothing for the session
    // they asked for. Safe to call even if a panel materializes moments
    // later from an unrelated cause: openSessionPanel focuses an existing
    // panel instead of duplicating it.
    const match = id.match(/^session-(\d+)$/);
    if (!match) return;
    const sessionId = Number(match[1]);
    const session = sessions.find((s) => s.id === sessionId);
    // Deliberately NOT marked handled when the session isn't found yet —
    // lets a later `sessions` update retry instead of giving up for the
    // rest of this highlight's window.
    if (session) {
      openSessionPanel(dockviewApi, session, layout, projects);
      lastHandledHighlightRef.current = id;
    }
  }, [activeWorkspaceId, dockviewApi, sessions, layout, projects]);
}
