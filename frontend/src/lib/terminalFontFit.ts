// Pure geometry math for TerminalPane's narrow-pane font shrink — see that
// file's own GeometryMessage handler and settings-sync effect for how this
// is wired in. Kept here, framework-free, so the fixpoint property this
// relies on has a home that can be unit-tested without mounting xterm.

// A render-time floor, distinct from (and unrelated to) the backend's own
// MIN_TERMINAL_COLS/ROWS (pty-manager.ts) — that one bounds what grid size
// the PTY will ever run at; this one bounds how small this function will
// ever scale the *font* down to before giving up and leaving the "pane too
// small" hint up instead of rendering illegibly tiny text.
export const MIN_RENDER_FONT_SIZE = 8;

export interface FitFontSizeResult {
  fontSize: number;
  /** False when even MIN_RENDER_FONT_SIZE can't fit the target grid — the
   * caller should leave its own "pane too small" signal up in this case
   * rather than treat the shrink as having resolved anything. */
  achievable: boolean;
}

/**
 * Given how many columns/rows a terminal's container can currently show at
 * `configuredFontSize` (`proposedCols`/`proposedRows` — straight from
 * `FitAddon.proposeDimensions()`, measured at that exact size), derive a
 * smaller font size that fits `targetCols`/`targetRows` instead (the PTY's
 * server-applied floor).
 *
 * Must always be called with a measurement taken at `configuredFontSize`
 * itself, never at a size this function already shrunk on a previous call.
 * Cell width scales ~linearly with font size for a fixed font family, so
 * scaling from a stable, unchanging baseline (the user's real setting) on
 * every call is what makes this a fixpoint rather than a ratchet: the
 * result only ever depends on the current container size and the user's
 * setting, never on this function's own prior output. A naive loop that
 * re-measured against its own last shrunk size would oscillate: shrink ->
 * more columns fit -> caller sends the larger size -> server accepts ->
 * "not too small" anymore -> grows back -> too small again.
 */
export function computeFitFontSize(
  configuredFontSize: number,
  proposedCols: number,
  proposedRows: number,
  targetCols: number,
  targetRows: number,
  minFontSize: number = MIN_RENDER_FONT_SIZE,
): FitFontSizeResult {
  if (proposedCols >= targetCols && proposedRows >= targetRows) {
    return { fontSize: configuredFontSize, achievable: true };
  }
  if (proposedCols <= 0 || proposedRows <= 0 || targetCols <= 0 || targetRows <= 0) {
    return { fontSize: minFontSize, achievable: false };
  }
  const ratio = Math.min(proposedCols / targetCols, proposedRows / targetRows);
  const rawTarget = configuredFontSize * ratio;
  const achievable = rawTarget >= minFontSize;
  const fontSize = Math.max(minFontSize, Math.min(configuredFontSize, Math.floor(rawTarget)));
  return { fontSize, achievable };
}
