import type { Session } from "../../api/index.js";

/** Ended sessions that still own a worktree nobody has reclaimed. */
export function keptSessionWorktrees(sessions: Session[]): Session[] {
  return sessions.filter(
    (s) => s.status !== "active" && !!s.worktreeBranch && !s.worktreeReclaimedAt && !!s.cwd,
  );
}
