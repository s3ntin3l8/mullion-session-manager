import { useState } from "react";
import { ApiError } from "../api/index.js";
import type { ClearDoneResult } from "../api/index.js";

// The board's "Clear done" action with its two-step confirm, split out of the former
// TasksToolbar (#2840) so it can live inside the Display menu on desktop and inside
// the filter sheet on phone. Unchanged behaviour: it deletes done tasks in the
// current project filter, loops on the server's batch cap, and names the
// awaiting-merge tasks it would orphan.
export function ClearDoneControl({
  activeProjectIds,
  awaitingMergeCount,
  clearDoneTasks,
}: {
  // Empty array means "no project filter active" (passed through as `undefined`).
  activeProjectIds: number[];
  awaitingMergeCount: number;
  clearDoneTasks: (opts?: {
    projectIds?: number[];
    deleteBranches?: boolean;
  }) => Promise<ClearDoneResult>;
}) {
  // #746 — same two-step confirm shape TaskDetail.tsx's own
  // DeleteTaskAction uses. `deleteBranches` defaults off (records preserved
  // unless explicitly asked to also clean up branches). Loops on the
  // server's own batch cap (20/call, `result.remaining`) here rather than
  // surfacing "call again" as a user-visible step — the caller sees one
  // "Clearing…" state regardless of how many rows are behind it.
  const [clearConfirming, setClearConfirming] = useState(false);
  const [clearDeleteBranches, setClearDeleteBranches] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [clearResult, setClearResult] = useState<{
    deleted: number;
    failed: { id: number; error: string }[];
    branches: ClearDoneResult["branches"];
  } | null>(null);

  const runClearDone = async () => {
    setClearing(true);
    setClearError(null);
    setClearResult(null);
    const projectIds = activeProjectIds.length > 0 ? activeProjectIds : undefined;
    const deleted: number[] = [];
    const failed: { id: number; error: string }[] = [];
    const branches: ClearDoneResult["branches"] = [];
    try {
      let remaining = 1;
      while (remaining > 0) {
        const result = await clearDoneTasks({ projectIds, deleteBranches: clearDeleteBranches });
        deleted.push(...result.deleted);
        failed.push(...result.failed);
        branches.push(...result.branches);
        remaining = result.remaining;
        // A pass that made zero progress (every candidate in this batch
        // failed, none deleted) but still reports a remainder would
        // otherwise spin forever re-attempting the same un-deletable rows —
        // e.g. every row rate-limited, or a relabeled GitHub issue that
        // conflicts on every pass.
        if (result.deleted.length === 0) break;
      }
      // No explicit refresh call here — the store's clearDoneTasks action
      // (useDashboardStore's tasks slice) already calls refreshTasks()
      // itself, same as every other task mutation in that slice.
      setClearResult({ deleted: deleted.length, failed, branches });
    } catch (err) {
      setClearError(err instanceof ApiError ? err.message : "Failed to clear done tasks");
    } finally {
      setClearing(false);
      setClearConfirming(false);
    }
  };

  return (
    <>
      {!clearConfirming ? (
        <button
          type="button"
          className="tasks-panel-clear-done-btn"
          onClick={() => {
            setClearConfirming(true);
            setClearResult(null);
            setClearError(null);
          }}
        >
          Clear done
        </button>
      ) : (
        <div className="tasks-panel-clear-done-confirm">
          <span className="task-detail-hint">
            Delete every done task{activeProjectIds.length > 0 ? " in the current filter" : ""}?
            This can't be undone.
            {awaitingMergeCount > 0 &&
              ` ${awaitingMergeCount} of them still ${awaitingMergeCount === 1 ? "has an open PR" : "have open PRs"} awaiting merge — clearing only deletes Mullion's record, the PR${awaitingMergeCount === 1 ? "" : "s"} would drop off the board.`}
          </span>
          <label className="tasks-panel-clear-done-branches">
            <input
              type="checkbox"
              checked={clearDeleteBranches}
              disabled={clearing}
              onChange={(e) => setClearDeleteBranches(e.target.checked)}
            />
            Also delete local branches for merged PRs
          </label>
          <button
            className="notif-gate-btn notif-gate-deny-confirm"
            disabled={clearing}
            onClick={() => void runClearDone()}
          >
            {clearing ? "Clearing…" : "Confirm clear"}
          </button>
          <button
            className="notif-gate-btn"
            disabled={clearing}
            onClick={() => setClearConfirming(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {clearError && <span className="task-detail-error">{clearError}</span>}
      {clearResult && (
        <div className="tasks-panel-clear-done-result">
          <span className="task-detail-hint">Cleared {clearResult.deleted} done task(s).</span>
          {clearResult.failed.length > 0 && (
            <ul className="tasks-panel-clear-done-failures">
              {clearResult.failed.map((f) => (
                <li key={f.id}>
                  Task #{f.id}: {f.error}
                </li>
              ))}
            </ul>
          )}
          {clearResult.branches.some((b) => !b.deleted) && (
            <ul className="tasks-panel-clear-done-failures">
              {clearResult.branches
                .filter((b) => !b.deleted)
                .map((b) => (
                  <li key={b.id}>
                    Branch {b.branch} not deleted:{" "}
                    {b.reason === "outcome-unknown" && b.detail ? b.detail : b.reason}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
