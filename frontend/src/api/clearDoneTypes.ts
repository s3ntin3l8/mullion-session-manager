// #746 — per-branch result inside POST /api/tasks/clear-done's response.
export interface ClearDoneBranchResult {
  id: number;
  branch: string;
  deleted: boolean;
  reason?: string;
  /** For `outcome-unknown`: the host's "may have been delivered" sentence. */
  detail?: string;
}
