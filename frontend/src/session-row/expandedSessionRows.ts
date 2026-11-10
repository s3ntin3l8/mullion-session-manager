import { STORAGE_KEYS, readJSON, writeJSON } from "../lib/persistedState.js";

// Row 3's expand/collapse toggle (issue #202) persists per session, same
// single-localStorage-key convention as the sidebar's own collapse/width
// state (store.ts's STORAGE_KEYS.sidebarCollapsed/sidebarWidth) rather than
// one key per session — there's no existing per-*session* persisted-UI-state
// precedent to follow instead (ProjectSection's own collapse above is
// in-memory `useState`, derived fresh each mount). Module-level (not store
// state) since this is pure, session-scoped UI state no other component
// needs to read.
function readExpandedSessionRows(): Set<number> {
  const parsed = readJSON<unknown>(STORAGE_KEYS.expandedSessionRows, []);
  return new Set(Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number") : []);
}

// Read once at module load (mirrors readStoredSidebarWidth's own shape in
// store.ts) — every SessionRow instance shares this one Set rather than
// each re-reading localStorage on mount.
const expandedSessionRows = readExpandedSessionRows();

function setSessionRowExpanded(sessionId: number, expanded: boolean): void {
  if (expanded) expandedSessionRows.add(sessionId);
  else expandedSessionRows.delete(sessionId);
  writeJSON(STORAGE_KEYS.expandedSessionRows, [...expandedSessionRows]);
}

export { expandedSessionRows, setSessionRowExpanded };
