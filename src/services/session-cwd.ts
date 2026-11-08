// Session cwd containment helpers (issue #2713). Split out of
// session-lifecycle.ts so execution-context.ts can use them without importing
// the lifecycle module, which sits above it.
import { realpathSync } from "node:fs";
import { listWorktrees } from "./git-refs.js";
import { LOCAL_HOST_ID } from "./host-registry.js";

/**
 * Issue #1332 — the one exception to a child spawn's cwd containment: a
 * directory that is itself a registered git worktree of the project's own
 * repository (`git worktree list` run from `project.cwd`, so membership is
 * decided by git's own registry, never a caller-supplied path). Anything
 * else — an arbitrary path, an unregistered checkout of the same repo, a
 * subdirectory *of* a sibling worktree — stays rejected. Symlinks are
 * resolved on both sides so a link can't masquerade as a listed worktree.
 * Local hosts only: `listWorktrees` shells out on this machine, so a remote
 * host's project keeps the strict containment rule.
 */
export async function isSiblingWorktreeCwd(
  project: { cwd: string; hostId: string },
  effectiveCwd: string,
): Promise<boolean> {
  if (project.hostId !== LOCAL_HOST_ID) return false;
  const worktrees = await listWorktrees(project.cwd);
  if (!worktrees) return false;
  let target: string;
  try {
    target = realpathSync(effectiveCwd);
  } catch {
    return false;
  }
  return worktrees.some((wt) => {
    try {
      return realpathSync(wt.path) === target;
    } catch {
      return false;
    }
  });
}
