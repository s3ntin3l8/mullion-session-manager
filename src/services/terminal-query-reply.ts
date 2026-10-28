// Answers a program's startup terminal queries (OSC 10/11/12 color queries and
// DA1) from the backend while NO browser is attached to its session.
//
// Why: Claude Code and Codex ask for the terminal's colors ~0.3-0.8 s after
// launch and pick their palette from the reply. A session often starts before
// any pane is there to answer (the pane mounts seconds later), so the query
// sits in the scrollback and the browser can only answer it late on replay.
// Measured: Codex ignores a reply 3 s late, so it keeps the wrong palette for
// the session's life; Claude applies a late reply only when its DA1 follows.
//
// The backend can't know the theme itself (settings.theme may be "system",
// which only the browser can resolve), so the frontend reports the resolved
// palette (PUT /api/terminal/palette) and this module caches the latest one.
// Until a palette is known nothing is answered (the old behaviour).
//
// A chunk split across two PTY reads is not reassembled; a split query is
// simply left for the browser, as before.

export interface TerminalPalette {
  foreground: string;
  background: string;
  cursor: string;
}

let palette: TerminalPalette | null = null;

export function setTerminalPalette(next: TerminalPalette): void {
  palette = { ...next };
}

export function getTerminalPalette(): TerminalPalette | null {
  return palette;
}

/** Test seam: forget the cached palette. */
export function resetTerminalPalette(): void {
  palette = null;
}

/* eslint-disable no-control-regex */
// OSC 10/11/12 `?` query, or a bare DA1 (`CSI c` / `CSI 0 c`; DA2 `CSI > c` has
// a prefix and does not match).
const STARTUP_QUERY_RE = /\x1b\](1[012]);\?(?:\x07|\x1b\\)|\x1b\[0?c/g;
/* eslint-enable no-control-regex */

// Same answer xterm.js gives a DA1 (what the browser would have sent live).
const DA1_REPLY = "\x1b[?1;2c";

/** `rgb:` report form: each 8-bit channel doubled to 16 bits, like a real terminal. */
function oscReply(ident: string, hex: string): string {
  const clean = hex.slice(1);
  const [r, g, b] = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)];
  return `\x1b]${ident};rgb:${r}${r}/${g}${g}/${b}${b}\x07`;
}

/**
 * Replies for every startup query in `data`, in the order they were asked (a
 * program ends an OSC query with a DA1 and only reads the OSC reply once the
 * DA1 reply arrives, so order matters). "" when there is nothing to answer or
 * no palette is known.
 */
export function buildStartupQueryReplies(
  data: string,
  current: TerminalPalette | null = palette,
): string {
  if (!current || !data.includes("\x1b")) return "";
  let out = "";
  for (const m of data.matchAll(STARTUP_QUERY_RE)) {
    if (m[1] === undefined) {
      out += DA1_REPLY;
    } else if (m[1] === "10") {
      out += oscReply("10", current.foreground);
    } else if (m[1] === "11") {
      out += oscReply("11", current.background);
    } else {
      out += oscReply("12", current.cursor);
    }
  }
  return out;
}
