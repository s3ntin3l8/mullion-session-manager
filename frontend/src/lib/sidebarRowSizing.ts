// VirtualizedProjectTree's (Sidebar.tsx) row-height estimator, extracted as
// PR 27 phase 1 (Wave 5, .claude/plans/can-we-do-a-warm-cocke.md). The
// `SidebarFlatRow` union itself (header/session/empty, carrying full
// `Project`/`Session` render state) stays in Sidebar.tsx — it's render
// shape, not a pure-helper concern. PR 27 phase 2 (the SessionRow split into
// Header/GitLine/FileChanges/Chips under ./session-row/) deliberately did
// NOT reshape `SidebarFlatRow` or this estimator's own two-tier
// estimate/measureElement contract: every sub-component returns the exact
// same DOM (no new wrapper elements at the component boundaries), so the
// real rendered height each row measures to is unchanged, and this
// estimator's cheap a-priori guess (based only on whether the git-details
// line is expanded, corrected by `measureElement` after first paint) needed
// no changes either. `SidebarRowSizeInput` below is the minimal structural
// slice this estimator actually reads; `SidebarFlatRow` is assignable to it
// at the one call site (Sidebar.tsx's VirtualizedProjectTree) with no cast
// needed.
export type SidebarRowSizeInput =
  { type: "header" } | { type: "empty" } | { type: "session"; session: { id: number } };

export const PROJECT_HEADER_ROW_ESTIMATE = 32;
export const EMPTY_NOTE_ROW_ESTIMATE = 28;
export const SESSION_ROW_ESTIMATE_COLLAPSED = 54;
export const SESSION_ROW_ESTIMATE_EXPANDED = 92;

// A session row's real height varies with which of its (up to) six sub-rows
// are showing (see SessionRow's own doc comments — row 3's git-details
// toggle, row 4's file-change chips, row 5's subagent chips, row 6's
// background-task chips can each add a line). A fully accurate a-priori
// estimate would mean duplicating SessionRow's own derivation of
// fileChanges/showSubagentsRow/showBackgroundTasksRow here — those aren't
// fields on Session itself, they're derived from the session's *event*
// history inside that component — purely to guess a number that
// `measureElement` (in VirtualizedProjectTree) immediately corrects
// after first paint anyway. So this uses the one cheap, already-available
// signal instead: whether the git-details line is expanded. Sidebar.tsx's
// module-level `expandedSessionRows` Set (also read by SessionRow itself for
// that toggle's persisted state) is passed in explicitly by the caller
// rather than closed over here, so this stays a pure function of its
// arguments. Same two-tier estimate/measureElement split NotificationBell.tsx
// already uses (see its own HEADER_ROW_HEIGHT/EVENT_ROW_ESTIMATE_HEIGHT).
export function estimateSidebarRowHeight(
  row: SidebarRowSizeInput | undefined,
  expandedSessionRowIds: ReadonlySet<number>,
): number {
  if (!row) return SESSION_ROW_ESTIMATE_COLLAPSED;
  if (row.type === "header") return PROJECT_HEADER_ROW_ESTIMATE;
  if (row.type === "empty") return EMPTY_NOTE_ROW_ESTIMATE;
  return expandedSessionRowIds.has(row.session.id)
    ? SESSION_ROW_ESTIMATE_EXPANDED
    : SESSION_ROW_ESTIMATE_COLLAPSED;
}
