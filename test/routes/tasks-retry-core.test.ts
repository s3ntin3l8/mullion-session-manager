import { describe, it, expect, vi } from "vitest";
import {
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  git,
  createGitRepo,
  setupTasksRouteTestLifecycle,
} from "../helpers/tasks-routes-harness.js";
import path from "node:path";
import fs from "node:fs";
import { deriveTaskBranchName } from "../../src/services/git-worktree.js";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", () => mockTaskPromoteFactory());

const { buildApp } = await import("../../src/app.js");
const { waitForTaskRunning } = await import("../helpers/retry-task.js");

describe("POST /api/tasks/:id/retry (#483)", () => {
  setupTasksRouteTestLifecycle("tasks-retry-core-route-test");

  async function createProjectWithGitRepo(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "retry-p", cwd },
    });
    return res.json().id as number;
  }

  /** Same real →failed lifecycle reconstruction as
   * task-claim.test.ts's own insertFailedTaskWithPreservedBranch —
   * inserted first for a real id, then a worktree/branch created and
   * cleanly removed (deliberately leaving the branch), then flipped to
   * "failed" with both still recorded. */
  async function insertFailedTaskWithPreservedBranch(
    app: Awaited<ReturnType<typeof buildApp>>,
    projectId: number,
    cwd: string,
    issueNumber: number,
  ) {
    const [placeholder] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber, title: "t", status: "ready" })
      .returning()
      .all();
    const branchName = deriveTaskBranchName(placeholder);
    const { createWorktree, removeWorktreeIfClean } =
      await import("../../src/services/git-worktree.js");
    const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
    if (!created?.path) throw new Error("test setup: failed to create worktree");
    fs.writeFileSync(path.join(created.path, "work.txt"), "real committed work");
    git(created.path, ["add", "-A"]);
    git(created.path, ["commit", "-m", "agent did real work", "--no-verify"]);
    const removed = await removeWorktreeIfClean(created.path, cwd);
    if (!removed.removed) throw new Error("test setup: failed to remove worktree");

    const [row] = app.db
      .update(tasks)
      .set({
        status: "failed",
        failureReason: "budget exceeded after 120 minutes",
        completedAt: new Date(),
        worktreePath: created.path,
        branchName,
        sessionId: null,
      })
      .where(eq(tasks.id, placeholder.id))
      .returning()
      .all();
    return row;
  }

  it("resumes a failed task on its preserved branch, clearing failureReason/completedAt", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProjectWithGitRepo(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 80);

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });

    // 202 + the task row (queued, like claim); the sweep then resumes the branch.
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: task.id, branchName: task.branchName });

    await waitForTaskRunning(app, task.id);
    const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(check.json()).toMatchObject({ failureReason: null, completedAt: null });
    expect(fs.readFileSync(path.join(task.worktreePath ?? "", "work.txt"), "utf8")).toBe(
      "real committed work",
    );

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("clears a stale needsHumanReason and ciHoldNote on retry and claim dispatch", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProjectWithGitRepo(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 81);
    app.db
      .update(tasks)
      .set({
        autoReturnCapAnnouncedAt: new Date(),
        needsHumanReason: "ci-unfixable",
        ciHoldNote: "test-merge — dependency-audit fails on base",
      })
      .where(eq(tasks.id, task.id))
      .run();

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      autoReturnCapAnnouncedAt: null,
      needsHumanReason: null,
      ciHoldNote: null,
    });

    await waitForTaskRunning(app, task.id);
    const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(check.json()).toMatchObject({
      status: "in_progress",
      autoReturnCapAnnouncedAt: null,
      needsHumanReason: null,
      ciHoldNote: null,
    });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("409s a task that isn't failed", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProjectWithGitRepo(app, cwd);
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, title: "t", status: "ready" })
      .returning()
      .all();

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
    expect(res.statusCode).toBe(409);

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("resets a branchless failed task to ready (202) instead of refusing", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProjectWithGitRepo(app, cwd);
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, title: "t", status: "failed", branchName: null })
      .returning()
      .all();

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
    expect([res.statusCode, res.json().status]).toEqual([202, "ready"]);

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("403s when Task Master is disabled — unlike reject/give-up, retry spawns a session", async () => {
    process.env.MULLION_TASK_MASTER_ENABLED = "false";
    try {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 81);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(res.statusCode).toBe(403);

      const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
      expect(check.json().status).toBe("failed");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    } finally {
      process.env.MULLION_TASK_MASTER_ENABLED = "true";
    }
  });

  it("applies agent override from request body", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProjectWithGitRepo(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 82);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/retry`,
      payload: { agent: "codex", reviewAgent: "none" },
    });
    expect(res.statusCode).toBe(202);
    await waitForTaskRunning(app, task.id);

    const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(check.json()).toMatchObject({
      agent: "codex",
      reviewAgent: "none",
      agentCommand: "codex",
    });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });
});
