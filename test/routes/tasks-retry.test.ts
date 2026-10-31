import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import { gitEnv } from "../../src/services/git-env.js";
import { deriveTaskBranchName } from "../../src/services/git-worktree.js";

// #2292 — the route-level half of the superseded-copy refusal:
// `POST /api/tasks/:id/retry` answers 409 for a copy a project merge
// superseded, instead of resuming its branch and spawning a duplicate worker.
//
// This lives in its own file rather than in test/routes/tasks.test.ts because
// that file is already at its size ceiling (scripts/check-max-file-lines.mjs
// is a ratchet: a file may not grow past its size at the reference commit).

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

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");
const { createWorktree, removeWorktreeIfClean } =
  await import("../../src/services/git-worktree.js");

const tmpDb = path.join(os.tmpdir(), `tasks-retry-route-test-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-retry-route-repo-"));
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

describe("POST /api/tasks/:id/retry — a superseded copy is refused (#2292)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    // Retry is flag-gated (it spawns a session), same as Claim.
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  async function createProjectWithGitRepo(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "retry-superseded-p", cwd },
    });
    return res.json().id as number;
  }

  /** The real →failed lifecycle shape (a claimed task that failed, keeping
   * its branch) plus the merge's own marks: archived, with its issue number
   * cleared and `supersededAt` set. */
  async function insertSupersededFailedTask(
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
        failureReason: "Merged from project #7: superseded.",
        completedAt: new Date(),
        worktreePath: created.path,
        branchName,
        sessionId: null,
        // What the merge leaves behind: archived, its issue number cleared
        // (NULLs do not collide), and marked as superseded.
        issueNumber: null,
        archivedAt: new Date(),
        supersededAt: new Date(),
      })
      .where(eq(tasks.id, placeholder.id))
      .returning()
      .all();
    return row;
  }

  it("409s a copy a project merge superseded, and starts no session", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProjectWithGitRepo(app, cwd);
    const task = await insertSupersededFailedTask(app, projectId, cwd, 90);

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("superseded by a project merge");

    // The row is untouched: still failed, still archived, no session.
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(row.status).toBe("failed");
    expect(row.sessionId).toBeNull();
    expect(row.archivedAt).not.toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });
});
