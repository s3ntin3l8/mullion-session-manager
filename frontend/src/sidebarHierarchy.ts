import type { Project, Session } from "./api/index.js";
import { sessionDisplayTitle } from "./lib/sessionDisplay.js";
import type { SessionTitleContexts } from "./lib/sessionDisplay.js";

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

// #3456 — a child spawned into another project than its coordinator's stays
// in its own project's tree (no cross-project nesting), so nothing in the
// tree says who spawned it. This derives the "spawned by" marker's data.
// `live` / `exited` parents can be opened; `killed` (hidden from every view,
// see isListedSession) and `missing` (not in the store) cannot.
export type SpawnParentState = "live" | "exited" | "killed" | "missing";

export interface CrossProjectParent {
  parentId: number;
  title: string;
  projectId: number | null;
  projectName: string;
  state: SpawnParentState;
}

// Null unless the session has a parent that is in the store with a DIFFERENT
// project (a same-project child keeps nesting and gets no marker), or whose
// row is gone while it still names one (`missing`). `titleContexts` gives the
// parent the same task-aware title the sidebar shows (sessionDisplayTitle).
export function crossProjectParent(
  session: Pick<Session, "parentSessionId" | "projectId">,
  allSessions: Session[],
  projects: Pick<Project, "id" | "name">[],
  titleContexts?: SessionTitleContexts,
): CrossProjectParent | null {
  if (session.parentSessionId === null) return null;
  const parent = allSessions.find((s) => s.id === session.parentSessionId);
  if (!parent) {
    return {
      parentId: session.parentSessionId,
      title: "",
      projectId: null,
      projectName: "",
      state: "missing",
    };
  }
  if (parent.projectId === session.projectId) return null;
  const state: SpawnParentState =
    parent.status === "killed" ? "killed" : parent.status === "exited" ? "exited" : "live";
  return {
    parentId: parent.id,
    title: sessionDisplayTitle(parent, titleContexts?.get(parent.id)),
    projectId: parent.projectId,
    projectName: projects.find((p) => p.id === parent.projectId)?.name ?? "",
    state,
  };
}

// The parent's side of the marker: the LIVE children it has in other projects
// (the same full-store basis as liveChildCount, so the number agrees with the
// end-session confirmation). Empty when the parent is not in the store.
export function crossProjectChildren<
  T extends Pick<Session, "id" | "parentSessionId" | "status" | "projectId">,
>(allSessions: T[], parentId: number): T[] {
  const parent = allSessions.find((s) => s.id === parentId);
  if (!parent) return [];
  return allSessions.filter(
    (s) =>
      s.parentSessionId === parentId && s.status === "active" && s.projectId !== parent.projectId,
  );
}

export function crossProjectChildCount(
  allSessions: Pick<Session, "id" | "parentSessionId" | "status" | "projectId">[],
  parentId: number,
): number {
  return crossProjectChildren(allSessions, parentId).length;
}
