/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { RefObject } from "react";
import type { DockviewApi } from "dockview-react";
import type { AppSettings, Project, Session } from "../api/index.js";
import {
  childPanelPosition,
  freshHintedChildIds,
  planAutoOpenChildren,
  shouldAutoOpenChildPanels,
} from "../panelUtils.js";
import { initialPaneTitle } from "../paneTitle.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.
// Must run after useWorkspacePersistence: the body reads restoringRef /
// restoredWorkspaceIdRef, which that hook's restore effect writes.

export interface UseAutoOpenChildPanelsParams {
  sessions: Session[];
  sessionsLoaded: boolean;
  settings: AppSettings;
  dockviewApi: DockviewApi | null;
  activeWorkspaceId: number | null;
  projects: Project[];
  restoringRef: RefObject<boolean>;
  restoredWorkspaceIdRef: RefObject<number | null>;
  seenChildSessionIdsRef: RefObject<Set<number>>;
  hasSeededChildSessionsRef: RefObject<boolean>;
}

export function useAutoOpenChildPanels({
  sessions,
  sessionsLoaded,
  settings,
  dockviewApi,
  activeWorkspaceId,
  projects,
  restoringRef,
  restoredWorkspaceIdRef,
  seenChildSessionIdsRef,
  hasSeededChildSessionsRef,
}: UseAutoOpenChildPanelsParams): void {
  // Phase 5 (Track B, issue #194 5.4) — this codebase's first
  // backend-state-driven panel ADD (every other effect here only
  // setActive()s or close()s an already-open panel; see
  // useCloseKilledSessionPanels.ts for that pattern). Opt-in via
  // settings.sessions.autoOpenChildPanels (default false) — a spawned child
  // always shows in the sidebar regardless of this flag; this only governs
  // whether ITS PANEL opens with no user gesture behind it. Detection
  // itself lives in panelUtils.ts's newChildSessionIds (unit tested there,
  // same "poll-diff transition, own Set" shape as attentionTransitionPanelIds
  // in useAutoFocusOnAttention.ts) — this effect is just the Settings gate
  // plus the dockviewApi calls, with no local state of its own (no setState
  // anywhere in this effect body — see this repo's
  // react-hooks/set-state-in-effect lint rule).
  //
  // Independent review finding (PR #430) — gated on the workspace-restore
  // effect in useWorkspacePersistence.ts having already applied the CURRENT
  // workspace's saved layout (restoredWorkspaceIdRef.current ===
  // activeWorkspaceId), not just on dockviewApi existing. Without this, a
  // panel opened here in the narrow window before restore completes gets
  // silently wiped by that effect's dockviewApi.clear()+fromJSON() a moment
  // later — and since this child's id is already recorded as "seen", it would
  // never be retried.
  // Issue #447 fix — `restoredWorkspaceIdRef` is set synchronously at the
  // end of that effect's body, one render before its OWN
  // `restoringRef.current = false` fires (deferred via `setTimeout`) — so
  // `workspaceRestored` can read true for one tick while
  // `restoringRef.current` is still true. On a workspace SWITCH, if a
  // brand-new child happens to arrive in that exact same tick, its
  // `addPanel()` call here would otherwise fire while the "any real layout
  // change" autosave effect in useWorkspacePersistence.ts still treats every
  // change as the restore's own echo (`restoringRef.current`), so the panel's
  // addition would never persist and the child's panel would silently not
  // survive a reload. `shouldAutoOpenChildPanels` (panelUtils.ts) folds in
  // `!restoringRef.current` to skip entirely during that window. This
  // self-heals with no extra bookkeeping: `seenChildSessionIdsRef` is only
  // advanced inside this same gated branch (see below), so a child skipped
  // here is still
  // correctly detected as new the next tick once restoring flips false.
  //
  // Independent review finding #2 (PR #430) — also gated on `sessionsLoaded`.
  // `sessions` starts as `[]` before the first GET /api/sessions resolves,
  // and that has nothing to do with workspace restore or dockviewApi
  // readiness — all three gates can line up true on a render where
  // `sessions` just hasn't arrived yet. Seeding against that empty list
  // would make every pre-existing live child look "new" the very next tick
  // (once the real list loads) and force-open all of their panels at once,
  // reproducing the bug this seed exists to prevent.
  useEffect(() => {
    const workspaceRestored =
      activeWorkspaceId !== null && restoredWorkspaceIdRef.current === activeWorkspaceId;
    if (
      shouldAutoOpenChildPanels({
        workspaceRestored,
        hasDockviewApi: dockviewApi !== null,
        // A spawn-time `open` hint opens its own child even with the setting
        // off, so the gate must let the effect run when any child carries one
        // (the per-child decision is childWantsAutoOpen below).
        autoOpenChildPanels:
          settings.sessions.autoOpenChildPanels ||
          freshHintedChildIds(sessions, Date.now()).size > 0,
        sessionsLoaded,
        restoring: restoringRef.current,
      })
    ) {
      // dockviewApi is guaranteed non-null once shouldAutoOpenChildPanels
      // returns true (hasDockviewApi check above), but its own narrowing
      // doesn't propagate through the helper call — assert it once here so
      // every use below stays non-nullable without a redundant local check.
      const api = dockviewApi!;
      const plan = planAutoOpenChildren({
        sessions,
        previouslySeen: seenChildSessionIdsRef.current,
        seeded: hasSeededChildSessionsRef.current,
        autoOpenChildPanels: settings.sessions.autoOpenChildPanels,
        now: Date.now(),
        hasPanel: (panelId) => Boolean(api.getPanel(panelId)),
        positionFor: (child) =>
          childPanelPosition(api, child.parentSessionId!, child.openHint ?? "right"),
      });
      hasSeededChildSessionsRef.current = true;
      for (const { child, position } of plan.toOpen) {
        const projectName = projects.find((p) => p.id === child.projectId)?.name ?? undefined;
        api.addPanel({
          id: `session-${child.id}`,
          component: "terminal",
          tabComponent: "terminal",
          title: initialPaneTitle(child, projectName),
          params: { sessionId: child.id },
          position,
        });
      }
      // Hermes review finding (PR #430) — only advance the "seen" set when
      // this tick actually evaluated the current sessions against the gate
      // above, so a child that arrived while the gate was down is still
      // detected as new once it opens. planAutoOpenChildren also leaves
      // fresh hinted children it didn't open out of the set (retry).
      seenChildSessionIdsRef.current = plan.nextSeen;
    }
  }, [
    sessions,
    sessionsLoaded,
    settings.sessions.autoOpenChildPanels,
    dockviewApi,
    activeWorkspaceId,
    projects,
    // restoringRef/restoredWorkspaceIdRef now come from
    // useWorkspacePersistence's return value rather than a bare useRef() in
    // this component, so eslint's exhaustive-deps rule can no longer
    // statically prove they're stable ref identities and flags them as
    // missing — listed here purely to satisfy the lint rule; both are
    // ordinary refs (mutated in place, never reassigned), so including them
    // has no effect on when this effect re-runs.
    restoringRef,
    restoredWorkspaceIdRef,
  ]);
}
