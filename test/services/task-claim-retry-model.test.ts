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

// Same fakes as task-claim.test.ts: no real systemd/pty, real git.
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

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { retryTask } = await import("../../src/services/task-claim.js");
const { tasks } = await import("../../src/db/schema.js");
const { createWorktree, removeWorktreeIfClean } =
  await import("../../src/services/git-worktree.js");

const tmpDb = path.join(os.tmpdir(), `task-claim-retry-model-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

describe("retryTask task-level model (#2491)", () => {
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

  it("runs with the chosen model; an agent-family change drops it", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-claim-retry-model-repo-"));
    git(cwd, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "initial", "--no-verify"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "retry-model-p", cwd },
    });
    const projectId = res.json().id as number;

    // A failed task whose preserved branch (no worktree dir) can be resumed.
    const failedTask = async (issueNumber: number, agent: string) => {
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber, title: "t", status: "ready" })
        .returning()
        .all();
      const branchName = deriveTaskBranchName(row);
      const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
      if (!created?.path) throw new Error("test setup: failed to create worktree");
      await removeWorktreeIfClean(created.path, cwd);
      app.db
        .update(tasks)
        .set({
          status: "failed",
          worktreePath: created.path,
          branchName,
          agent,
          modelOverride: "claude-opus-4-5",
          model: "stale",
        })
        .where(eq(tasks.id, row.id))
        .run();
      return row.id;
    };
    const load = (id: number) => app.db.select().from(tasks).where(eq(tasks.id, id)).all()[0];

    const same = await failedTask(71, "claude");
    expect((await retryTask(app, same)).ok).toBe(true);
    expect(load(same)).toMatchObject({
      model: "claude-opus-4-5",
      modelOverride: "claude-opus-4-5",
    });

    const changed = await failedTask(72, "claude");
    expect((await retryTask(app, changed, { agent: "codex" })).ok).toBe(true);
    expect(load(changed)).toMatchObject({ agent: "codex", modelOverride: null });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });
});
