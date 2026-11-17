import { describe, it, expect } from "vitest";
import type { Task } from "../api/types.js";
import { needsYouReason, needsYouTasks, taskBucket } from "./taskMasterSummary.js";

const t = (o: Partial<Task>): Task =>
  ({ id: 1, projectId: 1, status: "ready", archivedAt: null, ...o }) as Task;

describe("taskBucket", () => {
  it("files active work under one status, and everything else under none", () => {
    expect(taskBucket(t({ status: "ready" }))).toBe("ready");
    expect(taskBucket(t({ status: "in_progress" }))).toBe("running");
    expect(taskBucket(t({ status: "claimed" }))).toBe("running");
    expect(taskBucket(t({ status: "claimed", failureReason: "host offline" }))).toBe("waiting");
    expect(taskBucket(t({ status: "reviewing" }))).toBe("reviewing");
    expect(taskBucket(t({ status: "reviewing", approvalState: "awaiting-human" }))).toBe(
      "awaitingApproval",
    );
    expect(taskBucket(t({ status: "failed" }))).toBe("failed");
    expect(taskBucket(t({ status: "backlog" }))).toBeNull();
    expect(taskBucket(t({ status: "done" }))).toBeNull();
  });

  it("never lists an archived task, whatever its status", () => {
    const archived = { archivedAt: "2026-10-01T00:00:00Z" };
    expect(taskBucket(t({ status: "failed", ...archived }))).toBeNull();
    expect(needsYouReason(t({ status: "failed", failureReason: "boom", ...archived }))).toBeNull();
  });
});

describe("needsYouTasks", () => {
  const tasks = [
    t({ id: 1, status: "failed", failureReason: "budget exceeded" }),
    t({ id: 2, status: "failed", failureReason: "old", archivedAt: "2026-10-01T00:00:00Z" }),
    t({ id: 3, status: "ready" }),
    t({ id: 4, status: "done" }),
    t({ id: 5, status: "done", mergeError: "conflict" }),
  ];

  it("lists only unarchived tasks that need a human, with the reason", () => {
    expect(needsYouTasks(tasks).map((x) => [x.task.id, x.reason])).toEqual([
      [1, "budget exceeded"],
      [5, "merge failed: conflict"],
    ]);
  });

  it("lists a finished task with a merge error, so the badge and the list agree", () => {
    expect(taskBucket(tasks[4])).toBe("attention");
    expect(taskBucket(tasks[3])).toBeNull();
  });
});

describe("needsYouReason: a parked red CI check", () => {
  const parked = {
    status: "reviewing" as const,
    autoReturnCapAnnouncedAt: "2026-01-01T00:00:00.000Z",
    ciHoldNote: "dependency-audit — no patched release",
  };

  it("names the check even while an approval is held, before the approval line", () => {
    expect(
      needsYouReason(
        t({ ...parked, needsHumanReason: "ci-unfixable", approvalState: "awaiting-human" }),
      ),
    ).toBe("a CI check can't be fixed from this PR: dependency-audit — no patched release");
  });

  it("names it when no round was spent either (so the round cap is not what parked it)", () => {
    expect(
      needsYouReason(t({ ...parked, needsHumanReason: "ci-still-red", autoReturnCapped: false })),
    ).toBe("CI still red after the worker and two reruns: dependency-audit — no patched release");
  });

  it("says nothing once the stop stamp is gone (the task was re-armed)", () => {
    expect(
      needsYouReason(
        t({ ...parked, autoReturnCapAnnouncedAt: null, needsHumanReason: "ci-unfixable" }),
      ),
    ).toBeNull();
  });
});
