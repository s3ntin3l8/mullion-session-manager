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
 * This is the matcher for systemd's `Description` rendering, which QUOTES an
 * argument containing a space. For a live process's command line — which
 * `ps` renders as raw argv, unquoted — use `isDtachCreateFor()` below
 * instead: a path with a space cannot be recovered by tokenizing there, only
 * matched.
 */
export function extractDtachSocketPath(commandLine: string): string | null {
  const match = DTACH_SOCKET_PATTERN.exec(commandLine);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * Whether a command line is a dtach invocation that CREATES the session at
 * `socketPath` — i.e. `dtach -n <socketPath> ...`.
 *
 * A raw match on the command line rather than a parse of it. `ps` renders
 * argv joined by spaces and UNQUOTED, so a socket path containing a space
 * cannot be recovered by tokenizing — the path would simply be truncated at
 * the first space, and the session would then read as "unknown" forever
 * while its agent tree kept running. But it can be MATCHED, because the path
 * is the thing being looked for in the first place.
 *
 * Two further conditions keep the match honest:
 *
 *   - argv[0] must be dtach. A process whose command line merely MENTIONS
 *     the invocation (a shell running `sh -c "dtach -n ..."`, say) is not
 *     the session's master, and teardown would then signal the wrong
 *     process.
 *   - the path must be the WHOLE argument. A longer path that merely starts
 *     with ours (`.../11.sock` against `.../1.sock`) belongs to a different
 *     session.
 */
export function isDtachCreateFor(commandLine: string, socketPath: string): boolean {
  const needle = ` -n ${socketPath}`;
  const at = commandLine.indexOf(needle);
  if (at === -1) return false;
  const argv0 = commandLine.slice(0, at);
  if (argv0 !== "dtach" && !argv0.endsWith("/dtach")) return false;
  const after = commandLine.charAt(at + needle.length);
  return after === "" || after === " ";
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
