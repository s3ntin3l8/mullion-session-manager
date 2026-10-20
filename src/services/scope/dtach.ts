import path from "node:path";

/**
 * The dtach conventions, shared by the scope backends.
 *
 * A "scope" on this platform is a `dtach` session: dtach creates a unix
 * socket, forks a master that holds the pty, and serves the socket to
 * whoever attaches. The master is the process that owns the session, and its
 * command line names the socket it serves — which is what makes the socket
 * path the scope's identity here, the same anchor the systemd backend uses
 * (it recovers the same path from the scope's `Description`, which is
 * systemd's own rendering of the argv).
 *
 * These live in their own module rather than in `session-process.ts` so the
 * systemd backend and the detached (macOS) backend share ONE definition of
 * them — a second hand-rolled copy of this pattern would drift from the
 * first silently over time.
 */

/**
 * A dtach session master's argv: `dtach -n <socket> <command...>`.
 *
 * The `-n` ("new session") form creates a session; the `-a` ("attach") form
 * attaches a client to one. Only `-n` identifies a MASTER, which is what
 * makes this the right thing to match on: an attach client (`dtach -a
 * <socket> ...`) names the same socket and must never be mistaken for the
 * master.
 *
 * The three alternatives are the three ways the path can appear: bare
 * (`/path/to/1.sock`), double-quoted, or single-quoted. A `ps` table renders
 * the raw argv, so the bare form is what actually shows up there; the
 * quoted forms are what systemd's `Description` rendering produces (see
 * `session-process.ts`), and accepting both means one pattern serves both
 * sources.
 */
const DTACH_SOCKET_PATTERN = /dtach\s+-n\s+(?:"([^"]+)"|'([^']+)'|(\S+))/;

/**
 * Recovers the dtach socket path a command line names, or null if it names
 * none.
 *
 * Shared by the two places that need it: the systemd backend, which reads
 * it out of a scope's `Description`, and the detached backend, which reads it
 * out of a live process's command line.
 */
export function extractDtachSocketPath(commandLine: string): string | null {
  const match = DTACH_SOCKET_PATTERN.exec(commandLine);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * The socket path for a session id.
 *
 * ONE definition of the convention, so the backend that looks for a
 * session's master and the code that creates the session cannot disagree
 * about where that session's socket lives.
 */
export function sessionSocketPath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.sock`);
}
