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

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { claimTask } = await import("../../src/services/task-claim.js");
const { tasks } = await import("../../src/db/schema.js");
const sessionsModule = await import("../../src/routes/sessions.js");

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
});
