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

/**
 * Returns the port from the *last* "Local: http://..." banner line in
 * `text`, or null if none appears. "Last," not "first," matters: a dev
 * server that restarts (a config change, a crash-and-relaunch) reprints its
 * banner, sometimes on a different port if the original was still in use —
 * only the most recent one is still accurate.
 */
export function parseDevServerPort(text: string): string | null {
  let lastPort: string | null = null;
  for (const match of text.matchAll(DEV_SERVER_BANNER_LINE)) {
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
