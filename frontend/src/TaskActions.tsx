import { useState } from "react";
import { useDashboardStore } from "./store/index.js";
import { computeTaskReorder, orderTasksForColumn } from "./tasksBoard.js";
import { ApiError } from "./api/index.js";
import type { Task } from "./api/index.js";
import { TextInput } from "./ui/primitives.js";
import {
  awaitingMergeReason,
  isAwaitingMerge,
  isMergeUnconfirmed,
} from "./unified-board/awaitingMerge.js";
import { parseWorkflowChange } from "./workflowChange.js";

// What each review action does, said once for the buttons' tooltips and the
// confirm step's hint — the three of them are easy to confuse.
const APPROVE_HINT = "Accept the work: open the pull request and close the issue.";
const REJECT_HINT =
  "Send your feedback to the task's agent. It keeps working on the same branch, then the change is reviewed again.";
const GIVE_UP_HINT =
  "Stop the task. It is marked Failed, its sessions stop and any draft pull request closes. You can Retry it later from the branch.";

// Shared by the task drawer (TaskDetail.tsx) and the GitHub PR sidebar
// (github/PrDetailView.tsx) so both offer the same per-status task actions.
// GateActions' own pattern (NotificationBell.tsx) — no optimistic state; the
// button just fires the request and the next tasks poll reflects whatever
// actually happened. Claim/Approve/Retry are disabled with a hint when
// taskMasterEnabled is off (the roadmap's Flag semantics decision: these
// spawn/promote autonomous agents, unlike the local board's own CRUD).
// Reject and Give up are deliberately NOT gated here (Hermes review, PR
// #480, fourth pass; extended to give-up by #483), mirroring the server
// routes: they're the only ways to resolve a task that's already in
// "reviewing" when the toggle flips off — disabling them client-side would
// hide the escape hatches the server still allows.
//
// Claim/Retry deliberately do NOT open the new session's panel — an
// autonomous auto-claim never opens one either (task-reconciler.ts has no
// UI to open a panel from), so a manual claim/retry now matches that
// behavior instead of being the one path that pops a terminal. The task
// card already shows the new session's live status, and "Open session" in
// TaskDetail's own meta row above opens it on demand.
export function TaskActions({ task }: { task: Task }) {
  const {
    taskMasterEnabled,
    claimTask,
    approveTask,
    rejectTask,
    retryTask,
    giveUpTask,
    reReviewTask,
    updateTask,
    refreshTasks,
    tasks,
  } = useDashboardStore();
  const [submitting, setSubmitting] = useState(false);
  // Which free-text-reason-then-confirm flow is open, if any — reject and
  // give-up share the same input/confirm/cancel shape, so one bit of state
  // (not two independent booleans) tracks which action a confirm click
  // resolves to.
  const [pendingAction, setPendingAction] = useState<"reject" | "give-up" | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  // #1020 — non-null while a tracking-epic warning is awaiting confirmation;
  // mirrors DeleteTaskAction's own needsForce shape (the existing two-stage
  // confirmation pattern this UI already uses for #1014 Abandon).
  const [trackingEpicWarning, setTrackingEpicWarning] = useState<string | null>(null);

  const disabledHint = !taskMasterEnabled
    ? "Task Master is disabled — enable it to use this action."
    : null;

  // Backlog<->Ready is the board's only user-driven, non-terminal drag
  // (UnifiedBoard.tsx's DRAG_EDITABLE_STATUSES) — and drag is the ONLY way
  // to reach it, which HTML5 drag-and-drop never fires on a touch device.
  // Not gated on taskMasterEnabled — it's local board CRUD, same posture as
  // DeleteTaskAction above, not one of the spawn/promote-an-agent actions
  // that flag actually guards.
  //
  // Hermes review — an earlier version sent a bare `{ status }` patch and
  // claimed (wrongly) that this "always appends". PATCH /api/tasks/:id
  // (routes/tasks.ts) only writes the fields given and never reindexes, so
  // a status-only patch would have kept the task's PREVIOUS boardOrder and
  // left it wherever orderTasksForColumn's (boardOrder, id) sort happened
  // to place it in the new column — often not the end, and inconsistent
  // with the drag path. Reusing computeTaskReorder with a target index of
  // "one past the target column's last task" is the same REORDER MATH
  // UnifiedBoard.tsx's own applyDrop uses for a drop.
  //
  // Independent review — that parity claim didn't extend to failure
  // handling, which is NOT identical: applyDrop fires its updates
  // concurrently, each with its own resync-on-failure (a failed PATCH
  // there still calls refreshTasks(), so the store recovers whatever the
  // server actually persisted). This loop awaits sequentially inside one
  // try/catch instead — appropriate here, since a click-triggered action
  // wants one definitive success/failure outcome rather than N
  // independently-racing writes — but that also means a failure partway
  // through a multi-update reindex (rare: only when the target column
  // already has tasks needing their own boardOrder shifted) left earlier,
  // already-successful writes unreflected in the store until the next
  // regular poll. refreshTasks() in the catch closes that gap the same way
  // applyDrop's own per-update .catch does.
  const moveStatus = async (status: "backlog" | "ready") => {
    setSubmitting(true);
    setError(null);
    try {
      const targetIndex = orderTasksForColumn(tasks, status).length;
      const updates = computeTaskReorder(tasks, task.id, status, targetIndex);
      for (const update of updates) {
        const patch: { status?: "backlog" | "ready"; boardOrder: number } = {
          boardOrder: update.boardOrder,
        };
        if (update.id === task.id && update.status !== task.status) {
          patch.status = update.status as "backlog" | "ready";
        }
        await updateTask(update.id, patch);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to move task");
      void refreshTasks();
    } finally {
      setSubmitting(false);
    }
  };

  if (task.status === "backlog") {
    return (
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn"
          disabled={submitting}
          onClick={() => void moveStatus("ready")}
        >
          Move to Ready
        </button>
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  if (task.status === "ready") {
    return (
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn notif-gate-approve"
          disabled={submitting || !taskMasterEnabled}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await claimTask(task.id);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Failed to claim task");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Claim
        </button>
        <button
          className="notif-gate-btn"
          disabled={submitting}
          onClick={() => void moveStatus("backlog")}
        >
          Move to Backlog
        </button>
        {disabledHint && <span className="task-detail-hint">{disabledHint}</span>}
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  // #483 — resumes on the preserved mullion/task-<id> branch rather than
  // starting over. Gated like Claim, since it also spawns a session.
  if (task.status === "failed") {
    return (
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn notif-gate-approve"
          disabled={submitting || !taskMasterEnabled}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await retryTask(task.id);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Failed to retry task");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Retry
        </button>
        {disabledHint && <span className="task-detail-hint">{disabledHint}</span>}
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  // Merge-on-approve — a `done` task with a linked PR may still have a
  // merge outstanding (mergeRequestedAt set, e.g. an "unstable"/"dirty"/
  // "blocked" PR state the sweep is backing off and retrying on). Always
  // rendered so the state/error is visible either way; TaskMergeStatus
  // itself gates the button on taskMasterEnabled, since the backend route
  // it calls is gated too (Hermes review, PR #769 — an earlier version of
  // this comment wrongly claimed the Reject/Give-up "ungated escape hatch"
  // posture applied here; it doesn't, that route has no such carve-out).
  if (task.status === "done" && task.prNumber !== null) {
    return <TaskMergeStatus task={task} />;
  }

  if (task.status !== "reviewing") return null;

  if (pendingAction !== null) {
    const isGiveUp = pendingAction === "give-up";
    return (
      <div className="task-detail-actions">
        <span className="task-detail-hint">{isGiveUp ? GIVE_UP_HINT : REJECT_HINT}</span>
        <TextInput
          small
          className="notif-gate-deny-reason"
          placeholder={
            isGiveUp
              ? "Why give up? (optional, posted to the issue)"
              : "Feedback for the agent (optional)"
          }
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
        <button
          className="notif-gate-btn notif-gate-deny-confirm"
          disabled={submitting}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              if (isGiveUp) {
                await giveUpTask(task.id, reason.trim() || undefined);
              } else {
                await rejectTask(task.id, reason.trim() || undefined);
              }
              setPendingAction(null);
            } catch (err) {
              setError(
                err instanceof ApiError
                  ? err.message
                  : `Failed to ${isGiveUp ? "give up on" : "reject"} task`,
              );
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {isGiveUp ? "Give up" : "Reject"}
        </button>
        <button
          className="notif-gate-btn"
          disabled={submitting}
          onClick={() => setPendingAction(null)}
        >
          Cancel
        </button>
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  // #1020 — advisory tracking-epic confirmation. Replaces the Approve/Reject/
  // Give up row entirely while the warning is open; the human either
  // confirms and proceeds with the close (with force: true) or cancels back
  // to the normal row. Cancel also drops the warning so a fresh open returns
  // to the regular Approve flow (review fix mirroring DeleteTaskAction's own
  // cancel()).
  if (trackingEpicWarning !== null) {
    return (
      <TrackingEpicApprovalConfirm
        message={trackingEpicWarning}
        submitting={submitting}
        onConfirm={async () => {
          setSubmitting(true);
          setError(null);
          try {
            await approveTask(task.id, { force: true });
            setTrackingEpicWarning(null);
          } catch (err) {
            if (
              err instanceof ApiError &&
              err.statusCode === 409 &&
              err.code === "tracking-epic-with-open-sub-issues"
            ) {
              setTrackingEpicWarning(err.message);
            } else {
              setError(err instanceof ApiError ? err.message : "Failed to approve task");
            }
          } finally {
            setSubmitting(false);
          }
        }}
        onCancel={() => setTrackingEpicWarning(null)}
      />
    );
  }

  return (
    <div className="task-detail-actions">
      {!parseWorkflowChange(task.workflowChange) && (
        <button
          className="notif-gate-btn notif-gate-approve"
          disabled={submitting || !taskMasterEnabled}
          title={APPROVE_HINT}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await approveTask(task.id);
            } catch (err) {
              // #1020 — branch on the 409's machine-readable `code` (per
              // api/client.ts's guidance), not the message text. Only the
              // tracking-epic warning surfaces the advisory confirmation; any
              // other 409 falls through to the generic error path.
              if (
                err instanceof ApiError &&
                err.statusCode === 409 &&
                err.code === "tracking-epic-with-open-sub-issues"
              ) {
                setTrackingEpicWarning(err.message);
              } else {
                setError(err instanceof ApiError ? err.message : "Failed to approve task");
              }
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Approve task
        </button>
      )}
      {/* Issue #1345 — visible only for exactly the state the backend
          route will actually accept, mirroring its own three checks
          (routes/tasks.ts): lastReviewVerdict === "inconclusive",
          reviewSessionId set, AND reviewFindingsIngestedSessionId set —
          the last of which rules out the window right after a re-review
          (or the automatic sweep) already fired, where reviewSessionId
          points at a FRESH session with no result yet but
          lastReviewVerdict is still the stale "inconclusive" from before.
          Self-review finding: without the third check, the button stayed
          enabled during that window and clicking it deterministically
          409ed. No free-text reason needed (unlike reject/give-up below),
          so this fires directly on click rather than opening the
          pendingAction confirm flow. */}
      {task.lastReviewVerdict === "inconclusive" &&
        ((task.reviewSessionId !== null && task.reviewFindingsIngestedSessionId !== null) ||
          (task.reviewRunId !== null && task.reviewRunIngestedId !== null)) && (
          <button
            className="notif-gate-btn"
            disabled={submitting}
            onClick={async () => {
              setSubmitting(true);
              setError(null);
              try {
                await reReviewTask(task.id);
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Failed to re-review task");
              } finally {
                setSubmitting(false);
              }
            }}
          >
            Re-review
          </button>
        )}
      <button
        className="notif-gate-btn notif-gate-deny"
        disabled={submitting}
        title={REJECT_HINT}
        onClick={() => setPendingAction("reject")}
      >
        Reject
      </button>
      <button
        className="notif-gate-btn notif-gate-deny"
        disabled={submitting}
        title={GIVE_UP_HINT}
        onClick={() => setPendingAction("give-up")}
      >
        Give up
      </button>
      {disabledHint && (
        <span className="task-detail-hint">
          {disabledHint} Reject/Give up still work — they're the escape hatches out of review while
          disabled.
        </span>
      )}
      {error && <span className="task-detail-error">{error}</span>}
    </div>
  );
}

// #1020 — tracking-epic-with-open-sub-issues confirmation, advisory only.
// A tracking epic (subIssueTotal > 0) with outstanding OPEN children
// (total - completed > 0) used to close silently on Approve. The server
// now returns 409 with a machine-readable `code` discriminator; the UI
// re-prompts the human and, on confirm, re-issues with `force: true` to
// proceed with the close. Mirrors DeleteTaskAction's own `?force=true`
// (#1014) shape — same "advisory two-stage confirmation" pattern, same
// `code`-based dispatch off the 409 (per api/client.ts's guidance to
// branch on `code`, not the human-readable message).
function TrackingEpicApprovalConfirm({
  message,
  onConfirm,
  onCancel,
  submitting,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  return (
    <div className="task-detail-actions">
      <span className="task-detail-hint">Heads up — {message}</span>
      <button
        className="notif-gate-btn notif-gate-approve"
        disabled={submitting}
        onClick={() => {
          void onConfirm();
        }}
      >
        Close anyway
      </button>
      <button className="notif-gate-btn" disabled={submitting} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

// Merge-on-approve — renders for a `done` task with a linked PR (see the
// TaskActions call site above). Three states: no merge ever requested (a
// human can still merge by hand, or click Merge now to hand it to the
// sweep), a merge outstanding with no error (the sweep is working it —
// clean/behind/unknown mergeableState, see task-reconciler.ts's own table),
// or outstanding with a recorded error (unstable/blocked/dirty — needs a
// human to actually go fix something, "Retry merge" just re-arms the
// sweep's backoff, it doesn't retry the SAME failed state any faster).
function TaskMergeStatus({ task }: { task: Task }) {
  const { taskMasterEnabled, mergeTask } = useDashboardStore();
  const mergeOnApprove = useDashboardStore(
    (s) => s.projects?.find((p) => p.id === task.projectId)?.mergeOnApprove,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = task.mergeRequestedAt !== null;
  // Hermes review, PR #769 — POST /api/tasks/:id/merge is gated on
  // taskMasterEnabled server-side (routes/tasks.ts, same 403 as approve),
  // so an enabled button on a disabled install would always fail. Gate it
  // client-side too, matching Claim/Approve/Retry's own disabledHint
  // pattern above — this is NOT the Reject/Give-up posture (those routes
  // are deliberately ungated as the escape hatch out of "reviewing"; merge
  // has no such carve-out).
  const disabledHint = !taskMasterEnabled
    ? "Task Master is disabled — enable it to use this action."
    : null;

  const awaiting = isAwaitingMerge(task);
  const unconfirmed = isMergeUnconfirmed(task);
  // A confirmed merge wins over any stale merge state still on the row: no
  // "needs merge", no error, no button to merge it again.
  const merged = task.mergedAt !== null;

  return (
    <div className="task-detail-actions">
      {merged && (
        <span className="task-detail-hint">
          <strong>PR merged.</strong>{" "}
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer">
              PR #{task.prNumber}
            </a>
          )}
        </span>
      )}
      {awaiting && unconfirmed && (
        <span className="task-detail-hint task-detail-awaiting-merge">
          <strong>Merge status could not be confirmed.</strong> GitHub did not answer in time, so
          the PR may already be merged — checking again shortly.{" "}
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer">
              PR #{task.prNumber}
            </a>
          )}
        </span>
      )}
      {awaiting && !unconfirmed && (
        <span className="task-detail-hint task-detail-awaiting-merge">
          <strong>PR open — needs merge.</strong> {awaitingMergeReason(task, mergeOnApprove)}.{" "}
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer">
              PR #{task.prNumber}
            </a>
          )}
        </span>
      )}
      {!merged && (
        <button
          className="notif-gate-btn notif-gate-approve"
          disabled={submitting || !taskMasterEnabled}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await mergeTask(task.id);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Failed to request a merge");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {pending ? "Retry merge" : "Merge now"}
        </button>
      )}
      {pending && !task.mergeError && !merged && (
        <span className="task-detail-hint">
          Merge pending — landing once the branch is up to date and checks are green.
        </span>
      )}
      {task.mergeError && !merged && !unconfirmed && (
        <span className="task-detail-error">{task.mergeError}</span>
      )}
      {/* #744 — releaseRequestedAt is only ever set AFTER this task's own PR
          has merged (task-reconciler.ts's attemptMerge, case "clean"), so it
          and mergeRequestedAt/mergeError above are never both "pending" at
          once for the same task — no button here, the autorelease sweep is
          project-wide and unattended, same as this project's autoTagRelease
          toggle implies. */}
      {task.releaseRequestedAt !== null && !task.releaseError && (
        <span className="task-detail-hint">
          Release pending — batching with any other recently landed tasks before merging.
        </span>
      )}
      {task.releaseError && <span className="task-detail-error">{task.releaseError}</span>}
      {disabledHint && <span className="task-detail-hint">{disabledHint}</span>}
      {error && <span className="task-detail-error">{error}</span>}
    </div>
  );
}
