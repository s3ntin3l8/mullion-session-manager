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

function bufferLines(buffer: TerminalType["buffer"]["active"]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  // Trailing blank rows (the unused part of the screen) carry no information.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
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
    const normal = bufferLines(term.buffer.normal);
    const lines =
      term.buffer.active.type === "alternate"
        ? [...normal, "--- alternate screen ---", ...bufferLines(term.buffer.alternate)]
        : normal;
    const max = opts.maxLines ?? RENDERED_MAX_LINES;
    return (lines.length > max ? lines.slice(lines.length - max) : lines).join("\n");
  } finally {
    term.dispose();
  }
}
