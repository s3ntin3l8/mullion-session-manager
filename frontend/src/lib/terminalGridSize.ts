// Pure geometry clamp for TerminalPane's refit() — kept here, framework-free,
// so it can be unit-tested without mounting xterm. See TerminalPane.tsx's
// refit() for how this is wired in.

// MAX_TERMINAL_COLS/ROWS physically live in src/shared/constants.ts — see
// that file's own doc comment for the full dock resize-runaway rationale.
// Genuinely shared with the backend (unlike pty-manager.ts's
// MIN_TERMINAL_COLS/ROWS, which the frontend only ever learns at runtime via
// the GeometryMessage echo): this component clamps proactively, before ever
// sending a resize, so a runaway proposal never leaves the tab in the first
// place — the backend's own clamp (the same values, via pty-manager.ts's
// clampTerminalSize()) is the actual last line of defense against any
// client, this one included. Re-exported below so this module stays every
// existing consumer's one import for both the constants and the clamp.
import { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS } from "../../../src/shared/constants.js";
export { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS };

/**
 * Clamp a proposed terminal grid size to
 * [1, MAX_TERMINAL_COLS/ROWS] — the lower bound only guards against a
 * degenerate (zero or negative) proposal ever reaching `term.resize()`;
 * the real floor (MIN_TERMINAL_COLS/ROWS) is the server's own concern
 * (pty-manager.ts) and is applied there, not here.
 */
export function clampTerminalGridSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.min(Math.max(cols, 1), MAX_TERMINAL_COLS),
    rows: Math.min(Math.max(rows, 1), MAX_TERMINAL_ROWS),
  };
}
