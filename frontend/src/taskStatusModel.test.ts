import { describe, expect, it } from "vitest";
import type { Task } from "./api/types.js";
import {
  TASK_STEPS,
  blockerIsTask,
  findTaskForIssue,
  statusSince,
  taskNextStep,
  taskRelations,
  taskRepoSlug,
  taskRowLabel,
  taskStatusBadge,
  taskStepIndex,
} from "./taskStatusModel.js";

let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: seq,
    projectId: 1,
    status: "ready",
    issueNumber: 100 + seq,
    htmlUrl: `https://github.com/o/r/issues/${100 + seq}`,
    title: `t${seq}`,
    blockedState: "clear",
    blockers: [],
    failureReason: null,
    mergeError: null,
    releaseError: null,
    sessionId: null,
    mergedAt: null,
    prNumber: null,
    parentIssueNumber: null,
    parentIssueRepo: null,
    reviewPhase: null,
    reReviewAt: null,
    reviewFindings: null,
    approvalState: null,
    autoReturnCapped: false,
    queuedAt: "q",
    claimedAt: "c",
    startedAt: "s",
    reviewingAt: "r",
    completedAt: "d",
    ...over,
  } as unknown as Task;
}

describe("taskStepIndex", () => {
  it("folds claimed into In progress and hides the tracker for failed", () => {
    expect(TASK_STEPS).toEqual(["Backlog", "Ready", "In progress", "Reviewing", "Done"]);
    expect(taskStepIndex({ status: "backlog" })).toBe(0);
    expect(taskStepIndex({ status: "claimed" })).toBe(2);
    expect(taskStepIndex({ status: "in_progress" })).toBe(2);
    expect(taskStepIndex({ status: "reviewing" })).toBe(3);
    expect(taskStepIndex({ status: "done" })).toBe(4);
    expect(taskStepIndex({ status: "failed" })).toBeNull();
  });
});

describe("taskStatusBadge", () => {
  it("reads blocked, queued, waiting and merged states", () => {
    expect(taskStatusBadge(task({ blockedState: "blocked" })).label).toBe("BLOCKED");
    expect(taskStatusBadge(task()).label).toBe("READY");
    expect(taskStatusBadge(task({ status: "claimed" })).label).toBe("QUEUED");
    expect(taskStatusBadge(task({ status: "claimed", sessionId: 3 })).label).toBe("IN PROGRESS");
    expect(taskStatusBadge(task({ status: "claimed", failureReason: "host offline" })).label).toBe(
      "WAITING",
    );
    expect(taskStatusBadge(task({ status: "done", mergedAt: "x" })).label).toBe("MERGED");
    expect(taskStatusBadge(task({ status: "failed" })).tone).toBe("danger");
  });
});

describe("statusSince", () => {
  it("picks the timestamp of the current status", () => {
    expect(statusSince(task({ status: "reviewing" }))).toBe("r");
    expect(statusSince(task({ status: "ready" }))).toBe("q");
    expect(statusSince(task({ status: "backlog" }))).toBeNull();
  });
});

describe("taskNextStep", () => {
  it("names the blocker for a blocked task", () => {
    const blocker = { owner: "o", repo: "r", number: 7, title: "b", htmlUrl: null };
    const step = taskNextStep(task({ blockedState: "blocked", blockers: [blocker] }));
    expect(step.blocker).toBe(blocker);
    expect(step.tail).toBe("is done.");
    const two = taskNextStep(task({ blockedState: "blocked", blockers: [blocker, blocker] }));
    expect(two.tail).toContain("+1 more");
  });
  it("tells the human what to do when a review awaits approval", () => {
    expect(
      taskNextStep(task({ status: "reviewing", approvalState: "awaiting-human" })).lead,
    ).toMatch(/Approve to merge/);
  });
  it("reports the review phase before the approval state", () => {
    expect(taskNextStep(task({ status: "reviewing", reviewPhase: "awaiting-review" })).lead).toBe(
      "Waiting for the review to start.",
    );
  });
  it("covers the remaining statuses", () => {
    expect(taskNextStep(task({ status: "backlog" })).lead).toMatch(/Parked/);
    expect(taskNextStep(task()).lead).toMatch(/Queued/);
    expect(taskNextStep(task({ blockedState: "unresolved" })).lead).toMatch(/Checking/);
    expect(taskNextStep(task({ status: "claimed", failureReason: "host offline" })).lead).toBe(
      "Waiting: host offline",
    );
    expect(taskNextStep(task({ status: "claimed" })).lead).toMatch(/free slot/);
    expect(taskNextStep(task({ status: "claimed", sessionId: 1 })).lead).toMatch(/starting/);
    expect(taskNextStep(task({ status: "in_progress" })).lead).toMatch(/working/);
    expect(taskNextStep(task({ status: "reviewing", autoReturnCapped: true })).lead).toMatch(
      /limit/,
    );
    expect(taskNextStep(task({ status: "reviewing" })).lead).toMatch(/automatic/);
    expect(taskNextStep(task({ status: "done", mergedAt: "x" })).lead).toMatch(/Merged/);
    expect(
      taskNextStep(task({ status: "done", prNumber: 4, mergeError: "required check failing" }))
        .lead,
    ).toBe(
      "Approved, but the merge failed: required check failing. Fix it on GitHub or merge by hand.",
    );
    expect(
      taskNextStep(task({ status: "done", mergedAt: "x", releaseError: "tag exists" })).lead,
    ).toBe("Merged, but the release failed: tag exists.");
    expect(taskNextStep(task({ status: "done", prNumber: 4 })).lead).toMatch(/waiting for a merge/);
    expect(taskNextStep(task({ status: "done" })).lead).toMatch(/Nothing left/);
    expect(taskNextStep(task({ status: "failed", failureReason: "boom" })).lead).toBe("boom");
  });
});

describe("labels and repo helpers", () => {
  it("labels by issue number, else by task id", () => {
    expect(taskRowLabel({ issueNumber: 42, id: 1 })).toBe("#42");
    expect(taskRowLabel({ issueNumber: null, id: 9 })).toBe("Task #9");
  });
  it("parses the repo slug from the issue url", () => {
    expect(taskRepoSlug({ htmlUrl: "https://github.com/o/r/issues/3" })).toBe("o/r");
    expect(taskRepoSlug({ htmlUrl: null })).toBeNull();
  });
});

describe("relations", () => {
  const blockerTask = task({ issueNumber: 500, htmlUrl: "https://github.com/o/r/issues/500" });
  const ref = { owner: "o", repo: "r", number: 500, title: "b", htmlUrl: null };
  const a = task({ blockedState: "blocked", blockers: [ref] });
  const b = task({ blockedState: "blocked", blockers: [ref] });
  const epic = task({ issueNumber: 900, htmlUrl: "https://github.com/o/r/issues/900" });
  const child = task({ parentIssueNumber: 900, parentIssueRepo: "o/r" });
  const all = [blockerTask, a, b, epic, child];

  it("finds the task behind a blocker reference and ignores a same-number other repo", () => {
    expect(findTaskForIssue(all, ref)?.id).toBe(blockerTask.id);
    expect(findTaskForIssue(all, { ...ref, repo: "other" })).toBeUndefined();
    expect(blockerIsTask(ref, blockerTask)).toBe(true);
    expect(blockerIsTask({ ...ref, owner: "x" }, blockerTask)).toBe(false);
  });
  it("lists what a blocker blocks, and the blocked task's blockers and siblings", () => {
    expect(taskRelations(blockerTask, all).blocks.map((t) => t.id)).toEqual([a.id, b.id]);
    const rel = taskRelations(a, all);
    expect(rel.blockedBy[0].task?.id).toBe(blockerTask.id);
    expect(rel.siblings.map((t) => t.id)).toEqual([b.id]);
  });
  it("links an epic to its parent and children, only within the same repo", () => {
    expect(taskRelations(child, all).parent?.id).toBe(epic.id);
    expect(taskRelations(epic, all).children.map((t) => t.id)).toEqual([child.id]);
    const other = task({ parentIssueNumber: 900, parentIssueRepo: "elsewhere/r" });
    expect(taskRelations(epic, [...all, other]).children.map((t) => t.id)).toEqual([child.id]);
  });
});
