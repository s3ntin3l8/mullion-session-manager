import path from "node:path";
import fs from "node:fs/promises";

/** Resolve an existing ancestor without blocking the event loop. */
export async function canonicalWorktreePath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  let prefix = resolved;
  for (;;) {
    try {
      // This only resolves directory metadata for the usage guard; it does
      // not read or modify file content. Registered-worktree membership is
      // independently checked before removal (CodeQL alert #430).
      const real = await fs.realpath(prefix);
      return path.resolve(real, path.relative(prefix, resolved));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink is not a missing ordinary path: its target may
      // have just moved, so its location is unknown rather than lexical.
      const brokenLink = await fs.lstat(prefix).then(
        (stat) => stat.isSymbolicLink(),
        (err: unknown) => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw err;
        },
      );
      if (brokenLink) throw error;
      const parent = path.dirname(prefix);
      if (parent === prefix) throw error;
      prefix = parent;
    }
  }
}

export type WorktreePathRelation = "inside" | "outside" | "unknown";
export type WorktreePathCandidate = { id: string; cwd: string | null };

/** Compare on the owning host, using its filesystem and path conventions. */
export async function compareWorktreePaths(
  target: string,
  candidates: WorktreePathCandidate[],
  allowed: (path: string) => boolean,
  liveCwd: (id: string) => string | null,
): Promise<WorktreePathRelation[]> {
  if (!path.isAbsolute(target) || !allowed(target)) return candidates.map(() => "unknown");
  let root: string;
  try {
    root = await fs.realpath(target);
  } catch {
    return candidates.map(() => "unknown");
  }
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const resolvedRoot = normalize(root);
  const results: WorktreePathRelation[] = Array(candidates.length).fill("unknown");
  const resolved = new Map<string, Promise<string | null>>();
  const resolve = (value: string): Promise<string | null> => {
    const cached = resolved.get(value);
    if (cached) return cached;
    const pending = (async () => {
      if (!path.isAbsolute(value) || !allowed(value)) return null;
      try {
        return normalize(await fs.realpath(value));
      } catch {
        return null;
      }
    })();
    resolved.set(value, pending);
    return pending;
  };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, candidates.length) }, async () => {
      for (;;) {
        const index = next++;
        const candidate = candidates[index];
        if (!candidate) return;
        const { id, cwd } = candidate;
        const live = liveCwd(id);
        if (!cwd) continue;
        let unknown = false;
        for (const value of [cwd, live].filter((value): value is string => value !== null)) {
          const canonical = await resolve(value);
          if (canonical === null) {
            unknown = true;
            continue;
          }
          if (canonical === resolvedRoot || canonical.startsWith(resolvedRoot + path.sep)) {
            results[index] = "inside";
            break;
          }
        }
        if (results[index] !== "inside" && !unknown && liveCwd(id) === live)
          results[index] = "outside";
      }
    }),
  );
  return results;
}
