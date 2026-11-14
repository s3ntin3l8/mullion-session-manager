import { useEffect, useMemo } from "react";
import type { Group, Session, Workspace } from "../api/index.js";
import { extractSessionIds } from "../panelUtils.js";
import { useDashboardStore } from "../store/index.js";

// The workspace tree as the left sidebar's Workspaces section shows it, shared
// with the left rail's workspace chip and list (#3009) so the two can never
// disagree about order, grouping or live state. Derivations only: renaming,
// reordering and regrouping stay in WorkspaceSwitcher.tsx.

export type WorkspaceLiveStatus = "attention" | "working" | null;

// P2 perf fix — this used to walk `workspace.layout` (the serialized dockview
// JSON blob, recursively) via extractSessionIds on every call, and it was
// called inline inside WorkspaceList's `.map()` — so every workspace's whole
// layout tree got re-walked on every render, including the 4s live-refresh
// tick that changes `sessions` but never touches `workspaces`/its layouts.
// Split in two: `sessionIdsByWorkspace` below does the expensive walk once
// per workspace, memoized on `workspaces` itself; this function just
// intersects an already-extracted id Set against the current `sessions`
// array — an O(sessions) scan with no JSON traversal, cheap enough to run
// unmemoized on every render.
export function deriveWorkspaceLiveStatus(
  sessionIds: Set<number> | undefined,
  sessions: Session[],
): WorkspaceLiveStatus {
  if (!sessionIds || sessionIds.size === 0) return null;
  let working = false;
  for (const s of sessions) {
    if (!sessionIds.has(s.id)) continue;
    if (s.attention) return "attention";
    if (s.activity === "working") working = true;
  }
  return working ? "working" : null;
}

/** A group's colour as the sidebar paints it: its own, or the neutral one. */
export function groupColor(group: Pick<Group, "color"> | null | undefined): string {
  return group?.color ?? "var(--dim)";
}

export interface WorkspaceTree {
  workspaces: Workspace[];
  sessions: Session[];
  /** Groups in display order: alphabetical (they are not drag-reorderable). */
  sortedGroups: Group[];
  /** One group's workspaces, in their stored order. */
  groupWorkspaces: (groupId: number) => Workspace[];
  /** Workspaces with no group, in their stored order. */
  ungrouped: Workspace[];
  /** Session ids per workspace, walked out of each layout once. */
  sessionIdsByWorkspace: Map<number, Set<number>>;
  liveStatusOf: (workspaceId: number) => WorkspaceLiveStatus;
}

export function useWorkspaceTree(): WorkspaceTree {
  const workspaces = useDashboardStore((s) => s.workspaces);
  const groups = useDashboardStore((s) => s.groups);
  const sessions = useDashboardStore((s) => s.sessions);

  // Every surface that shows groups loads them: on the tablet the sidebar's
  // switcher unmounts while its drawer shows another tab, so the rail's chip
  // cannot rely on it having done so.
  useEffect(() => {
    void useDashboardStore.getState().refreshGroups();
  }, []);

  // P2 perf fix — the expensive part (recursively walking each workspace's
  // serialized dockview layout JSON via extractSessionIds) happens here,
  // memoized on `workspaces` itself — NOT on every `sessions` tick.
  const sessionIdsByWorkspace = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const w of workspaces) map.set(w.id, extractSessionIds(w.layout));
    return map;
  }, [workspaces]);

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => a.name.localeCompare(b.name)),
    [groups],
  );
  const ungrouped = useMemo(
    () => workspaces.filter((w) => w.groupId === null).sort((a, b) => a.position - b.position),
    [workspaces],
  );

  return {
    workspaces,
    sessions,
    sortedGroups,
    groupWorkspaces: (groupId) =>
      workspaces.filter((w) => w.groupId === groupId).sort((a, b) => a.position - b.position),
    ungrouped,
    sessionIdsByWorkspace,
    liveStatusOf: (id) => deriveWorkspaceLiveStatus(sessionIdsByWorkspace.get(id), sessions),
  };
}
