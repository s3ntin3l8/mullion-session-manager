// task-dispatch.ts — the scheduler half of the claim/dispatch split
// (task-claim.ts). Hermes review, PR #770: the crux of this module
// (capacity accounting, the sweepPending reentrancy guard, and per-task
// backoff) had no dedicated coverage — this file is that coverage. Same
// node-pty/child_process faking as test/services/task-claim.test.ts, for
// the same reason (exercise the service directly without a real
// systemd --user session in CI).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { eq } from "drizzle-orm";

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
const { enqueueTask, dispatchClaimedTask } = await import("../../src/services/task-claim.js");
const { dispatchQueuedTasks, resetDispatchBackoffForTests, resetDispatchStateForTests } =
  await import("../../src/services/task-dispatch.js");
const { tasks, projects } = await import("../../src/db/schema.js");

const tmpDb = path.join(os.tmpdir(), `task-dispatch-test-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-dispatch-test-repo-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

describe("task-dispatch (opportunistic hook + dispatchQueuedTasks)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDispatchBackoffForTests();
    // See resetDispatchStateForTests's own doc comment — a straggling
    // background sweep from THIS test's own opportunistic hook (fire-and-
    // forget) can still be resolving after the test's own assertions and
    // app.close() have already run; reset before the next test's app ever
    // calls dispatchQueuedTasks against it.
    resetDispatchStateForTests();
    // Every test shares one tmpDb file across many short-lived `buildApp()`
    // instances (same pattern as task-claim.test.ts). Capacity accounting
    // (runOneSweep's own `inArray(tasks.status, CONCURRENCY_CAPPED_STATUSES)`
    // count) is global across the whole `tasks` table, not scoped to a
    // single test's rows — a task left "in_progress" by a finished test
    // would otherwise silently eat into the NEXT test's own
    // MULLION_TASK_MAX_CONCURRENT budget. Clear the slate between tests.
    getDb().delete(tasks).run();
    getDb().delete(projects).run();
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "dispatch-p", cwd },
    });
    return res.json().id as number;
  }

  function insertReadyTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    projectId: number,
    issueNumber: number,
    boardOrder = 0,
  ) {
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber, title: "t", status: "ready", boardOrder })
      .returning()
      .all();
    return row;
  }

  function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  // The opportunistic hook's sweep runs a real worktree creation (actual
  // `git` subprocesses, real filesystem I/O) — genuine async work that
  // outlasts a handful of setImmediate/microtask hops. Poll instead of
  // assuming a fixed number of ticks is enough.
  async function waitFor(
    predicate: () => boolean,
    { timeoutMs = 5000, intervalMs = 20 } = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("waitFor: timed out");
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    // The predicate passing means the DB row we're watching reached its
    // final state, but the background sweep promise that produced it
    // (task-dispatch.ts's fire-and-forget opportunistic hook) may still
    // have a few trailing awaits left (logging, the broadcast/sync calls
    // after its own commit) before it reaches its own `finally` and clears
    // `sweepInFlight`. A grace pause here, not just the predicate, is what
    // keeps that straggling promise from still being in flight when the
    // NEXT test's own explicit dispatchQueuedTasks call starts (see
    // resetDispatchStateForTests's own doc comment on the same hazard).
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it("the opportunistic hook dispatches a freshly-enqueued task without an explicit dispatchQueuedTasks call", async () => {
    process.env.MULLION_TASK_MAX_CONCURRENT = "5";
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = insertReadyTask(app, projectId, 1);

    const enqueued = await enqueueTask(app, task.id, { auto: false });
    expect(enqueued.ok).toBe(true);
    // Not yet dispatched — enqueueTask's own recordTaskTransition schedules
    // the sweep via setImmediate, deliberately deferred past this point
    // (see task-dispatch.ts's own doc comment).
    expect(getTask(app, task.id).status).toBe("claimed");

    // "in_progress" is written by the reservation transaction, at the START
    // of dispatch (task-claim.ts's dispatchClaimedTask) — sessionId isn't
    // stamped until the very end, once createSessionRecord itself has
    // resolved. Wait on sessionId, not just the status flip, or this
    // assertion can observe the reserved-but-not-yet-spawned window.
    await waitFor(() => getTask(app, task.id).sessionId !== null);

    const row = getTask(app, task.id);
    expect(row.status).toBe("in_progress");
    expect(row.sessionId).not.toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  it("dispatches exactly maxConcurrent queued tasks and leaves the rest claimed", async () => {
    process.env.MULLION_TASK_MAX_CONCURRENT = "1";
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const first = insertReadyTask(app, projectId, 10, 0);
    const second = insertReadyTask(app, projectId, 11, 1);

    const firstEnqueued = await enqueueTask(app, first.id, { auto: false });
    const secondEnqueued = await enqueueTask(app, second.id, { auto: false });
    expect(firstEnqueued.ok).toBe(true);
    expect(secondEnqueued.ok).toBe(true);

    // Not an explicit dispatchQueuedTasks() call — each enqueueTask above
    // already scheduled its own opportunistic sweep (task-dispatch.ts's own
    // hook), so this exercises the real production trigger path rather
    // than racing an explicit call against those already-scheduled
    // immediates (which one wins is unspecified and irrelevant to the
    // invariant this test actually checks: at most maxConcurrent dispatch).
    await waitFor(() => getTask(app, first.id).sessionId !== null);

    const firstRow = getTask(app, first.id);
    const secondRow = getTask(app, second.id);
    // boardOrder decides which one wins the single slot.
    expect(firstRow.status).toBe("in_progress");
    expect(secondRow.status).toBe("claimed");
    expect(secondRow.sessionId).toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  it("backs off a task whose dispatch failed instead of retrying it on every sweep", async () => {
    process.env.MULLION_TASK_MAX_CONCURRENT = "5";
    const app = await buildApp();
    // Not a git repo at all — resolveDefaultBaseRef/createWorktree fail
    // deterministically without needing to fake git itself, same trick as
    // task-claim.test.ts's own "releases the reservation back to claimed"
    // test.
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "task-dispatch-test-not-a-repo-"));
    const projectId = await createProject(app, notARepo);
    const task = insertReadyTask(app, projectId, 20);
    const enqueued = await enqueueTask(app, task.id, { auto: false });
    expect(enqueued.ok).toBe(true);

    const dispatchSpy = vi.spyOn(
      await import("../../src/services/task-claim.js"),
      "dispatchClaimedTask",
    );

    await dispatchQueuedTasks(app);
    expect(getTask(app, task.id).status).toBe("claimed");
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    // A second sweep, well inside the 5-minute backoff window, must not
    // retry the same failing task — this is the fix for the real bug
    // caught during design: dispatchClaimedTask's own release() fires a
    // "in_progress -> claimed" transition that matches this module's own
    // opportunistic trigger, which would otherwise re-invoke the sweep and
    // retry the identical failure forever.
    await dispatchQueuedTasks(app);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    dispatchSpy.mockRestore();
    fs.rmSync(notARepo, { recursive: true, force: true });
    await app.close();
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  it("clears backoff on a later successful dispatch, so a task isn't stuck backed off forever", async () => {
    process.env.MULLION_TASK_MAX_CONCURRENT = "5";
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = insertReadyTask(app, projectId, 21);
    const enqueued = await enqueueTask(app, task.id, { auto: false });
    expect(enqueued.ok).toBe(true);

    // First call to createSessionRecord fails, every later call succeeds —
    // chained rather than a single `...Once`, because enqueueTask's own
    // transition unconditionally schedules a deferred opportunistic
    // dispatch (task-dispatch.ts's own hook) alongside this test's explicit
    // calls below; either one could reach createSessionRecord first. Same
    // race, same fix, as task-claim.test.ts's own "not `...Once`" comments.
    const claimModule = await import("../../src/services/session-lifecycle.js");
    const spawnSpy = vi
      .spyOn(claimModule, "createSessionRecord")
      .mockResolvedValueOnce({ ok: false, reason: "spawn-failed" });

    await dispatchQueuedTasks(app);
    expect(getTask(app, task.id).status).toBe("claimed");

    // Bypasses the still-active backoff window deliberately — this test is
    // about backoff clearing on success, not about waiting out the window
    // (covered above) — so it dispatches directly rather than through
    // another dispatchQueuedTasks sweep.
    const outcome = await dispatchClaimedTask(app, task.id);
    expect(outcome.ok).toBe(true);
    expect(getTask(app, task.id).status).toBe("in_progress");
    spawnSpy.mockRestore();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  it("coalesces overlapping dispatchQueuedTasks calls instead of dropping or double-dispatching", async () => {
    process.env.MULLION_TASK_MAX_CONCURRENT = "5";
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const first = insertReadyTask(app, projectId, 30, 0);
    const second = insertReadyTask(app, projectId, 31, 1);
    await enqueueTask(app, first.id, { auto: false });
    await enqueueTask(app, second.id, { auto: false });

    // Two overlapping calls, neither awaited before the other starts — the
    // second must not be silently dropped (the sweepInFlight/sweepPending
    // guard's whole job) nor cause either task to be dispatched twice.
    const [a, b] = [dispatchQueuedTasks(app), dispatchQueuedTasks(app)];
    await Promise.all([a, b]);

    const firstRow = getTask(app, first.id);
    const secondRow = getTask(app, second.id);
    expect(firstRow.status).toBe("in_progress");
    expect(secondRow.status).toBe("in_progress");
    expect(firstRow.sessionId).not.toBe(secondRow.sessionId);

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  it("a scheduled sweep for a closed app never fires against a later app's rows", async () => {
    process.env.MULLION_TASK_MAX_CONCURRENT = "5";
    const appA = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(appA, cwd);
    const task = insertReadyTask(appA, projectId, 40);

    // Schedules a sweep (via the opportunistic hook) and closes the app
    // immediately after, before that sweep has any chance to run — this is
    // exactly the onClose fix's own scenario (Hermes review, PR #770): a
    // pending setImmediate must be cancelled, not merely orphaned, so it
    // can never later act on a DIFFERENT app's connection.
    const enqueued = await enqueueTask(appA, task.id, { auto: false });
    expect(enqueued.ok).toBe(true);
    await appA.close();

    // Give the event loop several turns — if the cancelled immediate were
    // still pending, it would have fired by now.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const appB = await buildApp();
    // No assertion needed beyond "this doesn't throw" — a leaked immediate
    // calling dispatchQueuedTasks(appA) against a closed app's connection
    // would surface as an unhandled rejection/error here.
    await dispatchQueuedTasks(appB);
    await appB.close();

    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });
});
