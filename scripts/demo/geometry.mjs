/**
 * Where a held transcript script records its PTY's size (`stty size`) the
 * moment it's released, before printing; see agentTranscriptScript.
 */
export function ptySizeFile(releaseFile) {
  return `${releaseFile}.size`;
}

/** Parses `stty size` output ("rows cols"); null when it isn't one. */
export function parseSttySize(text) {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
  if (!m) return null;
  const rows = Number(m[1]);
  const cols = Number(m[2]);
  return rows > 0 && cols > 0 ? { rows, cols } : null;
}

// A monospace cell at the configured font size is ~0.6em wide and, at the
// terminal's line height, ~1.3em tall. The bounds leave room for any font in
// the settings' family list but stop well short of the 2x cells seen in a
// broken capture (16.4 x 36 CSS px at the default 14 px).
const MAX_CELL_WIDTH_EM = 0.8;
const MAX_CELL_HEIGHT_EM = 1.6;
const PX_TOLERANCE = 1;
const DPR_TOLERANCE = 0.05;

/**
 * Checks a terminal's measured geometry before it's shot, returning what's
 * wrong as `{ kind, message }` (empty when it's fine): kind "cells" for
 * oversized cells, "canvas" for a drawing surface out of step. `screen` is the `.xterm-screen` box (cols x
 * cell width by rows x cell height), `canvases` the renderer's drawing
 * surfaces (none under the DOM renderer), `pty` the size the session's
 * transcript printed at, or null when it wasn't recorded.
 *
 * The settled gate only sees the box, which stays the same size when the
 * cells don't: a fit at an oversized cell gives fewer, bigger columns in the
 * same box. That shipped in a still once (twice the normal cell, ~76 columns
 * in the desktop box). A renderer surface out of step with the box is the
 * other way the text can come out the wrong size, so it's checked too.
 */
export function terminalGeometryProblems({ screen, canvases, dpr, pty, fontSize }) {
  const problems = [];
  if (pty) {
    const cellWidth = screen.width / pty.cols;
    const cellHeight = screen.height / pty.rows;
    if (cellWidth > fontSize * MAX_CELL_WIDTH_EM || cellHeight > fontSize * MAX_CELL_HEIGHT_EM) {
      problems.push({
        kind: "cells",
        message:
          `${pty.cols}x${pty.rows} cells in a ${screen.width}x${screen.height} box ` +
          `(${cellWidth.toFixed(1)}x${cellHeight.toFixed(1)} px cells at a ${fontSize} px font)`,
      });
    }
  }
  for (const [i, c] of canvases.entries()) {
    if (
      Math.abs(c.cssWidth - screen.width) > PX_TOLERANCE ||
      Math.abs(c.cssHeight - screen.height) > PX_TOLERANCE
    ) {
      problems.push({
        kind: "canvas",
        message: `canvas ${i} is ${c.cssWidth}x${c.cssHeight} css px in a ${screen.width}x${screen.height} box`,
      });
    }
    if (c.cssWidth > 0 && Math.abs(c.width / c.cssWidth - dpr) > DPR_TOLERANCE) {
      problems.push({
        kind: "canvas",
        message: `canvas ${i} is drawn at ${(c.width / c.cssWidth).toFixed(2)}x for a devicePixelRatio of ${dpr}`,
      });
    }
  }
  return problems;
}

/**
 * The check a terminal shot runs before shooting. `measure` returns the
 * page's terminals (`{ terminals, screen, canvases, dpr }`); like the settled
 * gate, it must find exactly one, since a pane can't be told apart from
 * another on the page and measuring the wrong one would pass a broken shot.
 * Oversized cells throw at once: the transcript already printed at them and
 * xterm doesn't reflow printed output, so re-fitting can't repair the still.
 * A canvas out of step gets `refit` (a viewport nudge and re-settle) up to
 * `maxRefits` times. Logs one geometry line per measurement and returns the
 * geometry that passed.
 */
export async function checkTerminalGeometry({
  name,
  measure,
  refit,
  pty,
  fontSize,
  log,
  maxRefits = 2,
}) {
  if (!pty) log(`[screenshots] ${name}: no PTY size recorded; checking the canvases only`);
  for (let attempt = 0; ; attempt++) {
    const { terminals, ...measured } = await measure();
    if (terminals !== 1) {
      throw new Error(`${name}: expected one mounted terminal, found ${terminals}`);
    }
    const geometry = { ...measured, pty, fontSize };
    log(`[screenshots] ${name} terminal: ${JSON.stringify(geometry)}`);
    const problems = terminalGeometryProblems(geometry);
    if (problems.length === 0) return geometry;
    const summary = problems.map((p) => p.message).join("; ");
    if (problems.some((p) => p.kind === "cells") || attempt >= maxRefits) {
      throw new Error(`${name}: terminal geometry is off: ${summary}`);
    }
    log(`[screenshots] ${name}: re-fitting the terminal (${summary})`);
    await refit();
  }
}
