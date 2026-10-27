import xtermHeadless from "@xterm/headless";
import type { Terminal as TerminalType } from "@xterm/headless";

// @xterm/headless ships CommonJS; under Node16 ESM the named export is only
// reachable through the default import.
const { Terminal } = xtermHeadless as unknown as { Terminal: typeof TerminalType };

/** Lines of history the emulator keeps — enough for the whole 1 MiB scrollback
 * ring even when it is mostly short lines, bounded so a hostile stream cannot
 * grow it without limit. */
const EMULATOR_SCROLLBACK_LINES = 20_000;

/** How many rendered lines (from the end) are returned at most. */
export const RENDERED_MAX_LINES = 2_000;

export interface RenderOptions {
  cols: number;
  rows: number;
  /** Keep only the last N lines of the result (default RENDERED_MAX_LINES). */
  maxLines?: number;
}

/** The last `limit` lines of `buffer`, trailing blank rows (the unused part of
 * the screen) dropped. Walks backwards from the end so only the lines that are
 * returned are ever built (the emulator keeps up to EMULATOR_SCROLLBACK_LINES). */
function bufferLines(buffer: TerminalType["buffer"]["active"], limit: number): string[] {
  const text = (i: number): string => buffer.getLine(i)?.translateToString(true) ?? "";
  let end = buffer.length;
  while (end > 0 && text(end - 1) === "") end--;
  const lines: string[] = [];
  for (let i = end - 1; i >= 0 && lines.length < limit; i--) lines.push(text(i));
  return lines.reverse();
}

/**
 * Feeds raw PTY output through a headless terminal emulator and returns what a
 * person looking at the terminal would have read: the scrolled-off lines plus
 * the visible screen, as plain text.
 *
 * A full-screen TUI (Claude Code, Codex, opencode) repaints in place with
 * cursor-movement escapes, so its raw byte stream is unreadable and its
 * "answer" is spread across partial repaints (issue #2112). Replaying the
 * stream into an emulator resolves every repaint to the final screen. If the
 * program ended on the alternate screen, the normal buffer (what was on the
 * terminal before it switched) is returned first, then the alternate screen
 * under a marker line.
 *
 * Bounded: input beyond the caller's own cap is the caller's concern (the
 * scrollback ring is 1 MiB); output is cut to the last `maxLines` lines.
 */
export async function renderScrollback(bytes: Uint8Array, opts: RenderOptions): Promise<string> {
  const term = new Terminal({
    cols: Math.max(2, Math.floor(opts.cols)),
    rows: Math.max(1, Math.floor(opts.rows)),
    scrollback: EMULATOR_SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => term.write(bytes, resolve));
    const max = opts.maxLines ?? RENDERED_MAX_LINES;
    if (term.buffer.active.type !== "alternate") {
      return bufferLines(term.buffer.normal, max).join("\n");
    }
    // Ended on the alternate screen: that screen is the part that matters, so it
    // gets the line budget first and the normal buffer (what was on the terminal
    // before the program switched) fills what is left.
    const alt = bufferLines(term.buffer.alternate, max);
    const normal = bufferLines(term.buffer.normal, Math.max(0, max - alt.length - 1));
    return [...normal, "--- alternate screen ---", ...alt].join("\n");
  } finally {
    term.dispose();
  }
}
