/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { RefObject } from "react";
import type { DockviewApi } from "dockview-react";
import type { AppSettings, Session } from "../api/index.js";
import { attentionTransitionPanelIds, focusPanelForTier } from "../panelUtils.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import { useDashboardStore } from "../store/index.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseAutoFocusOnAttentionParams {
  sessions: Session[];
  settings: AppSettings;
  dockviewApi: DockviewApi | null;
  layoutTier: LayoutTier;
  seenAttentionForFocusRef: RefObject<Set<number>>;
}

export function useAutoFocusOnAttention({
  sessions,
  settings,
  dockviewApi,
  layoutTier,
  seenAttentionForFocusRef,
}: UseAutoFocusOnAttentionParams): void {
  // #98 item 4 — auto-bring-into-focus on the attention transition, opt-in
  // via Settings -> Notifications & status (default off — see api.ts's
  // autoFocusOnAttention doc comment). Deliberately still poll-diff
  // (`sessions.attention`, not the /ws/events stream the desktop-
  // notification effect above migrated to for issue #170): this is a
  // separate feature with its own settled implementation from #98/PR4, and
  // moving it to the event stream too isn't this PR's scope — only the
  // desktop-notification firing was called out for the migration. The
  // transition-detection itself lives in panelUtils.ts's
  // attentionTransitionPanelIds (unit tested there); this effect is just the
  // Settings gate plus the dockviewApi calls.
  useEffect(() => {
    const attentionNow = new Set(sessions.filter((s) => s.attention).map((s) => s.id));
    if (dockviewApi && settings.notifications.autoFocusOnAttention) {
      for (const panelId of attentionTransitionPanelIds(
        sessions,
        seenAttentionForFocusRef.current,
      )) {
        // Per-status autoFocus: the global autoFocusOnAttention toggle AND
        // the per-status matrix column must both be on to auto-focus.
        const session = sessions.find((s) => `session-${s.id}` === panelId);
        if (
          session &&
          !settings.notifications.notificationMatrix[session.sessionStatus]?.autoFocus
        ) {
          continue;
        }
        const target = dockviewApi.getPanel(panelId);
        if (!target) continue;
        // Phone only: leave the Tasks board first (its overlay hides the
        // panes) and maximize, so the pane that needs you is the one on
        // screen. Desktop keeps the plain setActive() it always had.
        if (layoutTier === "phone") useDashboardStore.getState().setViewMode("list");
        focusPanelForTier(dockviewApi, target, layoutTier);
      }
    }
    seenAttentionForFocusRef.current = attentionNow;
  }, [sessions, settings.notifications, dockviewApi, layoutTier]);
}
