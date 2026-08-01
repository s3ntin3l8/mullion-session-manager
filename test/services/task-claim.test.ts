import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
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
const { claimTask } = await import("../../src/services/task-claim.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const sessionsModule = await import("../../src/routes/sessions.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");

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
      payload: { name: "claim-svc-p", cwd },
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

  function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  it("refuses an auto-claim outright when the resolved agent has no seed-delivery channel — no spawn, no reservation left behind", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    // opencode's hook adapter doesn't declare session_start — see
    // task-agent-resolve.test.ts's commandSupportsSeed coverage.
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { defaultAgent: "opencode" },
    });
    const task = insertReadyTask(app, projectId, 60);

    const outcome = await claimTask(app, task.id, { auto: true });

    expect(outcome).toMatchObject({ ok: false, reason: "no-seed-channel" });
    if (!outcome.ok) expect(outcome.detail).toContain("opencode");

    // The reservation must not be left behind — a refused auto-claim
    // leaves the task exactly as claimable as before the attempt.
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
      payload: { defaultAgent: "opencode" },
    });
    const task = insertReadyTask(app, projectId, 61);

    const outcome = await claimTask(app, task.id, { auto: false });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.seedDelivered).toBe(false);

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("syncs the claimed transition to GitHub with the just-committed session fields, not stale pre-claim values", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = insertReadyTask(app, projectId, 62);

    const outcome = await claimTask(app, task.id, { auto: false });
    expect(outcome.ok).toBe(true);

    expect(mockSyncTaskTransition).toHaveBeenCalledTimes(1);
    const [, syncedTask, syncedProject, syncedEvent] = mockSyncTaskTransition.mock.calls[0];
    expect(syncedEvent).toBe("claimed");
    expect(syncedTask).toMatchObject({
      id: task.id,
      issueNumber: 62,
      status: "claimed",
      branchName: `mullion/task-${task.id}`,
    });
    // sessionId/worktreePath came from the just-created session record, not
    // the pre-claim task snapshot (which had neither set) — verifies
    // task-claim.ts's hand-merged object actually carries the committed
    // values forward rather than the stale ones from before the claim.
    expect(syncedTask.sessionId).not.toBeNull();
    expect(syncedTask.worktreePath).not.toBeNull();
    expect(syncedProject).toMatchObject({ id: projectId });

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("releases the reservation back to ready when worktree creation fails, recording a failureReason", async () => {
    const app = await buildApp();
    // Not a git repo at all — resolveDefaultBaseRef/createWorktree fail
    // deterministically without needing to fake git itself.
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "task-claim-test-not-a-repo-"));
    const projectId = await createProject(app, notARepo);
    const task = insertReadyTask(app, projectId, 62);

    const outcome = await claimTask(app, task.id, { auto: false });

    expect(outcome).toMatchObject({ ok: false, reason: "worktree-failed" });

    // Released, not stranded — retryable, and the concurrency slot isn't
    // silently leaked forever.
    const row = getTask(app, task.id);
    expect(row.status).toBe("ready");
    expect(row.sessionId).toBeNull();
    expect(row.failureReason).toBe("worktree creation failed");

    fs.rmSync(notARepo, { recursive: true, force: true });
    await app.close();
  });

  it("404s cleanly for an unknown task id", async () => {
    const app = await buildApp();
    const outcome = await claimTask(app, 999999, { auto: false });
    expect(outcome).toEqual({ ok: false, reason: "not-found" });
    await app.close();
  });

  it("releases the reservation when something throws mid-spawn (not just a documented {ok:false} failure)", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const task = insertReadyTask(app, projectId, 63);

    vi.spyOn(sessionsModule, "createSessionRecord").mockRejectedValueOnce(
      new Error("boom: unexpected spawn error"),
    );

    const outcome = await claimTask(app, task.id, { auto: false });

    expect(outcome).toMatchObject({ ok: false, reason: "spawn-failed" });
    if (!outcome.ok) expect(outcome.detail).toContain("boom");

    // Released, not stranded — same contract as the documented
    // {ok:false} failure paths above, now also covering a thrown error.
    const row = getTask(app, task.id);
    expect(row.status).toBe("ready");
    expect(row.sessionId).toBeNull();
    expect(row.failureReason).toContain("boom");

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

      const outcome = await claimTask(app, task.id, { auto: false });

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

      const outcome = await claimTask(app, task.id, { auto: false });

      expect(outcome).toMatchObject({ ok: false, reason: "worktree-failed" });
      if (!outcome.ok) expect(outcome.detail).toContain("dirty");

      // Released, retryable — same contract as every other pre-commit
      // failure path.
      const row = getTask(app, task.id);
      expect(row.status).toBe("ready");
      expect(row.sessionId).toBeNull();
      // The dirty leftover is never destroyed — a human needs to resolve it.
      expect(fs.existsSync(leftover!.path)).toBe(true);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("stamps worktreePath/branchName into the row at reservation time, before the worktree exists on disk (independent review, PR #476)", async () => {
      // Closes a race with plugins/task-watcher.ts's boot-time orphan sweep:
      // that sweep treats any on-disk task-worktree directory not
      // referenced by a non-terminal task's worktreePath as an orphan. If
      // the DB write lagged the on-disk creation (the old ordering), a
      // human claiming a task moments after a restart could race the
      // fire-and-forget sweep into deleting the worktree this very claim
      // just created. Verified here by inspecting the row from inside a
      // spy on createSessionRecord — i.e. BEFORE the worktree is actually
      // created — and confirming the DB already reflects the claim.
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

      const outcome = await claimTask(app, task.id, { auto: false });

      expect(outcome.ok).toBe(true);
      expect(sawDuringSpawn?.status).toBe("claimed");
      expect(sawDuringSpawn?.worktreePath).toBe(
        `${cwd}/.mullion-worktrees/mullion-task-${task.id}`,
      );
      expect(sawDuringSpawn?.branchName).toBe(`mullion/task-${task.id}`);

      spy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("clears worktreePath/branchName back to null on release, so a released task never carries a stale path", async () => {
      const app = await buildApp();
      const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "task-claim-test-release-clear-"));
      const projectId = await createProject(app, notARepo);
      const task = insertReadyTask(app, projectId, 68);

      const outcome = await claimTask(app, task.id, { auto: false });

      expect(outcome).toMatchObject({ ok: false, reason: "worktree-failed" });
      const row = getTask(app, task.id);
      expect(row.status).toBe("ready");
      expect(row.worktreePath).toBeNull();
      expect(row.branchName).toBeNull();

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
      spawn: vi.fn().mockResolvedValue(undefined),
      liveStatus: vi.fn().mockResolvedValue({}),
      isMasterAlive: vi.fn().mockResolvedValue({}),
      terminate: vi.fn().mockResolvedValue(undefined),
      getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
      resolveReviewGate: vi.fn().mockResolvedValue(false),
      createWorktree: vi.fn().mockResolvedValue({
        path: "/remote/project/.mullion-worktrees/mullion-task-x",
        branch: "x",
      }),
      checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      resolvePendingPromote: vi.fn().mockResolvedValue(false),
      removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
      pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(fakeBackend);

    const outcome = await claimTask(app, task.id, { auto: false });

    expect(outcome.ok).toBe(true);
    // The orphan-clear step and worktree creation both ran through the
    // proxy — a remote-hosted claim reaches the same code path a local one
    // does, just against RemoteBackend instead of LocalBackend.
    expect(fakeBackend.clearOrphanedTaskWorktree).toHaveBeenCalled();
    expect(fakeBackend.createWorktree).toHaveBeenCalled();
    expect(fakeBackend.spawn).toHaveBeenCalled();

    await app.close();
  });
});
