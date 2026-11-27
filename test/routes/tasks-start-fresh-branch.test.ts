// Issue #3229 — a "Start fresh" retry collides with the branch it abandoned.
//
// The whole point of "Start fresh" (issue #3194) is that the preserved
// branch SURVIVES: it stays on the host that owns it, with the worker's
// commits, and the task runs on from scratch. The branch name is
// deterministic, so the new claim used to derive the very name the abandoned
// branch still held — and the claim's orphan-clear then deleted it (the
// only copy of those commits), or refused the claim outright when the
// worktree directory was already gone.
//
// These are the REAL entry points: the route (`POST /api/tasks/:id/start-
// fresh`, via app.inject()) and then the dispatch tick, against a REAL git
// repository — the fakes other task tests use would fake away the very thing
// this issue is about (a branch that exists, with commits on it).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import { gitEnv } from "../../src/services/git-env.js";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (command === "git") return actual.spawn(command, args, options);
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: vi.fn().mockResolvedValue(undefined),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb, getDb } = await import("../../src/db/client.js");
const { dispatchQueuedTasks, resetDispatchBackoffForTests, resetDispatchStateForTests } =
  await import("../../src/services/task-dispatch.js");
const { deriveTaskBranchName, deriveWorktreePath } =
  await import("../../src/services/git-worktree.js");
const { tasks, projects, sessions } = await import("../../src/db/schema.js");

const tmpDb = path.join(os.tmpdir(), `tasks-start-fresh-branch-test-${process.pid}.db`);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
}

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-start-fresh-branch-repo-"));
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

/** Does this branch exist in the repo? */
function branchExists(cwd: string, branch: string): boolean {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** The subject of a branch's tip commit — "the commits are still there". */
function branchTipSubject(cwd: string, branch: string): string {
  return git(cwd, ["log", "-1", "--format=%s", branch]).trim();
}

describe("a 'Start fresh' claim does not collide with the branch it abandoned (#3229)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    process.env.MULLION_TASK_MAX_CONCURRENT = "5";
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDispatchBackoffForTests();
    resetDispatchStateForTests();
    // Every test in this file shares one database file (the repo's pattern),
    // so the previous test's rows are cleared here.
    getDb().delete(sessions).run();
    getDb().delete(tasks).run();
    getDb().delete(projects).run();
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "start-fresh-p", cwd },
    });
    return res.json().id as number;
  }

  function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  async function waitFor(predicate: () => boolean, { timeoutMs = 10000 } = {}): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("waitFor: timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * A task whose retry WAITS for its original host, with the preserved
   * branch really on disk with a commit on it — the shape "Start fresh" is
   * offered against.
   */
  async function setupWaitingRetry() {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "start fresh",
        status: "claimed",
        resumeQueued: true,
        // The host the retry waits for — and the host the branch was
        // abandoned on. "local" is this install's own host, which is where
        // the repository below lives.
        retryHostId: "local",
        retryStrandedOnHost: true,
        dispatchHeld: true,
        failureReason: "waiting for host local",
      })
      .returning()
      .all();

    // The preserved branch, in its deterministic name, with a real commit
    // on it: that commit is the work "Start fresh" promises to keep.
    const abandoned = deriveTaskBranchName({ id: task.id, title: task.title });
    const worktreePath = deriveWorktreePath(cwd, abandoned);
    git(cwd, ["worktree", "add", "-b", abandoned, worktreePath, "main"]);
    fs.writeFileSync(path.join(worktreePath, "worker.txt"), "the worker's work");
    git(worktreePath, ["add", "-A"]);
    git(worktreePath, ["commit", "-m", "worker work", "--no-verify"]);
    app.db
      .update(tasks)
      .set({ branchName: abandoned, worktreePath })
      .where(eq(tasks.id, task.id))
      .run();

    return { app, cwd, task, abandoned, worktreePath };
  }

  it("claims on a branch of its own, and leaves the abandoned branch (and its commits) alone", async () => {
    const { app, cwd, task, abandoned } = await setupWaitingRetry();
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/start-fresh`,
      });
      expect(res.statusCode).toBe(202);

      // The abandoned branch is recorded on the ROW, not only in the
      // transition context: the claim path reads it from there. The row's
      // own branch name is the re-queued claim's — never the abandoned one.
      const afterFresh = getTask(app, task.id);
      expect(afterFresh.abandonedBranches).toContain(abandoned);
      expect(afterFresh.branchName).not.toBe(abandoned);
      expect(afterFresh.branchName).toBe(`${abandoned}-attempt-2`);

      // The dispatch tick picks the re-queued task up.
      await dispatchQueuedTasks(app);
      await waitFor(() => getTask(app, task.id).sessionId !== null);

      const row = getTask(app, task.id);
      expect(row.status).toBe("in_progress");
      // A name of its own — the abandoned one is not reused.
      expect(row.branchName).not.toBe(abandoned);
      expect(row.branchName).toBe(`${abandoned}-attempt-2`);
      expect(branchExists(cwd, row.branchName as string)).toBe(true);

      // The abandoned branch is still there, with the commit on it.
      expect(branchExists(cwd, abandoned)).toBe(true);
      expect(branchTipSubject(cwd, abandoned)).toBe("worker work");
      // And its worktree was not removed either — the new claim works in a
      // worktree of its own.
      expect(fs.existsSync(deriveWorktreePath(cwd, row.branchName as string))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    }
  });

  it("keeps the abandoned branch when the claim lands on the host that still holds it", async () => {
    // The same shape, but the abandoned branch's worktree directory is GONE
    // (a boot-time prune removed it) while the branch ref survived — the
    // case that used to refuse the claim on every sweep with "stale branch
    // from a prior attempt exists — resolve manually".
    const { app, cwd, task, abandoned, worktreePath } = await setupWaitingRetry();
    try {
      git(cwd, ["worktree", "remove", "--force", worktreePath]);
      expect(fs.existsSync(worktreePath)).toBe(false);
      expect(branchExists(cwd, abandoned)).toBe(true);

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/start-fresh`,
      });
      expect(res.statusCode).toBe(202);

      await dispatchQueuedTasks(app);
      await waitFor(() => getTask(app, task.id).sessionId !== null);

      const row = getTask(app, task.id);
      expect(row.status).toBe("in_progress");
      expect(row.branchName).not.toBe(abandoned);
      // The abandoned branch and its commit survived the claim.
      expect(branchExists(cwd, abandoned)).toBe(true);
      expect(branchTipSubject(cwd, abandoned)).toBe("worker work");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    }
  });
});
