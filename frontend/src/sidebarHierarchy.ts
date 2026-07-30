import type { Session } from "./api.js";

// Pure hierarchy logic for Sidebar.tsx's ProjectSection (Phase 5, Track B,
// issue #195 5.5b) — split into its own module purely so Sidebar.tsx can
// stay component-only for react-refresh/only-export-components (Fast
// Refresh breaks once a component file also exports plain functions) —
// same reasoning kanban.ts exists separately from KanbanBoard.tsx for.

// Orders an already-filtered project session list for hierarchical
// rendering: each root is immediately followed by its own children, each
// one level deeper.
//
// "Root" is either a session with no parent, or one whose parent is NOT
// present in THIS SAME already-filtered list — the orphan rule required by
// the plan: Sidebar's own filter already drops killed sessions and (under
// "hide ended sessions") exited ones, so "parent still visible" can only be
// answered against the list actually being rendered, not the full session
// set. Without this, a session whose parent got filtered out would render
// nowhere instead of falling back to top level.
export function buildHierarchicalRows<T extends Pick<Session, "id" | "parentSessionId">>(
  sessions: T[],
): { session: T; depth: number }[] {
  const visibleIds = new Set(sessions.map((s) => s.id));
  const childrenByParent = new Map<number, T[]>();
  const roots: T[] = [];
  for (const session of sessions) {
    if (session.parentSessionId !== null && visibleIds.has(session.parentSessionId)) {
      const siblings = childrenByParent.get(session.parentSessionId) ?? [];
      siblings.push(session);
      childrenByParent.set(session.parentSessionId, siblings);
    } else {
      roots.push(session);
    }
  }
  const rows: { session: T; depth: number }[] = [];
  for (const root of roots) {
    rows.push({ session: root, depth: 0 });
    for (const child of childrenByParent.get(root.id) ?? []) {
      rows.push({ session: child, depth: 1 });
    }
  }
  return rows;
}
