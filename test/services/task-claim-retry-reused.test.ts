import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import type * as TaskPrompt from "../../src/services/task-prompt.js";
import { eq } from "drizzle-orm";
import { gitEnv } from "../../src/services/git-env.js";
import { deriveTaskBranchName } from "../../src/services/git-worktree.js";

// Same fakes as task-claim-retry-model.test.ts: no real systemd/pty, real git.
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
vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/task-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TaskPrompt>();
  return { ...actual, buildWorkerPrompt: vi.fn(actual.buildWorkerPrompt) };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { retryTask } = await import("../../src/services/task-claim.js");
const { buildWorkerPrompt } = await import("../../src/services/task-prompt.js");
const { tasks } = await import("../../src/db/schema.js");
const { createWorktree } = await import("../../src/services/git-worktree.js");

const tmpDb = path.join(os.tmpdir(), `task-claim-retry-reused-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

describe("retryTask adopting a leftover worktree", () => {
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

  it("retries in the leftover worktree and tells the worker via reusedWorktree", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-claim-retry-reused-repo-"));
    git(cwd, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "initial", "--no-verify"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "retry-reused-p", cwd },
    });
    const projectId = res.json().id as number;
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber: 81, title: "t", status: "ready" })
      .returning()
      .all();
    const branchName = deriveTaskBranchName(row);
    const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
    const worktreePath = created.path as string;
    // Dirty, so the →failed cleanup would have left it in place.
    fs.writeFileSync(path.join(worktreePath, "wip.txt"), "uncommitted");
    app.db
      .update(tasks)
      .set({ status: "failed", worktreePath, branchName })
      .where(eq(tasks.id, row.id))
      .run();

    expect((await retryTask(app, row.id)).ok).toBe(true);

    expect(vi.mocked(buildWorkerPrompt).mock.calls.at(-1)?.[0]).toMatchObject({
      mode: "retry",
      worktreePath,
      reusedWorktree: true,
    });
    expect(fs.readFileSync(path.join(worktreePath, "wip.txt"), "utf8")).toBe("uncommitted");

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });
});
