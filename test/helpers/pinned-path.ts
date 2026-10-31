import path from "node:path";

/**
 * The directories a sandboxed child may resolve commands through: the
 * system's own, never the caller's. A shim earlier on the shell that started
 * vitest (an agent runtime's recoverable-delete `rm`, a corporate `git`
 * wrapper, a version manager's `node`) would otherwise become the binary a
 * test exercises (issues #2422, #2439).
 */
export const TRUSTED_SYSTEM_DIRS = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
] as const;

/**
 * A `PATH` that does not depend on the inherited one: the suite's own shim
 * dirs first (in the order given), then `TRUSTED_SYSTEM_DIRS`. Pass an
 * absolute path to anything that must come from elsewhere (e.g.
 * `process.execPath` for node) rather than adding a directory here.
 */
export function pinnedPath(...shimDirs: string[]): string {
  return [...shimDirs, ...TRUSTED_SYSTEM_DIRS].join(path.delimiter);
}
