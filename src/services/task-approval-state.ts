import { isApprovingVerdict } from "./task-prompt.js";
import { hasIngestedCurrentReview } from "./task-review-handle.js";

export type ApprovalState = "awaiting-human" | "auto-pending";

export interface ApprovalStateRow {
  status: string;
  prNumber: number | null;
  reviewSessionId: number | null;
  reviewFindingsIngestedSessionId: number | null;
  reviewRunId: string | null;
  reviewRunIngestedId: string | null;
  lastReviewVerdict: string | null;
  projectAutoApprove: boolean | null;
}

// #2234 — an approving review whose findings are in leaves the task waiting
// on an approval. `awaiting-human` = a human has to Approve. `auto-pending` =
// the approve sweep (task-reconciler.ts's processAutoApprovals) will take it,
// so it applies that sweep's own gates: the project auto-approves, the task
// has a PR number, and Task Master is enabled. If the project auto-approves
// but a gate fails (no PR yet, Task Master off) the sweep will never act, so
// the honest state is `awaiting-human`, not a promise the machine won't keep.
// Shared by the board (routes/tasks.ts) and the approval push
// (notifyApprovalsAwaitingHuman, #2252) so the two can never disagree.
export function deriveApprovalState(
  row: ApprovalStateRow,
  taskMasterEnabled: boolean,
): ApprovalState | null {
  const approved =
    row.status === "reviewing" &&
    hasIngestedCurrentReview(row) &&
    isApprovingVerdict(row.lastReviewVerdict);
  if (!approved) return null;
  const sweepWillApprove = !!row.projectAutoApprove && row.prNumber !== null && taskMasterEnabled;
  return sweepWillApprove ? "auto-pending" : "awaiting-human";
}

export type ReviewPhase = "rebasing" | "awaiting-review" | "no-reviewer";

export interface ReviewPhaseRow {
  status: string;
  reviewSessionId: number | null;
  /** An external reviewer's run (#2369); optional so a row that omits it reads as none. */
  reviewRunId?: string | null;
  rebaseStartedAt: Date | null;
  worktreePath: string | null;
}

/** What the spawn pass needs to be willing to start a reviewer at all. */
export interface ReviewPhaseContext {
  taskMasterEnabled: boolean;
  /** A review agent resolves for this task (task / issue body / project / install). */
  reviewerConfigured: boolean;
}

/**
 * The spawn pass's own eligibility for a task, as ONE predicate:
 * `processPendingReviewSpawns` (task-reconciler.ts) asks it before starting a
 * reviewer, and `deriveReviewPhase` asks it before announcing one is coming, so
 * the two cannot drift. Task Master on, a worktree to review in, and a review
 * agent that resolves. (The rebase hold-back and the CI wait are timing, not
 * eligibility, and stay with their own callers.)
 */
export function canSpawnReviewer(
  row: { worktreePath: string | null },
  ctx: ReviewPhaseContext,
): boolean {
  return ctx.taskMasterEnabled && ctx.reviewerConfigured && row.worktreePath !== null;
}

export interface ReviewPhaseResult {
  reviewPhase: ReviewPhase | null;
  /** Epoch ms when the held-back reviewer becomes eligible to spawn; set only while `rebasing`. */
  reReviewAt: number | null;
}

// A `reviewing` task with no live review session is waiting, not stuck, but
// nothing in the payload said so. After an auto-rebase (attemptAutoRebase
// clears reviewSessionId) the fresh reviewer is held back until
// `rebaseStartedAt` is older than the stale window — the same gate
// processPendingReviewSpawns applies, so `staleMs` is passed in rather than
// duplicated (task-reconciler.ts imports this module, so it can't import the
// constant back). `rebasing` = inside that window; `awaiting-review` = no
// reviewer yet and no rebase holding it (CI wait / pending spawn).
//
// Like deriveApprovalState, only a promise the machine will keep: when the
// spawn pass would never start a reviewer (`canSpawnReviewer`) there is no
// "re-review" or "waiting" phase to announce. Task Master off, or no worktree,
// says nothing. A task with Task Master on and a worktree but NO review agent
// is `no-reviewer`: the one state where the drawer should say why nothing will
// start (a human reviews it), instead of going silent.
export function deriveReviewPhase(
  row: ReviewPhaseRow,
  staleMs: number,
  ctx: ReviewPhaseContext,
  now: number = Date.now(),
): ReviewPhaseResult {
  const none = { reviewPhase: null, reReviewAt: null };
  if (row.status !== "reviewing" || row.reviewSessionId !== null) return none;
  // A dispatched run is a live review, like a session: nothing is "coming".
  if (typeof row.reviewRunId === "string") return none;
  if (!canSpawnReviewer(row, ctx)) {
    return ctx.taskMasterEnabled && row.worktreePath !== null
      ? { reviewPhase: "no-reviewer", reReviewAt: null }
      : none;
  }
  if (row.rebaseStartedAt !== null) {
    const reReviewAt = row.rebaseStartedAt.getTime() + staleMs;
    if (now < reReviewAt) return { reviewPhase: "rebasing", reReviewAt };
  }
  return { reviewPhase: "awaiting-review", reReviewAt: null };
}
