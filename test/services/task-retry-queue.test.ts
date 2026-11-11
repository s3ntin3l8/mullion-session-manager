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

// Same fakes as task-claim-retry-reused.test.ts: no real systemd/pty, real git.
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
const { enqueueRetry } = await import("../../src/services/task-retry.js");
const { dispatchQueuedRetry, dispatchClaimedTask } =
  await import("../../src/services/task-claim.js");
const { tasks } = await import("../../src/db/schema.js");
const { createWorktree } = await import("../../src/services/git-worktree.js");

const tmpDb = path.join(os.tmpdir(), `task-retry-queue-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

describe("a retry is queued, then started by the dispatch sweep", () => {
  const original = process.env.MULLION_TASK_MAX_CONCURRENT;
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    if (original === undefined) delete process.env.MULLION_TASK_MAX_CONCURRENT;
    else process.env.MULLION_TASK_MAX_CONCURRENT = original;
  });

  async function setup(issueNumber: number) {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-retry-queue-repo-"));
    git(cwd, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "initial", "--no-verify"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: `retry-queue-${issueNumber}`, cwd },
    });
    const projectId = res.json().id as number;
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber, title: "t", status: "ready" })
      .returning()
      .all();
    const branchName = deriveTaskBranchName(row);
    const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
    const worktreePath = created.path as string;
    app.db
      .update(tasks)
      .set({
        status: "failed",
        failureReason: "budget exceeded after 120 minutes",
        completedAt: new Date(),
        worktreePath,
        branchName,
      })
      .where(eq(tasks.id, row.id))
      .run();
    const load = () => app.db.select().from(tasks).where(eq(tasks.id, row.id)).get()!;
    return { app, cwd, id: row.id, projectId, load };
  }

  it("queues a retry at the concurrency cap instead of refusing it, then starts it once a slot is free", async () => {
    const { app, cwd, id, load } = await setup(91);
    const cap = app.config as { MULLION_TASK_MAX_CONCURRENT: number };
    cap.MULLION_TASK_MAX_CONCURRENT = 0;

    // Queued, not refused: the row waits in `claimed`, nothing is spawned.
    expect((await enqueueRetry(app, id)).ok).toBe(true);
    expect(load()).toMatchObject({
      status: "claimed",
      resumeQueued: true,
      sessionId: null,
      failureReason: null,
      completedAt: null,
      claimedAt: null,
    });
    expect(load().queuedAt).not.toBeNull();

    // No slot: the dispatch reports the cap and leaves the retry queued.
    const capped = await dispatchQueuedRetry(app, id);
    expect(capped).toMatchObject({ ok: false, reason: "cap", limit: 0 });
    expect(load()).toMatchObject({ status: "claimed", resumeQueued: true });

    // A slot frees up: the branch is resumed and the budget clock starts now.
    cap.MULLION_TASK_MAX_CONCURRENT = 1000;
    expect((await dispatchQueuedRetry(app, id)).ok).toBe(true);
    const row = load();
    expect(row).toMatchObject({ status: "in_progress", resumeQueued: false });
    expect(row.sessionId).not.toBeNull();
    expect(row.claimedAt).not.toBeNull();
    expect(row.startedAt).not.toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("the sweep starts a queued retry on its own when a slot is free", async () => {
    const { app, cwd, id, load } = await setup(92);
    (app.config as { MULLION_TASK_MAX_CONCURRENT: number }).MULLION_TASK_MAX_CONCURRENT = 1000;

    await enqueueRetry(app, id);
    await vi.waitFor(
      () => {
        expect(load().status).toBe("in_progress");
        expect(load().sessionId).not.toBeNull();
      },
      { timeout: 15000 },
    );

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("keeps a queued retry and a fresh claim apart", async () => {
    const { app, cwd, id, projectId, load } = await setup(93);
    (app.config as { MULLION_TASK_MAX_CONCURRENT: number }).MULLION_TASK_MAX_CONCURRENT = 0;

    await enqueueRetry(app, id);
    expect(await dispatchClaimedTask(app, id)).toMatchObject({ ok: false, reason: "not-queued" });

    const [fresh] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber: 94, title: "fresh", status: "claimed" })
      .returning()
      .all();
    expect(await dispatchQueuedRetry(app, fresh.id)).toMatchObject({
      ok: false,
      reason: "not-queued",
    });
    expect(load()).toMatchObject({ status: "claimed", resumeQueued: true });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("refuses to queue a task that is not failed or has no branch to resume", async () => {
    const { app, cwd, id, load } = await setup(95);
    (app.config as { MULLION_TASK_MAX_CONCURRENT: number }).MULLION_TASK_MAX_CONCURRENT = 0;

    app.db.update(tasks).set({ branchName: null }).where(eq(tasks.id, id)).run();
    expect(await enqueueRetry(app, id)).toMatchObject({ ok: false, reason: "no-worktree" });
    expect(load().status).toBe("failed");

    app.db.update(tasks).set({ status: "ready" }).where(eq(tasks.id, id)).run();
    expect(await enqueueRetry(app, id)).toMatchObject({ ok: false, reason: "not-failed" });
    expect(await enqueueRetry(app, 999999)).toMatchObject({ ok: false, reason: "not-found" });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });
});
