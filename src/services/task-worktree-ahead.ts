// Whether a Task Master worktree holds commits its pull request does not.
//
// A Hermes review reads a clone of the PR's head, so commits that never reached
// the PR (a push held for workflow approval, a refused push) are invisible to
// it. "Ahead" is deliberately one-directional: a PR head the worktree lacks (a
// push from another checkout, GitHub's "Update branch") or a diverged one must
// NOT read as ahead, because the retry that follows is a force-with-lease push
// that would rewind the PR.
import type { FastifyInstance } from "fastify";
import type { tasks } from "../db/schema.js";
import { isAncestorOf, resolveCommitSha } from "./git-refs.js";
import { resolveHostGitLog } from "./host-git.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { resolveTaskWorkerHost } from "./session-live-info.js";

type TaskRow = typeof tasks.$inferSelect;

/** How far back a remote worktree's history is read to find the PR head. */
const REMOTE_LOG_WINDOW = 200;

export interface WorktreeAhead {
  /** True only when the PR head is a strict ancestor of the worktree's tip. */
  ahead: boolean;
  /** The tip that was compared, for logging; null when it could not be read. */
  tip: string | null;
}

/**
 * Compares the task branch's tip with the PR head. Any unreadable input reads
 * as "not ahead" (the old behavior: review the PR head as it is).
 *
 * Local worktrees are compared by `refs/heads/<branch>`, the ref the push
 * sends, not HEAD (a rebase stopped on a conflict leaves HEAD detached at the
 * new base). A remote host reports only HEAD, so there the PR head must appear
 * in HEAD's recent history.
 */
export async function worktreeAheadOfPr(
  app: FastifyInstance,
  task: TaskRow,
  prHeadSha: string,
): Promise<WorktreeAhead> {
  const none: WorktreeAhead = { ahead: false, tip: null };
  if (!task.worktreePath || !task.branchName) return none;
  const hostId = resolveTaskWorkerHost(app, task);
  if (hostId === LOCAL_HOST_ID) {
    const tip = await resolveCommitSha(task.worktreePath, `refs/heads/${task.branchName}`);
    if (!tip) return none;
    if (tip === prHeadSha) return { ahead: false, tip };
    return { ahead: await isAncestorOf(task.worktreePath, prHeadSha, tip), tip };
  }
  const result = await resolveHostGitLog(app, hostId, task.worktreePath, {
    skip: 0,
    limit: REMOTE_LOG_WINDOW,
    scope: "head",
  });
  if (!result.ok || result.value.forbidden) return none;
  const shas = (result.value.value ?? []).map((c) => c.sha);
  const tip = shas[0] ?? null;
  if (tip === null || tip === prHeadSha) return { ahead: false, tip };
  return { ahead: shas.includes(prHeadSha), tip };
}
