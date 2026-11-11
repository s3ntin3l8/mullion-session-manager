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
