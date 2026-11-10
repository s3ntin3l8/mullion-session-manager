// Answers a program's startup terminal queries (OSC 10/11/12 color queries and
// DA1) from the backend, whether or not a browser is attached to its session.
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
// The backend answers whether or not a browser is attached: Codex 0.166 probes
// once at startup (OSC 10/11 + DA1 + CPR in one write) and waits only 250 ms
// for all of it, so a reply routed through a pane's WebSocket and xterm can
// miss the window under load and leave Codex on its ANSI-grey fallback for the
// session. The answered queries are stripped from what is forwarded, so a
// pane never answers them a second time (live or on replay).
//
// Two layers decide the answer. The dashboard that creates a session sends its
// own resolved palette on POST /api/sessions, and the session answers from that
// for its life (#2528): `theme: "system"` resolves per browser, so two
// dashboards can disagree, and the creating one is the one the user is looking
// at. A session on a remote host is answered by that agent, which receives the
// palette in the spawn body (#2857). A session created without a palette (a Task
// Master worker, the control socket, an older primary) falls back to the one
// process-wide palette (last reporter wins), which can still be the other
// dashboard's. A
// running session is never re-answered when another pane attaches later: the
// program asked once, at startup.
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

// Per-session palettes (#2528). The startup-query window runs from the spawn,
// which can trail the set by a slow create (a GitHub App token mint), so the
// entry is not timed from the set: a long cap bounds one that never spawns, and
// the first lookup (the session's first output, inside its window) re-arms a
// short expiry. The map cannot outgrow the sessions still starting.
interface SessionPaletteEntry {
  palette: TerminalPalette;
  timer: ReturnType<typeof setTimeout>;
  armed: boolean;
}
const sessionPalettes = new Map<string, SessionPaletteEntry>();
const SESSION_PALETTE_SPAWN_CAP_MS = 10 * 60_000;
const SESSION_PALETTE_TTL_MS = 35_000;
/** `#rrggbb`. The one definition: routes/terminal-palette.ts builds its schema pattern from it. */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function expireSessionPalette(sessionId: string, afterMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => sessionPalettes.delete(sessionId), afterMs).unref();
}

/**
 * Answer `sessionId`'s startup queries from `next` instead of the process-wide
 * palette. Anything that is not three `#rrggbb` colors is ignored: these
 * strings are written into the PTY inside an OSC reply, so a non-route caller
 * (Task Master, the control socket) must not be able to inject escape bytes.
 */
export function setSessionPalette(sessionId: string, next: TerminalPalette): void {
  if (![next.foreground, next.background, next.cursor].every((c) => HEX_COLOR.test(c))) return;
  clearTimeout(sessionPalettes.get(sessionId)?.timer);
  const timer = expireSessionPalette(sessionId, SESSION_PALETTE_SPAWN_CAP_MS);
  sessionPalettes.set(sessionId, { palette: { ...next }, timer, armed: false });
}

/**
 * The palette its spawning pane gave `sessionId`, or undefined to use the
 * process-wide one. Not a pure lookup: the first call re-arms the entry's expiry
 * to 35 s, on the assumption that it is the startup-query path (the session's
 * first output); any other caller would start that clock early.
 */
export function getSessionPalette(sessionId: string): TerminalPalette | undefined {
  const entry = sessionPalettes.get(sessionId);
  if (!entry) return undefined;
  if (!entry.armed) {
    entry.armed = true;
    clearTimeout(entry.timer);
    entry.timer = expireSessionPalette(sessionId, SESSION_PALETTE_TTL_MS);
  }
  return entry.palette;
}

/** Test seam: forget the cached palette. */
export function resetTerminalPalette(): void {
  palette = null;
  for (const entry of sessionPalettes.values()) clearTimeout(entry.timer);
  sessionPalettes.clear();
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

/**
 * The replies to the startup queries in `data` and `data` without them (so the
 * browser neither answers them again live nor on replay). Nothing is answered
 * or stripped until a palette is known.
 */
export function splitStartupQueries(
  data: string,
  current: TerminalPalette | null = palette,
): { reply: string; rest: string } {
  const reply = buildStartupQueryReplies(data, current);
  return { reply, rest: reply ? data.replace(STARTUP_QUERY_RE, "") : data };
}
