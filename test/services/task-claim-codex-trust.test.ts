import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import type { CodexHookTrust } from "../../src/services/hook-adapters/codex-trust.js";

// No real systemd/pty, real git.
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

const mockGetCodexHookTrust = vi.fn<() => CodexHookTrust>(() => "trusted");
vi.mock("../../src/services/hook-adapters/codex-trust.js", () => ({
  getCodexHookTrust: mockGetCodexHookTrust,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { CODEX_TRUST_HOLD_DETAIL, enqueueTask, dispatchClaimedTask, dispatchQueuedRetry } =
  await import("../../src/services/task-claim.js");
const { enqueueRetry } = await import("../../src/services/task-retry.js");
const { dispatchQueuedTasks } = await import("../../src/services/task-dispatch.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { createTaskGitRepo, createTaskProject, insertFailedTaskWithPreservedBranch } =
  await import("../helpers/task-retry-fixture.js");

const tmpDb = path.join(os.tmpdir(), `task-claim-codex-trust-${process.pid}.db`);

describe("codex /hooks trust gate at task dispatch", () => {
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
  beforeEach(() => {
    mockGetCodexHookTrust.mockReset();
    mockGetCodexHookTrust.mockReturnValue("trusted");
  });

  async function setup(defaultAgent = "codex") {
    const app = await buildApp();
    const cwd = createTaskGitRepo("task-claim-codex-trust-repo-");
    const projectId = await createTaskProject(app, cwd, `codex-trust-${Date.now()}`);
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { defaultAgent },
    });
    return { app, cwd, projectId };
  }

  it("holds a local codex claim while trust is pending, then dispatches and clears reason once trusted", async () => {
    const { app, cwd, projectId } = await setup("codex");
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 101,
        title: "codex pending",
        body: "details",
        status: "ready",
      })
      .returning()
      .all();

    expect((await enqueueTask(app, task.id, { auto: false })).ok).toBe(true);

    mockGetCodexHookTrust.mockReturnValue("pending");
    const held = await dispatchClaimedTask(app, task.id);
    expect(held).toEqual({
      ok: false,
      reason: "codex-trust-held",
      detail: CODEX_TRUST_HOLD_DETAIL,
    });

    const [heldRow] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(heldRow.status).toBe("claimed");
    expect(heldRow.sessionId).toBeNull();
    expect(heldRow.failureReason).toBe(CODEX_TRUST_HOLD_DETAIL);
    expect(heldRow.dispatchHeld).toBe(false);

    // Subsequent tick while still pending keeps the hold without failing or spawning.
    const heldAgain = await dispatchClaimedTask(app, task.id);
    expect(heldAgain).toMatchObject({ ok: false, reason: "codex-trust-held" });

    // Once trusted, dispatch succeeds and clears the hold reason.
    mockGetCodexHookTrust.mockReturnValue("trusted");
    const dispatched = await dispatchClaimedTask(app, task.id);
    expect(dispatched.ok).toBe(true);

    const [startedRow] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(startedRow.status).toBe("in_progress");
    expect(startedRow.sessionId).not.toBeNull();
    expect(startedRow.failureReason).toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("dispatches a non-codex agent even when codex trust is pending", async () => {
    const { app, cwd, projectId } = await setup("claude");
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 102,
        title: "claude task",
        body: "details",
        status: "ready",
      })
      .returning()
      .all();

    expect((await enqueueTask(app, task.id, { auto: false })).ok).toBe(true);
    mockGetCodexHookTrust.mockReturnValue("pending");

    const dispatched = await dispatchClaimedTask(app, task.id);
    expect(dispatched.ok).toBe(true);
    expect(mockGetCodexHookTrust).not.toHaveBeenCalled();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("dispatches when codex hook trust is not-installed", async () => {
    const { app, cwd, projectId } = await setup("codex");
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 103,
        title: "not installed",
        body: "details",
        status: "ready",
      })
      .returning()
      .all();

    expect((await enqueueTask(app, task.id, { auto: false })).ok).toBe(true);
    mockGetCodexHookTrust.mockReturnValue("not-installed");

    const dispatched = await dispatchClaimedTask(app, task.id);
    expect(dispatched.ok).toBe(true);

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("fails open and dispatches when getCodexHookTrust throws", async () => {
    const { app, cwd, projectId } = await setup("codex");
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 104,
        title: "throwing trust",
        body: "details",
        status: "ready",
      })
      .returning()
      .all();

    expect((await enqueueTask(app, task.id, { auto: false })).ok).toBe(true);
    mockGetCodexHookTrust.mockImplementation(() => {
      throw new Error("corrupt config.toml");
    });

    const dispatched = await dispatchClaimedTask(app, task.id);
    expect(dispatched.ok).toBe(true);

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("holds a queued retry while codex trust is pending, then dispatches once trusted", async () => {
    const { app, cwd, projectId } = await setup("codex");
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 105);

    expect((await enqueueRetry(app, task.id)).ok).toBe(true);

    mockGetCodexHookTrust.mockReturnValue("pending");
    const held = await dispatchQueuedRetry(app, task.id);
    expect(held).toEqual({
      ok: false,
      reason: "codex-trust-held",
      detail: CODEX_TRUST_HOLD_DETAIL,
    });

    const [heldRow] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(heldRow.status).toBe("claimed");
    expect(heldRow.resumeQueued).toBe(true);
    expect(heldRow.failureReason).toBe(CODEX_TRUST_HOLD_DETAIL);

    mockGetCodexHookTrust.mockReturnValue("trusted");
    const dispatched = await dispatchQueuedRetry(app, task.id);
    expect(dispatched.ok).toBe(true);

    const [startedRow] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(startedRow.status).toBe("in_progress");
    expect(startedRow.failureReason).toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("dispatchQueuedTasks continues past a codex-trust-held task so later tasks still dispatch", async () => {
    const { app, cwd, projectId } = await setup("codex");
    const [codexTask] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 106,
        title: "codex first",
        body: "details",
        status: "ready",
      })
      .returning()
      .all();
    const [claudeTask] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 107,
        title: "claude second",
        body: "Agent: claude\n\ndetails",
        status: "ready",
      })
      .returning()
      .all();

    expect((await enqueueTask(app, codexTask.id, { auto: false })).ok).toBe(true);
    expect((await enqueueTask(app, claudeTask.id, { auto: false })).ok).toBe(true);

    mockGetCodexHookTrust.mockReturnValue("pending");
    await dispatchQueuedTasks(app);

    const [codexRow] = app.db.select().from(tasks).where(eq(tasks.id, codexTask.id)).all();
    const [claudeRow] = app.db.select().from(tasks).where(eq(tasks.id, claudeTask.id)).all();
    expect(codexRow.status).toBe("claimed");
    expect(codexRow.failureReason).toBe(CODEX_TRUST_HOLD_DETAIL);
    expect(claudeRow.status).toBe("in_progress");

    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("clears the hold reason once trust becomes trusted even if dispatch then hits cap", async () => {
    const { app, cwd, projectId } = await setup("codex");
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 108,
        title: "cap after trust",
        body: "details",
        status: "ready",
      })
      .returning()
      .all();

    expect((await enqueueTask(app, task.id, { auto: false })).ok).toBe(true);
    mockGetCodexHookTrust.mockReturnValue("pending");
    expect((await dispatchClaimedTask(app, task.id)).ok).toBe(false);

    // Fill the concurrency cap (1) with another in_progress task so the next
    // dispatch clears the trust hold and then hits "cap" before spawning.
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { taskMaster: { maxConcurrent: 1 } },
    });
    const [other] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 110,
        title: "running",
        body: "details",
        status: "in_progress",
      })
      .returning()
      .all();

    try {
      mockGetCodexHookTrust.mockReturnValue("trusted");
      const capped = await dispatchClaimedTask(app, task.id);
      expect(capped).toMatchObject({ ok: false, reason: "cap" });
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.failureReason).toBeNull();
    } finally {
      app.db.delete(tasks).where(eq(tasks.id, other.id)).run();
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    }
  });

  it("does not gate remote placements even when local codex hook trust is pending", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "remote-codex-host", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const remoteHostId = res.json().id as string;
    app.hostHeartbeatTracker?.recordSuccess(remoteHostId);
    app.hostCapacityTracker?.record(remoteHostId, {
      platform: "linux",
      logicalCores: 4,
      loadAverage1m: 0,
      memory: { totalBytes: 1000, freeBytes: 500 },
      sessions: { tracked: 0, alive: 0 },
    });
    const [project] = app.db
      .insert(projects)
      .values({
        name: `remote-codex-${Date.now()}`,
        cwd: "/srv/remote-proj",
        hostId: remoteHostId,
        placement: "pinned",
        defaultAgent: "codex",
      })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        issueNumber: 109,
        title: "remote codex",
        body: "details",
        status: "ready",
      })
      .returning()
      .all();

    expect((await enqueueTask(app, task.id, { auto: false })).ok).toBe(true);
    mockGetCodexHookTrust.mockReturnValue("pending");
    try {
      const outcome = await dispatchClaimedTask(app, task.id);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).not.toBe("codex-trust-held");
      expect(mockGetCodexHookTrust).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
