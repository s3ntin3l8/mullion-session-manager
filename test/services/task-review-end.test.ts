import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { gitEnv } from "../../src/services/git-env.js";
import { clearGitDiffStatsCacheForTests } from "../../src/services/git-diff.js";

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { branchHasNothingToMerge, endIfRebaseEmptied, endReviewingTask, endReviewingOnPrState } =
  await import("../../src/services/task-review-end.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString().trim();
}

const tmpDb = path.join(os.tmpdir(), `task-review-end-test-${process.pid}.db`);

describe("task-review-end (#2103)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let project: typeof projects.$inferSelect;
  let worktree: string;

  const insertTask = (over: Partial<typeof tasks.$inferInsert> = {}) =>
    app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "reviewing task",
        status: "reviewing",
        prNumber: 5,
        worktreePath: worktree,
        branchName: "mullion/task-1-x",
        rebaseStartedAt: new Date(),
        mergeError: "Conflicts with main — an auto-rebase attempt is in progress",
        ...over,
      })
      .returning()
      .get();
  const reload = (id: number) => app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-review-end-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "review-end-project", cwd },
    });
    project = app.db.select().from(projects).where(eq(projects.id, res.json().id)).get()!;
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "task-review-end-wt-"));
    git(worktree, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(worktree, "a.txt"), "a\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "initial", "--no-verify"]);
    git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(worktree, ["checkout", "-b", "mullion/task-1-x"]);
    clearGitDiffStatsCacheForTests();
  });

  describe("branchHasNothingToMerge", () => {
    it("is true when the branch is identical to the base (a rebase dropped every patch)", async () => {
      expect(await branchHasNothingToMerge(app, insertTask())).toBe(true);
    });

    it("is false while the branch still changes something", async () => {
      fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");
      git(worktree, ["add", "-A"]);
      git(worktree, ["commit", "-m", "more", "--no-verify"]);
      clearGitDiffStatsCacheForTests();
      expect(await branchHasNothingToMerge(app, insertTask())).toBe(false);
    });

    it("is false for a worktree stopped mid-rebase: detached HEAD at the base reads empty but the commits live only on the branch", async () => {
      fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");
      git(worktree, ["add", "-A"]);
      git(worktree, ["commit", "-m", "worker commit", "--no-verify"]);
      git(worktree, ["checkout", "--detach", "refs/remotes/origin/main"]);
      clearGitDiffStatsCacheForTests();
      expect(await branchHasNothingToMerge(app, insertTask())).toBe(false);
    });

    it("is false, never true, when it cannot tell (no worktree, no base ref)", async () => {
      expect(await branchHasNothingToMerge(app, insertTask({ worktreePath: null }))).toBe(false);
      git(worktree, ["update-ref", "-d", "refs/remotes/origin/main"]);
      clearGitDiffStatsCacheForTests();
      expect(await branchHasNothingToMerge(app, insertTask())).toBe(false);
    });
  });

  describe("endIfRebaseEmptied", () => {
    const STALE = 30 * 60_000;

    it("does nothing while the rebase attempt is still inside its window", async () => {
      const task = insertTask({ rebaseStartedAt: new Date() });
      expect(await endIfRebaseEmptied(app, task, project, Date.now(), STALE)).toBe(false);
      expect(reload(task.id).status).toBe("reviewing");
    });

    it("does nothing for a task with no rebase attempt", async () => {
      const task = insertTask({ rebaseStartedAt: null });
      expect(await endIfRebaseEmptied(app, task, project, Date.now(), STALE)).toBe(false);
    });

    it("ends done (superseded) once the window ended and the branch holds nothing", async () => {
      const task = insertTask({ rebaseStartedAt: new Date(Date.now() - 2 * STALE) });
      expect(await endIfRebaseEmptied(app, task, project, Date.now(), STALE)).toBe(true);
      const row = reload(task.id);
      expect(row.status).toBe("done");
      expect(row.rebaseStartedAt).toBeNull();
    });

    it("leaves a stale attempt alone while the branch still has changes", async () => {
      fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");
      git(worktree, ["add", "-A"]);
      git(worktree, ["commit", "-m", "more", "--no-verify"]);
      clearGitDiffStatsCacheForTests();
      const task = insertTask({ rebaseStartedAt: new Date(Date.now() - 2 * STALE) });
      expect(await endIfRebaseEmptied(app, task, project, Date.now(), STALE)).toBe(false);
      expect(reload(task.id).status).toBe("reviewing");
    });
  });

  describe("endReviewingTask", () => {
    it("merged: done, merged and archived, bookkeeping cleared", async () => {
      const task = insertTask();
      expect(await endReviewingTask(app, task, project, "merged")).toBe(true);
      const row = reload(task.id);
      expect(row.status).toBe("done");
      expect(row.mergedAt).not.toBeNull();
      expect(row.archivedAt).not.toBeNull();
      expect(row.rebaseStartedAt).toBeNull();
      expect(row.mergeError).toBeNull();
    });

    it("closed: failed with the reason", async () => {
      const task = insertTask();
      await endReviewingTask(app, task, project, "closed");
      const row = reload(task.id);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toBe("PR closed without merging");
    });

    it("superseded: done without claiming a merge", async () => {
      const task = insertTask();
      await endReviewingTask(app, task, project, "superseded");
      const row = reload(task.id);
      expect(row.status).toBe("done");
      expect(row.mergedAt).toBeNull();
    });

    it("loses to a concurrent change of status (CAS on reviewing)", async () => {
      const task = insertTask({ status: "in_progress" });
      expect(await endReviewingTask(app, task, project, "closed")).toBe(false);
      expect(reload(task.id).status).toBe("in_progress");
    });
  });

  describe("endReviewingOnPrState", () => {
    it("ignores an open PR", async () => {
      const task = insertTask();
      expect(
        await endReviewingOnPrState(app, task, project, { state: "open", merged: false }),
      ).toBe(false);
      expect(reload(task.id).status).toBe("reviewing");
    });

    it("a closed PR whose branch holds nothing beyond base ends done (superseded), not failed", async () => {
      const task = insertTask();
      await endReviewingOnPrState(app, task, project, { state: "closed", merged: false });
      expect(reload(task.id).status).toBe("done");
    });

    it("a closed PR whose branch still holds changes ends failed", async () => {
      fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");
      git(worktree, ["add", "-A"]);
      git(worktree, ["commit", "-m", "more", "--no-verify"]);
      clearGitDiffStatsCacheForTests();
      const task = insertTask();
      await endReviewingOnPrState(app, task, project, { state: "closed", merged: false });
      expect(reload(task.id).status).toBe("failed");
    });

    it("a merged PR ends done and merged without consulting the diff", async () => {
      const task = insertTask({ worktreePath: null });
      await endReviewingOnPrState(app, task, project, { state: "closed", merged: true });
      const row = reload(task.id);
      expect(row.status).toBe("done");
      expect(row.mergedAt).not.toBeNull();
    });
  });
});
