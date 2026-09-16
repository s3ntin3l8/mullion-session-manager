// Issue #1228 — turning raw PTY scrollback bytes into a single short,
// human-readable line. There is no prior helper of this shape in the repo:
// the only other consumer of scrollback text, dev-server-detect.ts's
// parseDevServerPort, extracts a port number via a banner-line regex, not a
// generic "last real line" reader.

// Strips ANSI CSI/SGR sequences (the `\x1b[<params><letter>` escapes chalk/
// picocolors emit for color/bold). Moved here from dev-server-detect.ts,
// which re-exports it for its own use — see this repo's own precedent for
// why the strip is load-bearing against real PTY output, not cosmetic:
// dev-server-detect.ts's own comment on the equivalent regex explains a
// styled "Local" banner line breaking word-boundary matching outright
// without it. Reused as-is here rather than reinvented, per #1228's own
// scope note.
// eslint-disable-next-line no-control-regex
export const ANSI_ESCAPE_SEQUENCE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

// OSC (Operating System Command) sequences — `\x1b]...BEL` or
// `\x1b]...\x1b\\` (ST) — title-setting (OSC 0/1/2), cwd reporting (OSC 7),
// and notifications (OSC 9/777) all take this shape. CSI's regex above
// doesn't touch these at all (no `[` after the ESC), and a raw OSC
// sequence left in a "last line" scan reads as garbage the way an
// unstripped CSI sequence would.
// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

// Lone single-character ESC sequences with no `[`/`]` following (e.g.
// `\x1bM` reverse-index, `\x1b=`/`\x1b>` keypad mode) — everything CSI/OSC
// above doesn't already consume.
// eslint-disable-next-line no-control-regex
const LONE_ESC_SEQUENCE = /\x1b[^[\]]/g;

// Remaining stray control bytes (C0 range minus tab/newline/carriage
// return, which the line-splitting/segment logic below still needs).
// eslint-disable-next-line no-control-regex
const STRAY_CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/** Strips ANSI escape sequences (CSI, OSC, lone-ESC) and stray control
 * bytes from raw PTY output, leaving `\t`/`\n`/`\r` intact for the
 * line/segment splitting `lastMeaningfulLine` below does next. */
export function stripTerminalEscapes(text: string): string {
  return text
    .replace(OSC_SEQUENCE, "")
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(LONE_ESC_SEQUENCE, "")
    .replace(STRAY_CONTROL_BYTES, "");
}

/**
 * Returns the last non-blank, human-meaningful line in a chunk of raw PTY
 * scrollback, or null if nothing qualifies. Two things a plain `\n`-split
 * doesn't handle, both real for terminal output:
 *
 * - A `\r`-overwritten line (a progress bar, a spinner) is one logical line
 *   with several `\r`-separated repaints piled into it — only the segment
 *   after the LAST `\r` is what's actually visible. But a real PTY's normal
 *   line terminator is `\r\n`, not bare `\n` (confirmed: node-pty, this
 *   repo's actual pty backend, emits it) — so every ordinary line ends in
 *   its OWN trailing `\r` that carries no overwrite at all. Stripping
 *   exactly one trailing `\r` before the overwrite-split (not stripping
 *   more, and not skipping the split when there's no trailing `\r`) is what
 *   keeps both cases correct: an ordinary `"Build succeeded\r"` line
 *   becomes `"Build succeeded"` before ever reaching the split, while a
 *   genuine mid-line overwrite (`"Building...\rDone"`, no trailing `\r`)
 *   still only surfaces the segment after its last `\r`.
 * - When `truncated` is true (the read hit its byte cap — see
 *   ScrollbackBuffer.tail()'s hard cut, scrollback-buffer.ts), the first
 *   line may be a partial line split mid-stream, and may even start with a
 *   stray U+FFFD from a multi-byte character cut in half. It's discarded
 *   outright rather than risking a garbled fragment.
 */
export function lastMeaningfulLine(text: string, opts: { truncated: boolean }): string | null {
  const plain = stripTerminalEscapes(text);
  const lines = plain.split("\n");
  if (opts.truncated) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    const segments = line.split("\r");
    const visible = segments[segments.length - 1].trim();
    if (visible) return visible;
  }
  return null;
}

/**
 * Collapses embedded whitespace (a multi-line or oddly-spaced fragment)
 * into single spaces, trims, then truncates to `maxChars` **code points**
 * (not UTF-16 code units — a plain `.slice()` can land mid-surrogate-pair
 * for an emoji/non-BMP character and render U+FFFD), appending `…` if
 * anything was cut.
 *
 * Mirrors session-status.ts's truncateDetail, which does the same three
 * steps but is keyed on SessionStatus for its own max-length lookup rather
 * than plain text — see issue #1294 for delegating that function to this
 * one instead of carrying the near-duplicate body twice.
 */
export function collapseAndTruncate(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const codePoints = Array.from(normalized);
  if (codePoints.length <= maxChars) return normalized;
  return `${codePoints.slice(0, maxChars).join("")}…`;
}
