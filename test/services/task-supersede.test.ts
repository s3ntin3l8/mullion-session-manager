import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import { gitEnv } from "../../src/services/git-env.js";
import { deriveTaskBranchName } from "../../src/services/git-worktree.js";

// #2292 — a task copy that a project merge superseded must never be retried:
// another task owns the issue now, so resuming this copy's branch would start
// a SECOND worker for work already in flight. `retryTask` refuses it, and the
// refusal is the retry-side twin of #2291's claim-side refusal.
//
// This lives in its own file rather than in test/services/task-claim.test.ts
// because that file is already at its size ceiling (scripts/check-max-file-
// lines.mjs is a ratchet: a file may not grow past its size at the reference
// commit), so the retryTask cases it holds cannot be added to.

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
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

const mockSyncTaskTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: mockSyncTaskTransition,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { retryTask } = await import("../../src/services/task-claim.js");
const { tasks } = await import("../../src/db/schema.js");
const sessionsModule = await import("../../src/services/session-lifecycle.js");
const { createWorktree, removeWorktreeIfClean } =
  await import("../../src/services/git-worktree.js");

const tmpDb = path.join(os.tmpdir(), `task-supersede-test-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-supersede-test-repo-"));
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

describe("retryTask refuses a superseded copy (#2292)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockSyncTaskTransition.mockClear();
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "supersede-p", cwd },
    });
    return res.json().id as number;
  }

  function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  /**
   * The real →failed lifecycle shape: a worker claimed the task, committed
   * work on `mullion/task-<id>`, then failed — the failure cleanup removed the
   * worktree DIRECTORY while deliberately leaving the branch (and its commit)
   * intact, which is what makes a retry able to resume it.
   *
   * `archivedAt` and `supersededAt` are what separate the cases below: a
   * MANUAL archive (the user hid the row) must stay retryable, a merge
   * supersession (another task owns the issue) must not.
   */
  async function insertFailedTaskWithPreservedBranch(
    app: Awaited<ReturnType<typeof buildApp>>,
    projectId: number,
    cwd: string,
    issueNumber: number,
    over: { archivedAt?: Date; supersededAt?: Date } = {},
  ) {
    // Inserted first as a throwaway "ready" row purely to get a real task id:
    // branchName must match `mullion/task-<id>` exactly.
    const [placeholder] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber, title: "t", status: "ready" })
      .returning()
      .all();
    const branchName = deriveTaskBranchName(placeholder);

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
        ...(over.archivedAt ? { archivedAt: over.archivedAt } : {}),
        ...(over.supersededAt ? { supersededAt: over.supersededAt } : {}),
      })
      .where(eq(tasks.id, placeholder.id))
      .returning()
      .all();
    return row;
  }

  it("refuses a copy a project merge superseded, and starts nothing", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 80, {
      archivedAt: new Date(),
      supersededAt: new Date(),
    });
    const spawnSpy = vi.spyOn(sessionsModule, "createSessionRecord");

    const outcome = await retryTask(app, task.id);

    expect(outcome).toMatchObject({ ok: false, reason: "superseded" });
    expect(outcome.ok === false && outcome.detail).toContain("superseded by a project merge");
    // Nothing was reserved, resumed or spawned.
    expect(spawnSpy).not.toHaveBeenCalled();
    const row = getTask(app, task.id);
    expect(row.status).toBe("failed");
    expect(row.sessionId).toBeNull();
    // The row is left exactly as it was — still archived, still holding its
    // branch and its failure reason.
    expect(row.archivedAt).not.toBeNull();
    expect(row.branchName).toBe(task.branchName);
    expect(row.failureReason).toBe("budget exceeded after 120 minutes");

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("reports the supersession rather than the missing branch", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "failed",
        branchName: null,
        archivedAt: new Date(),
        supersededAt: new Date(),
      })
      .returning()
      .all();

    const outcome = await retryTask(app, task.id);

    // "superseded" is the true diagnosis; "no-worktree" is only a symptom of
    // it, so it must not be what the caller is told.
    expect(outcome).toMatchObject({ ok: false, reason: "superseded" });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("still retries a task the user merely archived (#1015)", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 81, {
      archivedAt: new Date(),
    });

    const outcome = await retryTask(app, task.id);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    const row = getTask(app, task.id);
    expect(row.status).toBe("in_progress");
    // The retry un-hides the row, as #1015 requires.
    expect(row.archivedAt).toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });
});
