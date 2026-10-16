import { useState } from "react";
import { useDashboardStore } from "../store/index.js";
import { resolveActiveProjectId } from "../panelUtils.js";

// Sentinel Dropdown value meaning "go back to following the active panel" —
// distinct from any real project id (Dropdown is generic over string, and
// project ids stringify to plain digits, so this can't collide).
export const FOLLOW_SENTINEL = "__follow__";

export interface FollowedProject {
  effectiveProjectId: number | null;
  pinnedProjectId: number | null;
  setPinnedProjectId: (id: number | null) => void;
  dropdownOptions: { value: string; label: string }[];
  dropdownValue: string;
  onDropdownChange: (value: string) => void;
}

// Which project a project-scoped surface (SourceControlSection, the right
// sidebar) should show. Extracted from SourceControlSection so the sidebar
// can resolve it once for every view instead of each view re-deriving it.
export function useFollowedProject(): FollowedProject {
  const projects = useDashboardStore((s) => s.projects);
  const sessions = useDashboardStore((s) => s.sessions);
  const activePanelId = useDashboardStore((s) => s.activePanelId);

  // Pin (explicit user choice via the picker) and follow (the dockview
  // panel currently in focus) are deliberately separate pieces of state —
  // collapsing them into one would mean focusing a panel in another project
  // silently clobbers a pin. `lastDerivedId` exists only so the section
  // doesn't blank out when a non-project panel (Settings, Tasks) is
  // focused. Resolution order: pin > derived > last-derived > first project.
  //
  // Adjusts state during render (React's own recommended pattern — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  // and Sidebar.tsx's own promoteOpen/prevPromoteState for the identical
  // shape) rather than a `useEffect` + setState, which the project's lint
  // config (react-hooks/set-state-in-effect) rejects as a cascading-render
  // risk.
  const [pinnedProjectId, setPinnedProjectId] = useState<number | null>(null);
  // Issue #1136 — only trust a derived id that names a project we actually
  // have. `resolveActiveProjectId` can return an id for a project that
  // hasn't loaded yet: on a cold load the restored dockview layout sets
  // `activePanelId` while `projects` is still `[]` (store/slices/events.ts's
  // WS-driven refreshSessions() can populate `sessions` well before
  // refreshProjects() resolves, and a 429 on the latter leaves `projects`
  // at `[]` for even longer). Without this guard, the "adopt derived id"
  // adjustment below and the "release id no longer in projects" guard
  // after it write `lastDerivedId` with overlapping predicates — when
  // `derivedId` is absent from `projects`, each one's postcondition
  // satisfies the other's precondition, and since render-phase re-renders
  // are synchronous (`projects` can't change between iterations) they spin
  // forever and React throws "Too many re-renders" (error #301).
  // Validating here keeps the two disjoint: the adopt guard only fires when
  // `derivedId ∈ projects`, the release guard only when
  // `lastDerivedId ∉ projects` — never both on the same value.
  const rawDerivedId = resolveActiveProjectId(activePanelId, sessions);
  const derivedId =
    rawDerivedId != null && projects.some((p) => p.id === rawDerivedId) ? rawDerivedId : null;
  const [lastDerivedId, setLastDerivedId] = useState<number | null>(derivedId);
  if (derivedId != null && derivedId !== lastDerivedId) {
    setLastDerivedId(derivedId);
  }

  // A pinned or last-derived project can be deleted out from under this
  // section (Hermes review, PR #506) — release it rather than let the
  // Dropdown's value keep pointing at an option that no longer exists and
  // the body keep showing a project that's gone. `derivedId` doesn't need
  // this guard: unlike `pinnedProjectId`/`lastDerivedId` (state, so it can
  // go stale across renders), `derivedId` is validated against `projects`
  // membership above (issue #1136) on every render it's computed — it is
  // never held as stale state. Recomputing "fresh" alone is NOT why it's
  // safe (that reasoning is exactly what issue #1136 disproved: a fresh
  // recompute from `sessions` can still name a project that hasn't loaded
  // into `projects` yet) — the membership check is load-bearing.
  if (pinnedProjectId != null && !projects.some((p) => p.id === pinnedProjectId)) {
    setPinnedProjectId(null);
  }
  if (lastDerivedId != null && !projects.some((p) => p.id === lastDerivedId)) {
    setLastDerivedId(null);
  }

  const effectiveProjectId =
    pinnedProjectId ?? derivedId ?? lastDerivedId ?? projects[0]?.id ?? null;
  // While following, the option names the project actually on screen; once
  // pinned it reads as the action that releases the pin.
  // Only a real follow source counts — the first-project fallback isn't
  // "following" anything.
  const followSourceId = derivedId ?? lastDerivedId;
  const followedName = projects.find((p) => p.id === followSourceId)?.name;
  const followLabel =
    pinnedProjectId == null && followedName ? `Following: ${followedName}` : "Follow active panel";
  const dropdownOptions = [
    { value: FOLLOW_SENTINEL, label: followLabel },
    ...projects.map((p) => ({ value: String(p.id), label: p.name })),
  ];
  const dropdownValue = pinnedProjectId != null ? String(pinnedProjectId) : FOLLOW_SENTINEL;
  const onDropdownChange = (v: string) =>
    setPinnedProjectId(v === FOLLOW_SENTINEL ? null : Number.parseInt(v, 10));

  return {
    effectiveProjectId,
    pinnedProjectId,
    setPinnedProjectId,
    dropdownOptions,
    dropdownValue,
    onDropdownChange,
  };
}
