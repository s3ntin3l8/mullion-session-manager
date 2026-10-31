import type { GitHubPrPhase, Task } from "../api/types.js";
import { PHASE_LABEL } from "./prPhase.js";

// What a PR needs next, read from its phase — the one labelled button in the
// PR detail's action bar (PrActionBar.tsx). A merge button that is merely
// disabled hides why; this says it.

export type NextStepKind =
  | "merge"
  | "threads"
  | "handoff"
  | "sendBack"
  | "openWorker"
  | "checks"
  | "reReview"
  | "update"
  | "none";

export interface NextStep {
  kind: NextStepKind;
  label: string;
  /** A step the PR cannot take yet (draft, CI still running): shown, not clickable. */
  disabled: boolean;
}

/** What the step needs to know about the PR's Task Master task, when it has one. */
export interface StepTask {
  task: Pick<Task, "status" | "rebaseStartedAt" | "mergeError">;
  /** The task's own worker session is alive. */
  workerLive: boolean;
}

// A task PR's "handoff" must not start a second session on the task's branch —
// that competes with the task's worker. Route it through Task Master instead.
function taskHandoff(phase: GitHubPrPhase | undefined, { task, workerLive }: StepTask): NextStep {
  if (task.status === "reviewing") {
    return { kind: "sendBack", label: "Send back to worker", disabled: false };
  }
  if (workerLive) return { kind: "openWorker", label: "Open worker session", disabled: false };
  if (task.status === "done" && phase === "conflicts") {
    const label = task.rebaseStartedAt
      ? "Auto-rebase in progress"
      : task.mergeError
        ? "Auto-rebase will retry"
        : "Auto-rebase will fix conflicts";
    return { kind: "none", label, disabled: true };
  }
  return { kind: "none", label: "Task Master owns this PR", disabled: true };
}

export function nextStep(
  phase: GitHubPrPhase | undefined,
  unresolved: number,
  taskCtx?: StepTask | null,
): NextStep {
  const handoff = (label: string): NextStep =>
    taskCtx ? taskHandoff(phase, taskCtx) : { kind: "handoff", label, disabled: false };
  switch (phase) {
    case "ready_to_merge":
      return { kind: "merge", label: "Squash & merge", disabled: false };
    case "threads_unresolved":
      return {
        kind: "threads",
        label:
          unresolved > 0
            ? `Resolve ${unresolved} conversation${unresolved === 1 ? "" : "s"}`
            : "Resolve conversations",
        disabled: false,
      };
    case "changes_requested":
      return handoff("Address changes");
    case "conflicts":
      return handoff("Fix conflicts");
    case "behind":
      return { kind: "update", label: "Update branch", disabled: false };
    case "ci_failing":
      return { kind: "checks", label: "Show failing checks", disabled: false };
    case "review_pending":
    case "reviewed":
      return { kind: "reReview", label: "Request re-review", disabled: false };
    default:
      return { kind: "none", label: PHASE_LABEL[phase ?? "unknown"], disabled: true };
  }
}

/** Why the step is not clickable when a Task Master task owns the PR's review. */
export const TASK_REVIEWER_BUSY = "Task Master's reviewer is handling this PR";

/**
 * Task Master's own reviewer is the terminal review for a `mullion/task-*` PR
 * (hermes.yml's auto-review skips those branches), so "Request re-review" on a
 * PR with a linked task re-arms that reviewer — only possible where
 * `POST /api/tasks/:id/re-review` accepts it (reviewing, inconclusive verdict,
 * a review session whose findings were ingested). Anything else is disabled
 * with a reason; Hermes stays reachable as an explicit secondary action.
 */
export function taskReReviewEligible(
  task: Pick<
    Task,
    | "status"
    | "lastReviewVerdict"
    | "reviewSessionId"
    | "reviewFindingsIngestedSessionId"
    | "reviewRunId"
    | "reviewRunIngestedId"
  >,
): boolean {
  return (
    task.status === "reviewing" &&
    task.lastReviewVerdict === "inconclusive" &&
    ((task.reviewSessionId !== null && task.reviewFindingsIngestedSessionId !== null) ||
      (task.reviewRunId !== null && task.reviewRunIngestedId !== null))
  );
}

/** The next step, with a linked task's ownership of the re-review applied. */
export function nextStepForTask(
  step: NextStep,
  task: Parameters<typeof taskReReviewEligible>[0] | null | undefined,
): NextStep {
  if (step.kind !== "reReview" || !task) return step;
  return taskReReviewEligible(task) ? step : { ...step, label: TASK_REVIEWER_BUSY, disabled: true };
}
