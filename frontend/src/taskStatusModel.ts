import type { Task, TaskBlocker } from "./api/types.js";
import { reviewPhaseText } from "./needsHuman.js";

// The status-first view of a task (the Tasks sidebar's detail, epic #2847):
// the badge, the step tracker and the one "Next:" sentence. Pure functions of
// a Task so the block that renders them holds no data fetching.

/** The tracker's steps. Claimed is folded into In progress, as on the board. */
export const TASK_STEPS = ["Backlog", "Ready", "In progress", "Reviewing", "Done"] as const;

/** Which tracker step a task is at; null for a failed task (the tracker is hidden). */
export function taskStepIndex(task: Pick<Task, "status">): number | null {
  switch (task.status) {
    case "backlog":
      return 0;
    case "ready":
      return 1;
    case "claimed":
    case "in_progress":
      return 2;
    case "reviewing":
      return 3;
    case "done":
      return 4;
    default:
      return null;
  }
}

export type StatusBadgeTone = "neutral" | "info" | "success" | "warn" | "danger";

/** The big status badge: what the task is doing right now, in one word or two. */
export function taskStatusBadge(
  task: Pick<
    Task,
    "status" | "blockedState" | "failureReason" | "sessionId" | "mergedAt" | "prNumber"
  >,
): { label: string; tone: StatusBadgeTone } {
  switch (task.status) {
    case "failed":
      return { label: "FAILED", tone: "danger" };
    case "backlog":
      return { label: "BACKLOG", tone: "neutral" };
    case "ready":
      return task.blockedState === "blocked"
        ? { label: "BLOCKED", tone: "warn" }
        : { label: "READY", tone: "neutral" };
    case "claimed":
      return task.failureReason
        ? { label: "WAITING", tone: "warn" }
        : task.sessionId === null
          ? { label: "QUEUED", tone: "warn" }
          : { label: "IN PROGRESS", tone: "info" };
    case "in_progress":
      return { label: "IN PROGRESS", tone: "info" };
    case "reviewing":
      return { label: "REVIEWING", tone: "info" };
    case "done":
      return task.mergedAt !== null
        ? { label: "MERGED", tone: "success" }
        : { label: "DONE", tone: "success" };
    default:
      return { label: String(task.status).toUpperCase(), tone: "neutral" };
  }
}

/** The ISO timestamp the task entered its current status, when the row recorded one. */
export function statusSince(task: Task): string | null {
  switch (task.status) {
    case "ready":
      return task.queuedAt;
    case "claimed":
      return task.claimedAt;
    case "in_progress":
      return task.startedAt;
    case "reviewing":
      return task.reviewingAt;
    case "done":
    case "failed":
      return task.completedAt;
    default:
      return null;
  }
}

/** One sentence on what happens next, in parts so a blocker can render as a link. */
export interface NextStep {
  lead: string;
  blocker?: TaskBlocker;
  tail?: string;
}

export function taskNextStep(task: Task): NextStep {
  switch (task.status) {
    case "backlog":
      return { lead: "Parked. Move it to Ready to queue it, or start it now." };
    case "ready": {
      if (task.blockedState === "blocked" && task.blockers.length > 0) {
        return {
          lead: "Starts automatically when",
          blocker: task.blockers[0],
          tail:
            task.blockers.length > 1 ? `is done (+${task.blockers.length - 1} more).` : "is done.",
        };
      }
      if (task.blockedState === "unresolved") {
        return { lead: "Checking what this task depends on before it can start." };
      }
      return { lead: "Queued. A worker starts it as soon as a slot is free." };
    }
    case "claimed":
      if (task.failureReason) return { lead: `Waiting: ${task.failureReason}` };
      return task.sessionId === null
        ? { lead: "Queued. Waiting for a free slot." }
        : { lead: "A worker is starting on it." };
    case "in_progress":
      return { lead: "A worker is working on it. The review starts when it finishes." };
    case "reviewing": {
      const phase = reviewPhaseText(
        task.reviewPhase,
        task.reReviewAt,
        task.reviewFindings !== null,
      );
      if (phase) return { lead: `${phase}.` };
      if (task.approvalState === "awaiting-human") {
        return { lead: "Reviewed. Approve to merge, or reject to send it back to the worker." };
      }
      if (task.autoReturnCapped) {
        return { lead: "The review loop hit its limit. A human decides: approve or reject." };
      }
      return { lead: "The review is running. Approval is automatic when it passes." };
    }
    case "done":
      if (task.mergedAt !== null) return { lead: "Merged. Nothing left to do." };
      return task.prNumber !== null
        ? { lead: "Approved. The pull request is waiting for a merge." }
        : { lead: "Approved. Nothing left to do." };
    case "failed":
      return { lead: task.failureReason ?? "This task failed. Retry it or give it up." };
    default:
      return { lead: "" };
  }
}

/** What a task is called in a row or header (#2559): its issue number, else "Task #id". */
export function taskRowLabel(task: Pick<Task, "issueNumber" | "id">): string {
  return task.issueNumber != null ? `#${task.issueNumber}` : `Task #${task.id}`;
}

/** `owner/repo` of a task's own issue, parsed from its issue URL (a task has no repo field). */
export function taskRepoSlug(task: Pick<Task, "htmlUrl">): string | null {
  return task.htmlUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/)?.[1] ?? null;
}

/** Is `blocker` (a GitHub issue reference) this task's own issue? */
export function blockerIsTask(blocker: TaskBlocker, task: Task): boolean {
  return (
    task.issueNumber === blocker.number && taskRepoSlug(task) === `${blocker.owner}/${blocker.repo}`
  );
}

/** The Task Master task that tracks a GitHub issue, when one is known. */
export function findTaskForIssue(
  tasks: readonly Task[],
  ref: { owner: string; repo: string; number: number },
): Task | undefined {
  return tasks.find(
    (t) => t.issueNumber === ref.number && taskRepoSlug(t) === `${ref.owner}/${ref.repo}`,
  );
}

export interface TaskRelations {
  /** The task that tracks this task's parent epic, when known. */
  parent: Task | null;
  /** Tasks this one is blocked by that are themselves tasks, and the rest as bare refs. */
  blockedBy: Array<{ blocker: TaskBlocker; task: Task | undefined }>;
  /** Tasks whose blockers include this task's issue. */
  blocks: Task[];
  /** Other tasks blocked by the same blocker(s) as this one. */
  siblings: Task[];
  /** Child tasks (this task is their parent issue). */
  children: Task[];
}

/** Everything the Hierarchy section links to, derived from the loaded tasks only. */
export function taskRelations(task: Task, all: readonly Task[]): TaskRelations {
  const slug = taskRepoSlug(task);
  const parent =
    task.parentIssueNumber !== null && task.parentIssueRepo !== null
      ? (all.find(
          (t) =>
            t.issueNumber === task.parentIssueNumber && taskRepoSlug(t) === task.parentIssueRepo,
        ) ?? null)
      : null;
  const blockedBy =
    task.blockedState === "blocked"
      ? task.blockers.map((blocker) => ({ blocker, task: findTaskForIssue(all, blocker) }))
      : [];
  const blocks = all.filter(
    (t) =>
      t.id !== task.id &&
      t.blockedState === "blocked" &&
      t.blockers.some((b) => blockerIsTask(b, task)),
  );
  const blockerKeys = new Set(task.blockers.map((b) => `${b.owner}/${b.repo}#${b.number}`));
  const siblings =
    task.blockedState === "blocked"
      ? all.filter(
          (t) =>
            t.id !== task.id &&
            t.blockedState === "blocked" &&
            t.blockers.some((b) => blockerKeys.has(`${b.owner}/${b.repo}#${b.number}`)),
        )
      : [];
  const children =
    task.issueNumber !== null && slug !== null
      ? all.filter(
          (t) =>
            t.projectId === task.projectId &&
            t.parentIssueNumber === task.issueNumber &&
            t.parentIssueRepo === slug,
        )
      : [];
  return { parent, blockedBy, blocks, siblings, children };
}
