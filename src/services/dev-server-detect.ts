import type { FastifyInstance } from "fastify";

// Scans a project's dock-session PTY output for the startup banner a dev
// server prints once it's actually listening — issue #28's "pre-fill the
// manual devServerUrl field" nice-to-have (phase 7). Deliberately reads the
// buffer PtyManager already keeps (Session.getScrollback(), the same one
// terminal.ts replays to a newly-attaching client) rather than adding a new
// per-chunk tap the way attention-detect.ts's detectAttentionSignals hooks
// Session.attachClient's onData — this only ever needs "the latest port
// mentioned so far," not a live stream of signals, so an on-demand scan of
// the existing ring buffer is the simpler, less invasive fit.
//
// Vite, Next.js, Create React App, and Astro all print a line containing
// the word "Local" and a `http(s)://localhost:<port>` (or `127.0.0.1`)
// URL, just with different labels/punctuation around it:
//   Vite:   "  ➜  Local:   http://localhost:5173/"
//   Next:   "   - Local:        http://localhost:3000"
//   CRA:    "  Local:            http://localhost:3000"
//   Astro:  "  ┃ Local    http://localhost:4321/"
// The regex below only requires the word "Local" (case-insensitive) to
// appear somewhere before the URL on the same line — deliberately loose
// about the punctuation/whitespace between them — so it covers all four
// without a framework-specific parser each.
const DEV_SERVER_BANNER_LINE =
  /\bLocal\b[^\n]*?https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?\/?/gi;

// Strips ANSI CSI/SGR sequences (the `\x1b[<params><letter>` escapes chalk/
// picocolors emit for color/bold) before matching. This is load-bearing, not
// cosmetic: `detectDevServerPortForSessionIds` reads a *real PTY's*
// scrollback (see its own comment), and a PTY is a genuine TTY — every
// framework colors its banner there by default. Vite specifically bolds
// just the word "Local" and just the port digits (`\x1b[1mLocal\x1b[22m:` /
// `localhost:\x1b[1m5173\x1b[22m/`), which broke detection two different
// ways when this wasn't stripped: the SGR code's own trailing "m" is a word
// character, so it silently merges with "Local" and defeats `\bLocal\b`'s
// leading boundary outright (no match at all, not just no capture); and the
// escape bytes sitting between ":" and the port digits break
// `(?::(\d{1,5}))?`'s adjacency, so even when "Local" is unstyled the port
// group fails to capture. Confirmed against `make dev`'s actual PTY output
// (a real Vite CLI, not a hand-written fixture) — every prior test fixture
// here was plain, unstyled text and never exercised this. The `?` in the
// parameter class covers DEC private-mode sequences too (e.g. the
// `\x1b[?1049l` screen-mode preamble getScrollback() now always prepends —
// see pty-manager.ts, issue #83) — without it, that preamble's own `?`
// falls outside `[0-9;]` and survives the strip, sitting as harmless junk
// ahead of the real banner text but leaving the strip inconsistent about
// what counts as a CSI sequence.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_SEQUENCE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/**
 * Returns the port from the *last* "Local: http://..." banner line in
 * `text`, or null if none appears. "Last," not "first," matters: a dev
 * server that restarts (a config change, a crash-and-relaunch) reprints its
 * banner, sometimes on a different port if the original was still in use —
 * only the most recent one is still accurate.
 */
export function parseDevServerPort(text: string): string | null {
  const plain = text.replace(ANSI_ESCAPE_SEQUENCE, "");
  let lastPort: string | null = null;
  for (const match of plain.matchAll(DEV_SERVER_BANNER_LINE)) {
    if (match[1]) lastPort = match[1];
  }
  return lastPort;
}

/**
 * Looks up each of a project's dock-session ids in this process's own
 * PtyManager (app.pty.get) and returns the first detected port among them,
 * or null. Only ever meaningful for a *local*-host project — see
 * pty-manager.ts's own scoping: `app.pty` only tracks sessions this process
 * has itself spawned/attached to, and a remote-hosted project's dock
 * session lives in a different process's PtyManager entirely, with no
 * scrollback-read path exposed through RemoteHostClient today. Callers are
 * expected to skip this for a non-local project rather than call it with
 * an empty list (see routes/projects.ts).
 */
export function detectDevServerPortForSessionIds(
  app: FastifyInstance,
  dockSessionIds: string[],
): string | null {
  for (const id of dockSessionIds) {
    const session = app.pty.get(id);
    if (!session) continue;
    const port = parseDevServerPort(session.getScrollback().toString("utf8"));
    if (port) return port;
  }
  return null;
}
