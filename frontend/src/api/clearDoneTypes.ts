// #746 — per-branch result inside POST /api/tasks/clear-done's response.
export interface ClearDoneBranchResult {
  id: number;
  branch: string;
  deleted: boolean;
  reason?: string;
}
