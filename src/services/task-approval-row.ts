import type { FastifyInstance } from "fastify";
import {
  deriveApprovalState,
  deriveReviewPhase,
  type ReviewPhaseResult,
  type ApprovalState,
  type ApprovalStateRow,
} from "./task-approval-state.js";
import { resolveReviewer } from "./task-agent-resolve.js";
import { isUnsentRunId } from "./hermes-task-review.js";
import { REBASE_ATTEMPT_STALE_MS } from "./task-reconciler.js";

// #2234 — the board's `approvalState`; the derivation lives in
// services/task-approval-state.ts so the #2252 push shares it.
export function withApprovalState<
  T extends ApprovalStateRow & {
    rebaseStartedAt: Date | null;
    worktreePath: string | null;
    reviewAgent: string | null;
    body: string | null;
    projectDefaultReviewAgent: string | null;
  },
>(
  app: FastifyInstance,
  row: T,
  taskMasterEnabled: boolean,
): Omit<T, "projectAutoApprove" | "projectDefaultReviewAgent"> & {
  approvalState: ApprovalState | null;
  /** The review run id is a synthetic `unsent:` marker: dispatch gave up, no run exists. */
  reviewRunUnsent: boolean;
} & ReviewPhaseResult {
  const {
    projectAutoApprove: _projectAutoApprove,
    projectDefaultReviewAgent: _projectDefaultReviewAgent,
    ...rest
  } = row;
  // Only a reviewing task with no live review session can carry a phase.
  // Resolving the reviewer is an uncached settings read per call, and this runs
  // for every row of the polled task list (done and archived included), so the
  // cheap checks come first.
  const canCarryPhase =
    row.status === "reviewing" &&
    row.reviewSessionId === null &&
    typeof row.reviewRunId !== "string";
  return {
    ...rest,
    approvalState: deriveApprovalState(row, taskMasterEnabled),
    reviewRunUnsent: typeof row.reviewRunId === "string" && isUnsentRunId(row.reviewRunId),
    ...deriveReviewPhase(row, REBASE_ATTEMPT_STALE_MS, {
      taskMasterEnabled,
      // The same resolution the spawn pass uses (processPendingReviewSpawns).
      reviewerConfigured:
        canCarryPhase &&
        resolveReviewer(app, {
          taskReviewAgent: row.reviewAgent,
          issueBody: row.body,
          projectDefaultReviewAgent: row.projectDefaultReviewAgent,
        }) !== null,
    }),
  };
}
