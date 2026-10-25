import type { Project, Session } from "../api/index.js";
import { isWithin, normalizeAbs, relativeAbs } from "./posixPath.js";

// Where Mullion puts a session's own git worktree inside a project
// (services/git-worktree.ts) — a checkout, not a subfolder of the main one.
const WORKTREE_DIR = ".mullion-worktrees";

/** The root a session works in when that is NOT the project's own checkout
 * (a git worktree, inside the project's `.mullion-worktrees/` or elsewhere),
 * else null. A session merely started in a subfolder of the project still
 * edits the project's checkout, so it isn't a different root. */
export function sessionCheckoutRoot(
  session: Pick<Session, "cwd">,
  project: Pick<Project, "cwd">,
): string | null {
  if (!session.cwd) return null;
  const cwd = normalizeAbs(session.cwd);
  const root = normalizeAbs(project.cwd);
  if (cwd === root) return null;
  if (!isWithin(root, cwd)) return cwd;
  return relativeAbs(root, cwd).startsWith(`${WORKTREE_DIR}/`) ? cwd : null;
}

/** The session a dockview panel belongs to, if it is one that is tied to a
 * session's checkout: its terminal / timeline / browser panes, and the
 * editor-only file panels opened from a session-rooted tree (`file-<project>-
 * @<session>-<path>`). */
export function sessionIdOfPanel(panelId: string | null): number | null {
  if (!panelId) return null;
  const m =
    panelId.match(/^(?:session|timeline|browserPane)-(\d+)$/) ?? panelId.match(/^file-\d+-@(\d+)-/);
  return m ? parseInt(m[1]!, 10) : null;
}
