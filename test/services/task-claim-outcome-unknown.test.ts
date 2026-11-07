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

// #2621 — a spawn whose outcome is unknown (the channel closed after the
// request was sent) must be surfaced to the task, not collapsed into a plain
// "spawn failed" that reads as "nothing happened". Same fakes as
// task-claim-retry-reused.test.ts: no real systemd/pty, real git.
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
const { enqueueTask, dispatchClaimedTask, retryTask } =
  await import("../../src/services/task-claim.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { createWorktree } = await import("../../src/services/git-worktree.js");
const sessionsModule = await import("../../src/services/session-lifecycle.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { HostOutcomeUnknownError } = await import("../../src/services/remote-host-errors.js");

const tmpDb = path.join(os.tmpdir(), `task-claim-outcome-unknown-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

async function setup() {
  const app = await buildApp();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-claim-outcome-unknown-repo-"));
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name: "outcome-unknown-p", cwd },
  });
  const projectId = res.json().id as number;
  const [row] = app.db
    .insert(tasks)
    .values({ projectId, issueNumber: 2621, title: "t", status: "ready" })
    .returning()
    .all();
  const rowNow = () => app.db.select().from(tasks).where(eq(tasks.id, row.id)).get()!;
  return { app, cwd, row, rowNow };
}

describe("an unknown spawn outcome is surfaced to the task (#2621)", () => {
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

  it("dispatch releases the claim and records the outcome as unknown", async () => {
    const { app, cwd, row, rowNow } = await setup();
    vi.spyOn(sessionsModule, "createSessionRecord").mockResolvedValue({
      ok: false,
      reason: "outcome-unknown",
      detail: "channel closed",
    });

    await enqueueTask(app, row.id, { auto: false });
    const outcome = await dispatchClaimedTask(app, row.id);

    expect(outcome).toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(rowNow().failureReason).toMatch(/outcome unknown.*channel closed/);

    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("dispatch surfaces an unknown outcome from clearing the orphaned worktree (#2703)", async () => {
    const { app, cwd, row, rowNow } = await setup();
    const real = sessionBackendModule.resolveBackend;
    vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation((a, hostId) => {
      const backend = Object.create(real(a, hostId)) as ReturnType<typeof real>;
      backend.clearOrphanedTaskWorktree = () =>
        Promise.reject(
          new sessionBackendModule.MutationOutcomeUnknownError(
            hostId,
            "clearOrphanedTaskWorktree",
            new HostOutcomeUnknownError(hostId, new Error("closed")),
          ),
        );
      return backend;
    });

    await enqueueTask(app, row.id, { auto: false });
    const outcome = await dispatchClaimedTask(app, row.id);

    expect(outcome).toMatchObject({ ok: false, reason: "worktree-failed" });
    expect((outcome as { detail: string }).detail).toContain("MAY HAVE BEEN DELIVERED");
    expect(rowNow().failureReason).toContain("MAY HAVE BEEN DELIVERED");

    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("dispatch names the unknown outcome even without a detail", async () => {
    const { app, cwd, row, rowNow } = await setup();
    vi.spyOn(sessionsModule, "createSessionRecord").mockResolvedValue({
      ok: false,
      reason: "outcome-unknown",
    });

    await enqueueTask(app, row.id, { auto: false });
    await dispatchClaimedTask(app, row.id);

    expect(rowNow().failureReason).toContain("outcome unknown");

    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("retry reports the unknown outcome instead of a generic spawn failure", async () => {
    const { app, cwd, row } = await setup();
    const branchName = deriveTaskBranchName(row);
    const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
    app.db
      .update(tasks)
      .set({ status: "failed", worktreePath: created.path as string, branchName })
      .where(eq(tasks.id, row.id))
      .run();
    vi.spyOn(sessionsModule, "createSessionRecord").mockResolvedValue({
      ok: false,
      reason: "outcome-unknown",
      detail: "channel closed",
    });

    const outcome = await retryTask(app, row.id);

    expect(outcome).toMatchObject({ ok: false, reason: "spawn-failed", detail: "channel closed" });

    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("dispatch adopts the kept session instead of releasing the task", async () => {
    const { app, cwd, row, rowNow } = await setup();
    const sessionId = Number(
      app.db
        .insert(sessions)
        .values({ projectId: row.projectId, command: "bash", cwd: "/tmp/kept" })
        .run().lastInsertRowid,
    );
    vi.spyOn(sessionsModule, "createSessionRecord").mockResolvedValue({
      ok: false,
      reason: "outcome-unknown",
      detail: "channel closed",
      sessionId,
    });

    await enqueueTask(app, row.id, { auto: false });
    const outcome = await dispatchClaimedTask(app, row.id);

    expect(outcome).toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(rowNow()).toMatchObject({
      status: "in_progress",
      sessionId,
      worktreePath: "/tmp/kept",
    });

    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("retry adopts the kept session instead of releasing the task", async () => {
    const { app, cwd, row, rowNow } = await setup();
    const branchName = deriveTaskBranchName(row);
    const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
    app.db
      .update(tasks)
      .set({ status: "failed", worktreePath: created.path as string, branchName })
      .where(eq(tasks.id, row.id))
      .run();
    const sessionId = Number(
      app.db
        .insert(sessions)
        .values({ projectId: row.projectId, command: "bash", cwd: created.path as string })
        .run().lastInsertRowid,
    );
    vi.spyOn(sessionsModule, "createSessionRecord").mockResolvedValue({
      ok: false,
      reason: "outcome-unknown",
      detail: "channel closed",
      sessionId,
    });

    await retryTask(app, row.id);

    expect(rowNow()).toMatchObject({ status: "in_progress", sessionId });

    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });
  it("dispatch reaps the kept session when the task moved on during the spawn", async () => {
    const { app, cwd, row, rowNow } = await setup();
    const sessionId = Number(
      app.db
        .insert(sessions)
        .values({ projectId: row.projectId, command: "bash", cwd: "/tmp/kept" })
        .run().lastInsertRowid,
    );
    vi.spyOn(sessionsModule, "createSessionRecord").mockImplementation(async () => {
      app.db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, row.id)).run();
      return { ok: false, reason: "outcome-unknown", detail: "channel closed", sessionId };
    });
    const kill = vi.spyOn(sessionsModule, "killSession").mockResolvedValue(undefined as never);

    await enqueueTask(app, row.id, { auto: false });
    await dispatchClaimedTask(app, row.id);

    expect(rowNow().status).toBe("failed");
    expect(rowNow().sessionId).not.toBe(sessionId);
    expect(kill).toHaveBeenCalledWith(app, sessionId);

    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("retry reaps the kept session when the task moved on during the spawn", async () => {
    const { app, cwd, row, rowNow } = await setup();
    const branchName = deriveTaskBranchName(row);
    const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
    app.db
      .update(tasks)
      .set({ status: "failed", worktreePath: created.path as string, branchName })
      .where(eq(tasks.id, row.id))
      .run();
    const sessionId = Number(
      app.db
        .insert(sessions)
        .values({ projectId: row.projectId, command: "bash", cwd: created.path as string })
        .run().lastInsertRowid,
    );
    vi.spyOn(sessionsModule, "createSessionRecord").mockImplementation(async () => {
      app.db.update(tasks).set({ status: "ready" }).where(eq(tasks.id, row.id)).run();
      return { ok: false, reason: "outcome-unknown", detail: "channel closed", sessionId };
    });
    const kill = vi.spyOn(sessionsModule, "killSession").mockResolvedValue(undefined as never);

    const outcome = await retryTask(app, row.id);

    expect(outcome).toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(rowNow().status).toBe("ready");
    expect(rowNow().sessionId).not.toBe(sessionId);
    expect(kill).toHaveBeenCalledWith(app, sessionId);

    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });
});
