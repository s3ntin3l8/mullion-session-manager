import { isApprovingVerdict } from "./task-prompt.js";
import { hasIngestedCurrentReview } from "./task-review-handle.js";

export type ApprovalState = "awaiting-human" | "auto-pending";

export interface ApprovalStateRow {
  status: string;
  prNumber: number | null;
  reviewSessionId: number | null;
  reviewFindingsIngestedSessionId: number | null;
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
