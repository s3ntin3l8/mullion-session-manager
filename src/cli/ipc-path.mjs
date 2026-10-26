// Where a local IPC endpoint (the hook socket, the control socket, a
// session's socket, the ssh-agent socket) actually lives on this platform.
//
// Plain ESM for the same reason as sun-path.mjs next to it: `src/cli` is
// copied into `dist/` verbatim, and the rule has consumers on both sides —
// the compiled backend, which creates the endpoints, and the `mullion` CLI
// (client.mjs), which connects to the control socket. One implementation, so
// the two can never disagree about where an endpoint is. The types live in
// ipc-path.d.mts.
//
// Every endpoint is named by a FILESYSTEM path (`<sessionsDir>/hooks.sock`,
// ...) and on Linux and macOS that path IS the endpoint: a unix socket file.
// Windows has no unix sockets in Node — `net.Server.listen(path)` binds a
// named pipe there, and a pipe name must be `\\.\pipe\<name>`; a filesystem
// path is not one. So on Windows the filesystem path is mapped to a pipe
// name, deterministically, and everything else keeps naming endpoints the
// way it always has (issue #1728).
import { createHash } from "node:crypto";
import path from "node:path";

/** The namespace every named pipe lives in. */
export const PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * Whether `p` names a Windows named pipe rather than a filesystem path.
 *
 * Keyed on the path's SHAPE, not on `process.platform`: what is true of an
 * endpoint (there is no file to unlink or chmod, a missing server reads as
 * ENOENT rather than ECONNREFUSED) follows from what it IS, wherever the
 * check runs. That is also what lets the pipe branches be tested on Linux.
 * Both the `\\.\pipe\` and the `\\?\pipe\` spellings name the same
 * namespace, and either slash direction is accepted.
 */
export function isPipePath(p) {
  return /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(p);
}

/**
 * The endpoint for a filesystem socket path, on `platform`.
 *
 * Off Windows this is the path itself, unchanged. On Windows it is
 * `\\.\pipe\mullion-<hash>-<name>`, where:
 *
 *   - `<hash>` is the first 16 hex chars of the sha256 of the RESOLVED,
 *     lower-cased path. Resolved, so a relative SESSIONS_DIR names the same
 *     pipe as its absolute form; lower-cased, because Windows paths are
 *     case-insensitive and `C:\Data` and `c:\data` are one directory. The
 *     hash is what keeps two instances on one machine — an agent and a
 *     primary, or a test run — apart: pipe names are machine-global, the
 *     way systemd unit names are user-global on Linux (see deriveInstanceId).
 *   - `<name>` is the socket's own file name without `.sock`, so a pipe
 *     listing still says which endpoint is which.
 *
 * A path that already names a pipe is taken as given, so an operator's
 * explicit `MULLION_SOCKET_PATH=\\.\pipe\...` is honoured and the mapping is
 * safe to apply twice. Its slashes are normalised to backslashes, the only
 * spelling the pipe namespace accepts.
 */
export function ipcPath(fsPath, platform = process.platform) {
  if (platform !== "win32") return fsPath;
  if (isPipePath(fsPath)) return fsPath.replace(/\//g, "\\");
  const resolved = path.win32.resolve(fsPath).toLowerCase();
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  const name = path.win32.basename(resolved, ".sock");
  return `${PIPE_PREFIX}mullion-${hash}-${name}`;
}
