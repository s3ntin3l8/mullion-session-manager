// Absolute-path rules for a path on ANOTHER host (`projects.hostCwds`). Pure
// and dependency-free: the backend validators and the Edit project modal share
// it, so the dialog never refuses what the API accepts (or the reverse).

/** Longest path stored in `hostCwds`. */
export const MAX_HOST_PATH_LENGTH = 4096;

/** Schema `pattern` for an absolute POSIX path or a Windows drive path
 * (`D:\x` or `D:/x`). `isStorablePath` stays the real validator. */
export const ABSOLUTE_HOST_PATH_PATTERN = "^(/|[A-Za-z]:[\\\\/])";

/** Absolute on either flavour: POSIX `/x` or a Windows drive path. UNC and
 * drive-relative (`D:x`) paths are not. */
export function isAbsoluteHostPath(cwd: string): boolean {
  return cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd);
}

/** A path that is safe to store in `hostCwds`: absolute (POSIX, or a Windows
 * drive path), bounded, no control characters and no `..` segment. */
export function isStorablePath(cwd: string): boolean {
  if (cwd.length > MAX_HOST_PATH_LENGTH || /[\0\r\n]/.test(cwd)) return false;
  if (cwd.startsWith("/")) return !cwd.split("/").includes("..");
  if (/^[A-Za-z]:[\\/]/.test(cwd)) return !cwd.split(/[\\/]/).includes("..");
  return false;
}

/** The identity of a path on another host, for comparing two spellings of the
 * same location. Doubled and trailing separators fold on every path. A Windows
 * drive path is also case-insensitive and takes either separator, so
 * `D:\\Projects\\x`, `d:/projects/x/` and `D:/Projects//x` are one key; a POSIX
 * path stays case-sensitive, and its backslash is an ordinary name character.
 * Chosen by the path's shape, not by the host's platform (which can be
 * unknown). */
export function hostPathKey(cwd: string): string {
  const drive = /^[A-Za-z]:[\\/]/.test(cwd);
  const folded = drive ? cwd.replace(/[\\/]+/g, "/") : cwd.replace(/\/{2,}/g, "/");
  // A root (`/`, `d:/`) keeps its one separator; anything longer loses a trailing
  // one. Doubled separators are already folded, so there is at most one, and no
  // regex is needed (a `/+$` strip is quadratic on a long run of slashes).
  const rootLength = drive ? "d:/".length : "/".length;
  const trimmed = folded.length > rootLength && folded.endsWith("/") ? folded.slice(0, -1) : folded;
  return drive ? trimmed.toLowerCase() : trimmed;
}

/** Whether two paths on the same host name the same location. */
export function sameHostPath(a: string, b: string): boolean {
  return hostPathKey(a) === hostPathKey(b);
}

/** The last segment of a path on another host. A Windows drive path splits on
 * both separators and ignores trailing ones (`D:\\Projects\\Runway` ->
 * `Runway`, `D:\\` -> ``); anything else is POSIX `path.basename`, where a
 * backslash is an ordinary name character. */
export function hostPathBasename(cwd: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(cwd)) {
    // POSIX `path.basename`, by hand: this file is shared with the browser.
    let end = cwd.length;
    while (end > 0 && cwd[end - 1] === "/") end--;
    return cwd.slice(cwd.lastIndexOf("/", end - 1) + 1, end);
  }
  const parts = cwd.slice(2).split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}
