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
