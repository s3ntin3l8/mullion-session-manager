import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync, spawn as childProcessSpawn } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { eq } from "drizzle-orm";

// Same fakes as test/routes/tasks.test.ts — claimTask spawns a real
// session via createSessionRecord, faked so this file exercises the
// service directly without a real systemd --user session in CI. `git`
// subprocesses are left real (worktree creation/failure needs real git).
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

const mockSyncTaskTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: mockSyncTaskTransition,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { enqueueTask, dispatchClaimedTask, retryTask } =
  await import("../../src/services/task-claim.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const sessionsModule = await import("../../src/services/session-lifecycle.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const hostGitModule = await import("../../src/services/host-git.js");
const { HostRequestError } = await import("../../src/services/remote-host-client.js");
const { createWorktree, removeWorktreeIfClean } =
  await import("../../src/services/git-worktree.js");

const tmpDb = path.join(os.tmpdir(), `task-claim-test-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-claim-test-repo-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

describe("claimTask", () => {
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
      payload: { createDir: true, name: "claim-svc-p", cwd },
    });
    return res.json().id as number;
  }

  function insertReadyTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    projectId: number,
    issueNumber: number,
    body: string | null = "some details",
  ) {
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber, title: "t", body, status: "ready" })
      .returning()
      .all();
    return row;
  }

  // Task-claim queueing (rate-limit-storm fix) — the old single-phase
  // `claimTask` split into `enqueueTask` (reservation, agent resolution,
  // no-seed-channel refusal) and `dispatchClaimedTask` (worktree creation,
  // base-ref resolution, session spawn). Most of this describe block's
  // tests exercise the combined end-to-end behavior the old function had;
  // this helper reproduces that by running both steps and returning
  // dispatch's outcome (or enqueue's own failure, unchanged shape, if it
  // never got that far). Tests that need to inspect the INTERMEDIATE
  // "claimed but not yet dispatched" state call enqueueTask/
  // dispatchClaimedTask separately instead.
  async function claimAndDispatch(
    app: Awaited<ReturnType<typeof buildApp>>,
    taskId: number,
    opts: { auto: boolean; agent?: string | null; reviewAgent?: string | null },
  ) {
    const enqueued = await enqueueTask(app, taskId, opts);
    if (!enqueued.ok) return enqueued;
    return dispatchClaimedTask(app, taskId);
  }

  function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  it("refuses an auto-claim outright when the resolved agent has no seed-delivery channel — no spawn, no reservation left behind", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    // gemini has no hook adapter at all (KNOWN_AGENTS with no adapter entry
    // — currently aider/gemini/pi), so it's genuinely seed-incapable — see
    // task-agent-resolve.test.ts's commandSupportsSeed coverage. opencode
    // used to be this test's example too, but it gained `initialPromptArgs`
    // (`--prompt`) and is seed-capable now — see hook-adapters/opencode.ts.
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { defaultAgent: "gemini" },
    });
    const task = insertReadyTask(app, projectId, 60);

    const outcome = await claimAndDispatch(app, task.id, { auto: true });

    expect(outcome).toMatchObject({ ok: false, reason: "no-seed-channel" });
    if (!outcome.ok) expect(outcome.detail).toContain("gemini");

    // No reservation ever made — enqueueTask's no-seed-channel refusal
    // returns before its own transaction runs at all, unlike a dispatch
    // failure (which DOES reserve first, then releases back to "claimed" —
    // see the release() tests below). The task is exactly as claimable as
    // before the attempt.
    const row = getTask(app, task.id);
    expect(row.status).toBe("ready");
    expect(row.sessionId).toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("still claims manually (auto: false) with a no-seed-channel agent, marking seedDelivered false", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { defaultAgent: "gemini" },
    });
    const task = insertReadyTask(app, projectId, 61);

    const outcome = await claimAndDispatch(app, task.id, { auto: false });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.seedDelivered).toBe(false);

    // gemini has no adapter at all, so no initial-prompt argv form (see
    // hook-adapters/index.ts's getAdapterInitialPromptArgs) — the spawned
    // command must be untouched, not carrying the task's title/body
    // anywhere.
    const call = vi
      .mocked(childProcessSpawn)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    expect(args[args.length - 1]).toBe("gemini");

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("delivers the task prompt as the agent's initial-prompt argv, not via stashSeed (SessionStart's additionalContext never starts a turn)", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = insertReadyTask(app, projectId, 62, "some details");
    const stashSeedSpy = vi.spyOn(app.pty, "stashSeed");

    const outcome = await claimAndDispatch(app, task.id, { auto: false });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.seedDelivered).toBe(true);
    // The default launcher agent (claude) is seed-capable — stashSeed must
    // NOT be called for the task prompt: it's delivered as argv instead, at
    // spawn time, so it actually starts a turn.
    expect(stashSeedSpy).not.toHaveBeenCalled();

    const call = vi
      .mocked(childProcessSpawn)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    const spawnedArg = args[args.length - 1];
    // The issue text still lands, and still last — but it now trails the
    // Task Master preamble (task-prompt.ts) rather than being the whole
    // prompt, so this asserts the tail rather than the full quoted string.
    expect(spawnedArg).toContain("t\n\nsome details'");
    expect(spawnedArg).toContain("as a Mullion Task Master worker");
    // Claimed with auto:false — a human is watching, so the "don't stop to
    // ask" instruction must be absent. See task-prompt.ts's `auto` doc.
    expect(spawnedArg).not.toContain("Nobody is watching this session");

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  // Task-claim queueing (rate-limit-storm fix) — the old single sync
  // ("claimed", carrying the just-spawned session's fields) split into TWO:
  // enqueueTask syncs "claimed" with NO session fields (none exist yet —
  // that's the whole point of the queue), and dispatchClaimedTask syncs
  // "in_progress" with the just-committed session fields, mirroring what
  // the now-removed reconciler "claimed -> in_progress" branch used to sync
  // before dispatch existed (task-reconciler.ts's own history).
  it("syncs claimed with no session fields at enqueue, then in_progress with the just-committed session fields at dispatch", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = insertReadyTask(app, projectId, 62);

    const outcome = await claimAndDispatch(app, task.id, { auto: false });
    expect(outcome.ok).toBe(true);

    expect(mockSyncTaskTransition).toHaveBeenCalledTimes(2);
    const [, claimedTask, claimedProject, claimedEvent] = mockSyncTaskTransition.mock.calls[0];
    expect(claimedEvent).toBe("claimed");
    expect(claimedTask).toMatchObject({ id: task.id, issueNumber: 62, status: "claimed" });
    expect(claimedTask.sessionId).toBeNull();
    expect(claimedProject).toMatchObject({ id: projectId });

    const [, dispatchedTask, dispatchedProject, dispatchedEvent] =
      mockSyncTaskTransition.mock.calls[1];
    expect(dispatchedEvent).toBe("in_progress");
    expect(dispatchedTask).toMatchObject({
      id: task.id,
      issueNumber: 62,
      status: "in_progress",
      branchName: `mullion/task-${task.id}`,
    });
    // sessionId/worktreePath came from the just-created session record, not
    // the pre-dispatch task snapshot (which had neither set) — verifies
    // task-claim.ts's hand-merged object actually carries the committed
    // values forward rather than the stale ones from before dispatch.
    expect(dispatchedTask.sessionId).not.toBeNull();
    expect(dispatchedTask.worktreePath).not.toBeNull();
    expect(dispatchedProject).toMatchObject({ id: projectId });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("stamps baseSha with the resolved commit SHA the worktree actually branched from (#491)", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const expectedSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { env: gitEnv() })
      .toString("utf8")
      .trim();
    const projectId = await createProject(app, cwd);
    const task = insertReadyTask(app, projectId, 69);

    const outcome = await claimAndDispatch(app, task.id, { auto: false });
    expect(outcome.ok).toBe(true);

    const row = getTask(app, task.id);
    expect(row.baseSha).toBe(expectedSha);

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("releases the reservation back to claimed (not ready) when worktree creation fails, recording a failureReason", async () => {
    const app = await buildApp();
    // Not a git repo at all — resolveDefaultBaseRef/createWorktree fail
    // deterministically without needing to fake git itself.
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "task-claim-test-not-a-repo-"));
    const projectId = await createProject(app, notARepo);
    const task = insertReadyTask(app, projectId, 62);

    const outcome = await claimAndDispatch(app, task.id, { auto: false });

    expect(outcome).toMatchObject({ ok: false, reason: "worktree-failed" });

    // Released to "claimed" (its queue position), not stranded and not
    // demoted all the way back to "ready" — task-claim.ts's
    // dispatchClaimedTask's own doc comment: an enqueue was a real,
    // unconditional commitment. Retryable (task-dispatch.ts's backoff), and
    // the concurrency slot isn't silently leaked forever.
    const row = getTask(app, task.id);
    expect(row.status).toBe("claimed");
    expect(row.sessionId).toBeNull();
    expect(row.failureReason).toBe("worktree creation failed");

    fs.rmSync(notARepo, { recursive: true, force: true });
    await app.close();
  });

  it("nulls out a stale seedDelivered on release, so a released (still-claimed) task never carries a prior attempt's value forward", async () => {
    const app = await buildApp();
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "task-claim-test-stale-seed-"));
    const projectId = await createProject(app, notARepo);
    const task = insertReadyTask(app, projectId, 75);
    // Simulates a hypothetical future path landing this row back in
    // "claimed" with a real prior dispatch's seedDelivered still on it —
    // no such path exists today (only dispatchClaimedTask's own commit
    // block ever writes it), but this is belt-and-suspenders against one
    // ever reusing this release() path, same posture as the existing
    // worktreePath/branchName/baseSha nulling just above.
    app.db.update(tasks).set({ seedDelivered: true }).where(eq(tasks.id, task.id)).run();

    const outcome = await claimAndDispatch(app, task.id, { auto: false });

    expect(outcome).toMatchObject({ ok: false, reason: "worktree-failed" });
    const row = getTask(app, task.id);
    expect(row.status).toBe("claimed");
    expect(row.seedDelivered).toBeNull();

    fs.rmSync(notARepo, { recursive: true, force: true });
    await app.close();
  });

  it("404s cleanly for an unknown task id", async () => {
    const app = await buildApp();
    const outcome = await claimAndDispatch(app, 999999, { auto: false });
    expect(outcome).toEqual({ ok: false, reason: "not-found" });
    await app.close();
  });

  it("releases the reservation when something throws mid-spawn (not just a documented {ok:false} failure)", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = insertReadyTask(app, projectId, 63);

    // Not `...Once` — task-claim queueing (rate-limit-storm fix) means
    // enqueueTask's own transition unconditionally schedules a deferred
    // background dispatch attempt (task-dispatch.ts's opportunistic hook)
    // alongside this test's own explicit dispatchClaimedTask call, and
    // whichever one reaches createSessionRecord FIRST would otherwise
    // consume a one-shot mock, leaving the other fall through to the real
    // implementation nondeterministically. Rejecting unconditionally makes
    // every call within this test's scope fail the same way, regardless of
    // which one wins that race.
    vi.spyOn(sessionsModule, "createSessionRecord").mockRejectedValue(
      new Error("boom: unexpected spawn error"),
    );

    const outcome = await claimAndDispatch(app, task.id, { auto: false });

    expect(outcome).toMatchObject({ ok: false, reason: "spawn-failed" });
    if (!outcome.ok) expect(outcome.detail).toContain("boom");

    // Released to "claimed", not stranded — same contract as the
    // documented {ok:false} failure paths above, now also covering a
    // thrown error.
    const row = getTask(app, task.id);
    expect(row.status).toBe("claimed");
    expect(row.sessionId).toBeNull();
    expect(row.failureReason).toContain("boom");

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("nulls out a stale baseSha on release, so a released task never carries a prior attempt's value forward (#491)", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = insertReadyTask(app, projectId, 70);
    // Simulate a leftover baseSha from an earlier claim/release cycle on
    // this same "ready" row (release() doesn't touch baseSha on a task
    // still in "ready" — this stamps it directly to exercise the release
    // path below, which must still clear it).
    app.db.update(tasks).set({ baseSha: "deadbeef" }).where(eq(tasks.id, task.id)).run();

    // Not `...Once` — task-claim queueing (rate-limit-storm fix) means
    // enqueueTask's own transition unconditionally schedules a deferred
    // background dispatch attempt (task-dispatch.ts's opportunistic hook)
    // alongside this test's own explicit dispatchClaimedTask call, and
    // whichever one reaches createSessionRecord FIRST would otherwise
    // consume a one-shot mock, leaving the other fall through to the real
    // implementation nondeterministically. Rejecting unconditionally makes
    // every call within this test's scope fail the same way, regardless of
    // which one wins that race.
    vi.spyOn(sessionsModule, "createSessionRecord").mockRejectedValue(
      new Error("boom: unexpected spawn error"),
    );

    const outcome = await claimAndDispatch(app, task.id, { auto: false });
    expect(outcome).toMatchObject({ ok: false, reason: "spawn-failed" });

    const row = getTask(app, task.id);
    expect(row.baseSha).toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  describe("orphan-clearing before create (6.8/#283)", () => {
    it("clears a clean leftover worktree at the deterministic path before creating, so a retry after a crashed attempt succeeds", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProject(app, cwd);
      const task = insertReadyTask(app, projectId, 64);

      // Simulate a prior claim attempt that created the worktree but crashed
      // before stamping tasks.worktreePath — the exact gap this step exists
      // to close. The directory sits at the same deterministic path a fresh
      // claim for this task id will try to create.
      const { createWorktree } = await import("../../src/services/git-worktree.js");
      const leftover = await createWorktree({
        cwd,
        baseRef: "main",
        seed: `mullion/task-${task.id}`,
        branchName: `mullion/task-${task.id}`,
      });
      expect(leftover).not.toBeNull();

      const outcome = await claimAndDispatch(app, task.id, { auto: false });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.session.cwd).toBe(leftover!.path);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("refuses the claim (releasing the reservation) when the leftover worktree at the deterministic path is dirty", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProject(app, cwd);
      const task = insertReadyTask(app, projectId, 65);

      const { createWorktree } = await import("../../src/services/git-worktree.js");
      const leftover = await createWorktree({
        cwd,
        baseRef: "main",
        seed: `mullion/task-${task.id}`,
        branchName: `mullion/task-${task.id}`,
      });
      expect(leftover).not.toBeNull();
      fs.writeFileSync(path.join(leftover!.path, "dirty.txt"), "uncommitted from a stuck attempt");

      const outcome = await claimAndDispatch(app, task.id, { auto: false });

      expect(outcome).toMatchObject({ ok: false, reason: "worktree-failed" });
      if (!outcome.ok) expect(outcome.detail).toContain("dirty");

      // Released, retryable — same contract as every other pre-commit
      // failure path.
      const row = getTask(app, task.id);
      expect(row.status).toBe("claimed");
      expect(row.sessionId).toBeNull();
      // The dirty leftover is never destroyed — a human needs to resolve it.
      expect(fs.existsSync(leftover!.path)).toBe(true);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("stamps status/worktreePath/branchName into the row at dispatch's reservation time, before the worktree exists on disk (independent review, PR #476)", async () => {
      // Closes a race with plugins/task-watcher.ts's boot-time orphan sweep:
      // that sweep treats any on-disk task-worktree directory not
      // referenced by a non-terminal task's worktreePath as an orphan. If
      // the DB write lagged the on-disk creation (the old ordering), a
      // human claiming a task moments after a restart could race the
      // fire-and-forget sweep into deleting the worktree this very claim
      // just created. Verified here by inspecting the row from inside a
      // spy on createSessionRecord — i.e. BEFORE the worktree is actually
      // created — and confirming the DB already reflects the claim.
      //
      // Task-claim queueing (rate-limit-storm fix) — worktreePath/branchName
      // are still stamped at ENQUEUE (before this point), but status is now
      // "in_progress" here, not "claimed": dispatchClaimedTask's own
      // reservation transaction flips claimed -> in_progress BEFORE calling
      // createSessionRecord (mirroring the same "DB write precedes disk
      // write" ordering this test was written to pin, just one level
      // further down the pipeline now that claim/dispatch are split).
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProject(app, cwd);
      const task = insertReadyTask(app, projectId, 67);

      const realCreateSessionRecord = sessionsModule.createSessionRecord;
      let sawDuringSpawn: ReturnType<typeof getTask> | undefined;
      const spy = vi
        .spyOn(sessionsModule, "createSessionRecord")
        .mockImplementation(async (appArg, params) => {
          sawDuringSpawn = getTask(appArg, task.id);
          return realCreateSessionRecord(appArg, params);
        });

      const outcome = await claimAndDispatch(app, task.id, { auto: false });

      expect(outcome.ok).toBe(true);
      expect(sawDuringSpawn?.status).toBe("in_progress");
      expect(sawDuringSpawn?.worktreePath).toBe(
        `${cwd}/.mullion-worktrees/mullion-task-${task.id}`,
      );
      expect(sawDuringSpawn?.branchName).toBe(`mullion/task-${task.id}`);

      spy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // Task-claim queueing (rate-limit-storm fix) — dispatchClaimedTask's
    // own release() deliberately LEAVES worktreePath/branchName as-is,
    // reversing the old claimTask's release() behavior this test used to
    // pin. They're the queue's own predicted path (stamped by enqueueTask,
    // still correct), needed by the NEXT dispatch attempt's own orphan-
    // clearing step — nulling them here would just make that next attempt
    // recompute the identical value.
    it("leaves worktreePath/branchName in place on release — they're the queue's own predicted path, not stale", async () => {
      const app = await buildApp();
      const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "task-claim-test-release-clear-"));
      const projectId = await createProject(app, notARepo);
      const task = insertReadyTask(app, projectId, 68);

      const outcome = await claimAndDispatch(app, task.id, { auto: false });

      expect(outcome).toMatchObject({ ok: false, reason: "worktree-failed" });
      const row = getTask(app, task.id);
      expect(row.status).toBe("claimed");
      expect(row.worktreePath).toBe(`${notARepo}/.mullion-worktrees/mullion-task-${task.id}`);
      expect(row.branchName).toBe(`mullion/task-${task.id}`);

      fs.rmSync(notARepo, { recursive: true, force: true });
      await app.close();
    });
  });

  it("no longer hard-rejects a remote-hosted project — claims proceed through the SessionBackend proxy (6.8/#283)", async () => {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "remote-claim-p", cwd: "/remote/project", hostId: "remote-host-1" })
      .returning()
      .all();
    const task = insertReadyTask(app, project.id, 66);

    const fakeBackend = {
      spawn: vi.fn().mockResolvedValue({ initialPromptApplied: true }),
      liveStatus: vi.fn().mockResolvedValue({}),
      isMasterAlive: vi.fn().mockResolvedValue({}),
      terminate: vi.fn().mockResolvedValue(undefined),
      getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
      resolveReviewGate: vi.fn().mockResolvedValue(false),
      createWorktree: vi.fn().mockResolvedValue({
        created: true,
        path: "/remote/project/.mullion-worktrees/mullion-task-x",
        branch: "x",
      }),
      checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
      resumeTaskWorktree: vi.fn().mockResolvedValue(null),
      listTaskWorktreeDirs: vi.fn().mockResolvedValue([]),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      resolvePendingPromote: vi.fn().mockResolvedValue(false),
      removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
      pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(fakeBackend);
    // #484 — claimTask's base-ref/SHA resolution goes through host-git.ts,
    // not SessionBackend; a real remote call would need a registered host
    // row, irrelevant to what this test actually exercises (the worktree/
    // spawn proxy path), so it's mocked directly the same way every other
    // dependency here is.
    vi.spyOn(hostGitModule, "resolveHostBaseRef").mockResolvedValue({
      ok: true,
      value: { baseRef: "HEAD", sha: null },
    });

    const outcome = await claimAndDispatch(app, task.id, { auto: false });

    expect(outcome.ok).toBe(true);
    // The orphan-clear step and worktree creation both ran through the
    // proxy — a remote-hosted claim reaches the same code path a local one
    // does, just against RemoteBackend instead of LocalBackend.
    expect(fakeBackend.clearOrphanedTaskWorktree).toHaveBeenCalled();
    expect(fakeBackend.createWorktree).toHaveBeenCalled();
    expect(fakeBackend.spawn).toHaveBeenCalled();

    await app.close();
  });

  it("#484 — resolves a real base ref/SHA for a remote-hosted claim via host-git.ts, not the literal HEAD fallback", async () => {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "remote-claim-baseref-p", cwd: "/remote/project", hostId: "remote-host-1" })
      .returning()
      .all();
    const task = insertReadyTask(app, project.id, 71);

    const fakeBackend = {
      spawn: vi.fn().mockResolvedValue({ initialPromptApplied: true }),
      liveStatus: vi.fn().mockResolvedValue({}),
      isMasterAlive: vi.fn().mockResolvedValue({}),
      terminate: vi.fn().mockResolvedValue(undefined),
      getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
      resolveReviewGate: vi.fn().mockResolvedValue(false),
      createWorktree: vi.fn().mockResolvedValue({
        created: true,
        path: "/remote/project/.mullion-worktrees/mullion-task-x",
        branch: "x",
      }),
      checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
      resumeTaskWorktree: vi.fn().mockResolvedValue(null),
      listTaskWorktreeDirs: vi.fn().mockResolvedValue([]),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      resolvePendingPromote: vi.fn().mockResolvedValue(false),
      removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
      pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(fakeBackend);
    vi.spyOn(hostGitModule, "resolveHostBaseRef").mockResolvedValue({
      ok: true,
      value: { baseRef: "origin/main", sha: "deadbeefcafe" },
    });

    const outcome = await claimAndDispatch(app, task.id, { auto: false });

    expect(outcome.ok).toBe(true);
    const row = getTask(app, task.id);
    // The pinned SHA, not the "HEAD" literal a pre-#484 remote claim used.
    expect(row.baseSha).toBe("deadbeefcafe");
    const branchName = `mullion/task-${task.id}`;
    expect(fakeBackend.createWorktree).toHaveBeenCalledWith(
      "/remote/project",
      "deadbeefcafe",
      branchName,
      branchName,
    );

    await app.close();
  });

  it("#484 — falls back to the literal HEAD/null a pre-#484 remote claim always used, when the host is unreachable", async () => {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({
        name: "remote-claim-unreachable-p",
        cwd: "/remote/project",
        hostId: "remote-host-1",
      })
      .returning()
      .all();
    const task = insertReadyTask(app, project.id, 72);

    const fakeBackend = {
      spawn: vi.fn().mockResolvedValue({ initialPromptApplied: true }),
      liveStatus: vi.fn().mockResolvedValue({}),
      isMasterAlive: vi.fn().mockResolvedValue({}),
      terminate: vi.fn().mockResolvedValue(undefined),
      getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
      resolveReviewGate: vi.fn().mockResolvedValue(false),
      createWorktree: vi.fn().mockResolvedValue({
        created: true,
        path: "/remote/project/.mullion-worktrees/mullion-task-x",
        branch: "x",
      }),
      checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
      resumeTaskWorktree: vi.fn().mockResolvedValue(null),
      listTaskWorktreeDirs: vi.fn().mockResolvedValue([]),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      resolvePendingPromote: vi.fn().mockResolvedValue(false),
      removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
      pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(fakeBackend);
    vi.spyOn(hostGitModule, "resolveHostBaseRef").mockResolvedValue({
      ok: false,
      reason: "unreachable",
      detail: "connection refused",
    });

    const outcome = await claimAndDispatch(app, task.id, { auto: false });

    expect(outcome.ok).toBe(true);
    const row = getTask(app, task.id);
    expect(row.baseSha).toBeNull();
    const branchName = `mullion/task-${task.id}`;
    expect(fakeBackend.createWorktree).toHaveBeenCalledWith(
      "/remote/project",
      "HEAD",
      branchName,
      branchName,
    );

    await app.close();
  });

  it("Hermes review, PR #538 — does not trust seedDelivered:true for a remote host that never confirms the prompt was applied (version skew)", async () => {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "remote-claim-skew-p", cwd: "/remote/project", hostId: "remote-host-1" })
      .returning()
      .all();
    const task = insertReadyTask(app, project.id, 67);

    const fakeBackend = {
      // Simulates an agent build too old to have `initialPromptApplied` in
      // its POST /internal/sessions response at all — RemoteHostClient.spawn
      // parses whatever JSON the agent actually returned, which for an old
      // build is just `{ ok: true }`.
      spawn: vi.fn().mockResolvedValue({}),
      liveStatus: vi.fn().mockResolvedValue({}),
      isMasterAlive: vi.fn().mockResolvedValue({}),
      terminate: vi.fn().mockResolvedValue(undefined),
      getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
      resolveReviewGate: vi.fn().mockResolvedValue(false),
      createWorktree: vi.fn().mockResolvedValue({
        created: true,
        path: "/remote/project/.mullion-worktrees/mullion-task-x",
        branch: "x",
      }),
      checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
      resumeTaskWorktree: vi.fn().mockResolvedValue(null),
      listTaskWorktreeDirs: vi.fn().mockResolvedValue([]),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      resolvePendingPromote: vi.fn().mockResolvedValue(false),
      removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
      pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(fakeBackend);
    vi.spyOn(hostGitModule, "resolveHostBaseRef").mockResolvedValue({
      ok: true,
      value: { baseRef: "HEAD", sha: null },
    });
    const warnSpy = vi.spyOn(app.log, "warn");

    const outcome = await claimAndDispatch(app, task.id, { auto: false });

    expect(outcome.ok).toBe(true);
    // command defaults to "claude" (seed-capable) — a naive
    // seedDelivered:seedCapable would have reported true here.
    if (outcome.ok) expect(outcome.seedDelivered).toBe(false);
    const row = getTask(app, task.id);
    expect(row.seedDelivered).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, hostId: "remote-host-1" }),
      expect.stringContaining("possible version skew"),
    );

    await app.close();
  });
});

describe("retryTask (#483)", () => {
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
      payload: { createDir: true, name: "retry-svc-p", cwd },
    });
    return res.json().id as number;
  }

  function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  /** Reconstructs the real →failed lifecycle shape: a worker claimed the
   * task, committed real work on `mullion/task-<id>`, then failed —
   * `removeWorktreeIfClean` (session-reconciler.ts/task-reconciler.ts's own
   * cleanup) already removed the worktree DIRECTORY while deliberately
   * leaving the branch (and its commit) intact. Neither failure path nulls
   * worktreePath/branchName on the row (see retryTask's own doc comment),
   * so this inserts the failed row with both still populated. */
  async function insertFailedTaskWithPreservedBranch(
    app: Awaited<ReturnType<typeof buildApp>>,
    projectId: number,
    cwd: string,
    issueNumber: number,
  ) {
    // Inserted first (as a throwaway "ready" row) purely to get a real task
    // id — branchName must match `mullion/task-<id>` exactly, the same
    // closed namespace resumeTaskWorktree/clearOrphanedTaskWorktree
    // enforce, so it can't be derived until the id exists.
    const [placeholder] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber, title: "t", status: "ready" })
      .returning()
      .all();
    const branchName = `mullion/task-${placeholder.id}`;

    const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
    if (!created) throw new Error("test setup: failed to create worktree");
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
        // The SHA a real claim would have pinned when this task's worktree
        // was originally created (#491) — asserted unchanged after retry.
        baseSha: "cafef00d",
      })
      .where(eq(tasks.id, placeholder.id))
      .returning()
      .all();
    return row;
  }

  it("404s cleanly for an unknown task id", async () => {
    const app = await buildApp();
    const outcome = await retryTask(app, 999999);
    expect(outcome).toEqual({ ok: false, reason: "not-found" });
    await app.close();
  });

  it("refuses (409-shaped) a task that isn't failed", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, title: "t", status: "ready" })
      .returning()
      .all();

    const outcome = await retryTask(app, task.id);

    expect(outcome).toMatchObject({ ok: false, reason: "not-failed" });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("refuses when the task has no recorded branch to resume", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, title: "t", status: "failed", branchName: null })
      .returning()
      .all();

    const outcome = await retryTask(app, task.id);

    expect(outcome).toMatchObject({ ok: false, reason: "no-worktree" });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("#484 — resumes a remote-hosted task's worktree through the SessionBackend proxy, no longer hard-refusing it", async () => {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "remote-retry-p", cwd: "/remote/project", hostId: "remote-host-1" })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "t",
        status: "failed",
        branchName: "mullion/task-9",
        worktreePath: "/remote/project/.mullion-worktrees/mullion-task-9",
      })
      .returning()
      .all();

    const fakeBackend = {
      spawn: vi.fn().mockResolvedValue({ initialPromptApplied: true }),
      liveStatus: vi.fn().mockResolvedValue({}),
      isMasterAlive: vi.fn().mockResolvedValue({}),
      terminate: vi.fn().mockResolvedValue(undefined),
      getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
      resolveReviewGate: vi.fn().mockResolvedValue(false),
      createWorktree: vi.fn().mockResolvedValue(null),
      checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
      resumeTaskWorktree: vi.fn().mockResolvedValue({
        path: "/remote/project/.mullion-worktrees/mullion-task-9",
        branch: "mullion/task-9",
      }),
      listTaskWorktreeDirs: vi.fn().mockResolvedValue([]),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      resolvePendingPromote: vi.fn().mockResolvedValue(false),
      removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
      pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(fakeBackend);

    const outcome = await retryTask(app, task.id);

    expect(outcome.ok).toBe(true);
    expect(fakeBackend.resumeTaskWorktree).toHaveBeenCalledWith(
      "/remote/project",
      "mullion/task-9",
    );
    expect(fakeBackend.spawn).toHaveBeenCalled();
    const row = getTask(app, task.id);
    // Task-claim queueing (rate-limit-storm fix) — retryTask's own
    // successful commit now lands directly on "in_progress", not "claimed"
    // (a successfully retried task already has a real, running session by
    // this point; leaving it at "claimed" would make it invisible to
    // MULLION_TASK_MAX_CONCURRENT, which only counts "in_progress").
    expect(row.status).toBe("in_progress");

    await app.close();
  });

  it("#484 — surfaces remote-not-supported (not a generic failure) when the host's agent build predates the resume proxy route", async () => {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "remote-retry-skew-p", cwd: "/remote/project", hostId: "remote-host-1" })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "t",
        status: "failed",
        branchName: "mullion/task-10",
        worktreePath: "/remote/project/.mullion-worktrees/mullion-task-10",
      })
      .returning()
      .all();

    const fakeBackend = {
      spawn: vi.fn().mockResolvedValue({ initialPromptApplied: true }),
      liveStatus: vi.fn().mockResolvedValue({}),
      isMasterAlive: vi.fn().mockResolvedValue({}),
      terminate: vi.fn().mockResolvedValue(undefined),
      getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
      resolveReviewGate: vi.fn().mockResolvedValue(false),
      createWorktree: vi.fn().mockResolvedValue(null),
      checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
      // Simulates an agent build old enough that
      // /internal/git-worktree/resume 404s.
      resumeTaskWorktree: vi.fn().mockRejectedValue(new HostRequestError("remote-host-1", 404, "")),
      listTaskWorktreeDirs: vi.fn().mockResolvedValue([]),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      resolvePendingPromote: vi.fn().mockResolvedValue(false),
      removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
      pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(fakeBackend);

    const outcome = await retryTask(app, task.id);

    expect(outcome).toMatchObject({ ok: false, reason: "remote-not-supported" });
    const row = getTask(app, task.id);
    expect(row.status).toBe("failed");

    await app.close();
  });

  it("resumes on the preserved branch, keeping its prior commit, and clears failureReason/completedAt/prUrl/sessionId", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 70);
    app.db
      .update(tasks)
      .set({ prUrl: "https://github.com/o/r/pull/1" })
      .where(eq(tasks.id, task.id))
      .run();

    const outcome = await retryTask(app, task.id);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    // A real checkout of the SAME branch, not a fresh one from baseRef —
    // the prior commit is right there.
    expect(fs.readFileSync(path.join(outcome.session.cwd ?? "", "work.txt"), "utf8")).toBe(
      "real committed work",
    );

    const row = getTask(app, task.id);
    // See the earlier remote-hosted retry test's comment — a successful
    // retry lands on "in_progress" now, not "claimed".
    expect(row.status).toBe("in_progress");
    expect(row.failureReason).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(row.prUrl).toBeNull();
    expect(row.sessionId).not.toBeNull();
    expect(row.branchName).toBe(task.branchName);
    // #491 — retry resumes the preserved branch from its original base, so
    // baseSha must survive unchanged, not be re-resolved or cleared.
    expect(row.baseSha).toBe("cafef00d");

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("releases back to failed (not ready) when the branch can no longer be resumed", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 71);
    // Delete the branch out of band — simulates it no longer existing by
    // the time retry runs.
    git(cwd, ["branch", "-D", task.branchName!]);

    const outcome = await retryTask(app, task.id);

    expect(outcome).toMatchObject({ ok: false, reason: "worktree-failed" });

    const row = getTask(app, task.id);
    expect(row.status).toBe("failed");
    expect(row.sessionId).toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  // #483 Hermes review — a resume that succeeds but is followed by a spawn
  // failure used to leave the just-checked-out worktree in place at the
  // deterministic path, occupying it permanently: the next retry's
  // resumeTaskWorktree/`git worktree add` would collide with it, undoing
  // the whole point of this feature.
  it("cleans up a just-resumed worktree when the spawn afterward fails, so a follow-up retry doesn't collide", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 74);

    vi.spyOn(sessionsModule, "createSessionRecord").mockResolvedValueOnce({
      ok: false,
      reason: "spawn-failed",
    });

    const first = await retryTask(app, task.id);
    expect(first).toMatchObject({ ok: false, reason: "spawn-failed" });

    const releasedRow = getTask(app, task.id);
    expect(releasedRow.status).toBe("failed");
    // The worktree directory left behind by the failed spawn is gone —
    // removeWorktreeIfClean ran during release(), not left occupying the
    // deterministic path.
    expect(fs.existsSync(releasedRow.worktreePath ?? "")).toBe(false);

    // The real proof: a second retry attempt succeeds, resuming on the
    // SAME preserved branch — resumeTaskWorktree's `git worktree add`
    // doesn't collide with anything left over from the first attempt.
    const second = await retryTask(app, task.id);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(fs.readFileSync(path.join(second.session.cwd ?? "", "work.txt"), "utf8")).toBe(
        "real committed work",
      );
    }

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("enforces the concurrency cap the same way claimTask does", async () => {
    const app = await buildApp();
    const original = app.config.MULLION_TASK_MAX_CONCURRENT;
    app.config.MULLION_TASK_MAX_CONCURRENT = 0;
    try {
      const cwd = createGitRepo();
      const projectId = await createProject(app, cwd);
      const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 72);

      const outcome = await retryTask(app, task.id);

      expect(outcome).toMatchObject({ ok: false, reason: "cap", limit: 0 });
      // `detail` is what routes/tasks.ts forwards as the 429's `message` —
      // pin it here too, at the source, not only through the HTTP layer.
      if (!outcome.ok) expect(outcome.detail).toContain("0");
      const row = getTask(app, task.id);
      expect(row.status).toBe("failed");

      fs.rmSync(cwd, { recursive: true, force: true });
    } finally {
      app.config.MULLION_TASK_MAX_CONCURRENT = original;
      await app.close();
    }
  });

  it("still retries with an unseedable agent, marking seedDelivered false — always human-initiated, no auto/manual split", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    // gemini, not opencode — opencode is seed-capable now (`--prompt`), see
    // hook-adapters/opencode.ts's initialPromptArgs.
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { defaultAgent: "gemini" },
    });
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 73);

    const outcome = await retryTask(app, task.id);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.seedDelivered).toBe(false);

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("delivers the task prompt as the agent's initial-prompt argv on resume, not via stashSeed", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 74);
    const stashSeedSpy = vi.spyOn(app.pty, "stashSeed");

    const outcome = await retryTask(app, task.id);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.seedDelivered).toBe(true);
    expect(stashSeedSpy).not.toHaveBeenCalled();

    const call = vi
      .mocked(childProcessSpawn)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    const spawnedArg = args[args.length - 1];
    // Title-only task (no body), so the prompt ends with the bare title.
    expect(spawnedArg).toContain("\n\nt'");
    expect(spawnedArg).toContain("as a Mullion Task Master worker");
    // Retry-specific: the branch already carries the earlier attempt.
    expect(spawnedArg).toContain("This is a retry");
    // retryTask has no `auto` parameter — it's only reachable from the
    // human Retry button, so the unattended bullet stays off.
    expect(spawnedArg).not.toContain("Nobody is watching this session");

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });
});
