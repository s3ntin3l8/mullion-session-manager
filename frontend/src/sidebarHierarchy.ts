import type { Session } from "./api/index.js";

// Pure hierarchy logic for Sidebar.tsx's ProjectSection (Phase 5, Track B,
// issue #195 5.5b) — split into its own module purely so Sidebar.tsx can
// stay component-only for react-refresh/only-export-components (Fast
// Refresh breaks once a component file also exports plain functions) —
// same reasoning kanban.ts exists separately from UnifiedBoard.tsx for.

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
      // Hermes review finding (PR #430) — `.get()` already returns the same
      // array reference stored in the map for every child after the first,
      // so re-`.set()`ing it is a no-op; only the first child (where `?? []`
      // creates the array) needs to insert it.
      let siblings = childrenByParent.get(session.parentSessionId);
      if (!siblings) {
        siblings = [];
        childrenByParent.set(session.parentSessionId, siblings);
      }
      siblings.push(session);
    } else {
      roots.push(session);
    }
  }
  // Hermes review finding (PR #430) — this only ever looks up
  // `childrenByParent.get(root.id)`, so a session whose OWN parent is itself
  // a non-root child (a grandchild) would never be visited by this loop at
  // all, not just rendered at the wrong depth. Confirmed unreachable today:
  // `createSessionRecord` (src/routes/sessions.ts) rejects a parent that is
  // itself a child, so every session's `parentSessionId` can only ever point
  // at a true root — `childrenByParent`'s keys and `roots`' ids are
  // therefore always disjoint from `childrenByParent`'s own values. If that
  // one-level cap is ever relaxed server-side, this needs to become
  // recursive (or gain an explicit assertion) to avoid silently dropping
  // grandchildren instead of just misplacing their depth.
  const rows: { session: T; depth: number }[] = [];
  for (const root of roots) {
    rows.push({ session: root, depth: 0 });
    for (const child of childrenByParent.get(root.id) ?? []) {
      rows.push({ session: child, depth: 1 });
    }
  }
  return rows;
}

// Phase 5 (Track B, issue #196 5.6) — how many LIVE children a session has,
// against the FULL session list (not an already-filtered one, unlike
// buildHierarchicalRows above): whether ending a parent needs a
// cascade-aware confirmation shouldn't depend on whether "hide ended
// sessions" happens to be on, or which project section is currently
// rendering it. Only `status === "active"` counts — an already-killed or
// exited child is terminal history, not something a cascade choice affects
// (mirrors killSession's own "only live children" cascade/detach logic).
export function liveChildCount<T extends Pick<Session, "parentSessionId" | "status">>(
  sessions: T[],
  parentId: number,
): number {
  return sessions.filter((s) => s.parentSessionId === parentId && s.status === "active").length;
}
