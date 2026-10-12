import { realpathSync } from "node:fs";
import path from "node:path";

// Issue #895 — extracted from routes/project-setup.ts so the SAME
// containment guard project-setup.ts's own local scaffold writes have
// always used can also gate routes/internal.ts's new /internal/read-files
// and /internal/write-files handlers (the agent-side implementation of a
// remote host's own local write/read, which must apply the identical
// "never escape the worktree root" rule project-setup.ts's own resolveWithin
// doc comment already argued for). No behavior change for any existing
// caller — see that file's own `__testing.resolveWithin` re-export, which
// keeps test/routes/project-setup.test.ts's import path working unchanged.

export class PathEscapeError extends Error {
  constructor(root: string, relPath: string) {
    super(`Refusing to resolve "${relPath}" outside of "${root}"`);
    this.name = "PathEscapeError";
  }
}

/** Joins `root` and `relPath`, then verifies the result is still inside
 * `root` before returning it — CodeQL (js/path-injection), PR #896: every
 * caller of this function validates its own inputs upstream (project-
 * setup.ts's slug-derived scaffold paths; internal.ts's own ScaffoldEntry
 * paths, which travel over the wire from the primary but still get the
 * same treatment as defense in depth) — so this is defense-in-depth rather
 * than the only guard, but a manual containment check right at the join,
 * not just an earlier regex check several frames away, is the shape CodeQL
 * (and a future reader) can actually verify by looking at THIS line alone.
 * Throws PathEscapeError rather than silently truncating or refusing. */
export function resolveWithin(root: string, relPath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new PathEscapeError(resolvedRoot, relPath);
  }
  return target;
}

/** Resolves a symlink's `target` (interpreted, as the OS does, relative to
 * the symlink's OWN directory — not `root`) and verifies the result still
 * lands inside `root` — mullion-reviewer review, PR #1102: the naive
 * `resolveWithin(root, path.join(path.dirname(symlinkRelPath), target))`
 * this replaces is unsound for an ABSOLUTE `target`. `path.join`, unlike
 * `path.resolve`, does not reset on an absolute second argument —
 * `path.join("a", "/etc/passwd")` silently produces `"a/etc/passwd"` — so
 * the pre-join approach validated a mangled, always-safe-looking relative
 * string while `symlinkSync` itself would still receive and honor the real,
 * unmangled absolute `target` verbatim. This function instead resolves
 * `target` with `path.resolve` (which correctly discards the base and
 * anchors at `target` itself when `target` is absolute), so an absolute
 * escape attempt is checked as what it actually is and rejected the same
 * way a relative `../` escape already is. `symlinkRelPath` itself is
 * assumed already validated (e.g. via `resolveWithin`) — this function only
 * checks where the link POINTS, not where it LIVES. */
export function resolveSymlinkTargetWithin(
  root: string,
  symlinkRelPath: string,
  target: string,
): string {
  const resolvedRoot = path.resolve(root);
  const symlinkDir = path.dirname(path.resolve(resolvedRoot, symlinkRelPath));
  const resolvedTarget = path.resolve(symlinkDir, target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new PathEscapeError(resolvedRoot, target);
  }
  return resolvedTarget;
}

/**
 * A symlink-tolerant realpath: resolves every symlink in the deepest
 * EXISTING prefix of `absPath`, then appends whatever tail doesn't exist yet
 * unchanged (a nonexistent path component can't itself be a symlink, so
 * there's nothing left to resolve once the walk hits one). Node's own
 * fs.realpathSync throws ENOENT the instant any component is missing, which
 * doesn't work for resolveWithinRoots below — a project cwd or one of its
 * `.crs/`-relative sinks is frequently a path that doesn't exist yet (a
 * fresh project with no `.crs/dock.json` written, a PROJECTS_ROOTS entry
 * that hasn't been created on this particular agent host). Mirrors the tail
 * behavior of Python's `os.path.realpath(strict=False)`, applied one
 * component at a time so each step's containment check sees the FULLY
 * resolved parent, not a lexical guess (issue #604).
 *
 * Only ENOENT is treated as "doesn't exist yet, fall back to lexical" —
 * every other errno (EACCES, ELOOP on a symlink cycle, ENOTDIR, ...)
 * propagates instead (Hermes review, PR #612). The original catch-all here
 * would have silently reused the lexical fallback for those too, which is
 * wrong in a different way than the ENOENT case: those errors mean "this
 * component's real target is unknown or unreachable," not "there's nothing
 * here yet" — treating them the same could pass containment on a value that
 * was never actually verified, only guessed at. The caller
 * (resolveWithinRoots) turns any such throw into a clean 400 rather than
 * this silently returning something that happens to pass, or an uncaught
 * exception surfacing as a 500 at the sink.
 */
export function realpathExistingPrefix(absPath: string): string {
  const root = path.parse(absPath).root;
  const segments = absPath.slice(root.length).split(path.sep).filter(Boolean);
  let real = root;
  for (let i = 0; i < segments.length; i++) {
    const candidate = path.join(real, segments[i]);
    try {
      real = realpathSync(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // candidate doesn't exist — every remaining segment is a path we'd be
      // creating, not one that could already be a pre-planted symlink, so
      // append the rest lexically and stop walking.
      return path.join(real, ...segments.slice(i));
    }
  }
  return real;
}
