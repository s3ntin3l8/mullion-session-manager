// Generalizes the pattern Settings.hosts.test.tsx's beforeEach documents
// inline: "the store is a module-level singleton — reset the slice this
// test touches so a previous test's DELETE doesn't leak into this one."
// That comment's own fix only resets the ONE slice that file happens to
// care about (`useDashboardStore.setState({ hosts: [] })`); every other
// file that mutates the store (28 setState calls in Dock.test.tsx, 23 in
// TerminalPane.test.tsx, 17 each in BrowserPanel.test.tsx/
// CommandPalette.test.tsx, ...) does the same narrow, per-slice thing,
// which means a slice nobody thought to reset can still leak a previous
// test's mutation into the next one.
//
// `resetStore()` instead replaces the ENTIRE store state with a pristine
// snapshot (below), then layers this call's own overrides on top in one
// step — so every test starts from a genuinely clean baseline regardless
// of which slice(s) a *previous* test in the same file happened to touch.
import { useDashboardStore } from "../store.js";

type DashboardState = ReturnType<typeof useDashboardStore.getState>;

// Captured once, the moment this module is first imported — before any
// test in the importing file has had a chance to call setState. Vitest
// isolates each test FILE into its own fresh module registry (this repo's
// per-file, not per-test-case, isolation), so store.ts's own top-level
// `create(...)` call has always just run for the first time when this
// executes: this really is the store's pristine boot-time state, including
// its handful of localStorage-derived fields (theme, sidebarCollapsed,
// activeWorkspaceId, ...) computed once at store creation.
//
// Captured directly from the real store (not hand-duplicated field by
// field) so it can never drift out of sync with a field store.ts adds,
// renames, or removes later — the same "typed against the real shape"
// reasoning fixtures.ts's builders follow.
//
// This is a SHALLOW capture — PRISTINE_STATE holds references to the same
// nested objects/arrays the live store starts with, not deep clones. Safe
// as long as every mutation goes through `setState` (which always installs
// fresh nested values, per zustand convention and this codebase's own
// store.ts actions) rather than mutating a value in place
// (`getState().sessions[0].x = ...`) — an in-place mutation before any
// `setState` would corrupt this snapshot for every later test in the file.
const PRISTINE_STATE: DashboardState = useDashboardStore.getState();

/**
 * Resets `useDashboardStore` to its pristine boot-time state, then applies
 * `overrides` on top — in one step, so a test only has to specify what it
 * actually cares about instead of guessing which slices a previous test in
 * the same file may have left dirty.
 *
 * Replaces the whole state object (not a shallow merge) — safe here
 * specifically because `PRISTINE_STATE` is a complete `DashboardState`
 * (every data field AND every action function), so nothing is ever left
 * missing the way a hand-picked partial reset could.
 *
 * Only usable in a file that exercises the REAL store (this module imports
 * `../store.js` directly). A file that does `vi.mock("./store.js", () =>
 * ...)` (e.g. SessionRow.test.tsx, Sidebar.test.tsx, UnifiedBoard.test.tsx,
 * PaneTab.test.tsx — each supplies its own fake `useDashboardStore` backed
 * by local mutable `let` variables, some without a `getState` at all) must
 * keep resetting those `let`s directly in its own `beforeEach`; importing
 * this helper there would call `useDashboardStore.getState()` against a
 * mock that may not implement it, throwing at import time before any test
 * runs.
 */
export function resetStore(overrides: Partial<DashboardState> = {}): void {
  useDashboardStore.setState({ ...PRISTINE_STATE, ...overrides }, true);
}
