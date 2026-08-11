import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const mockCreateSessionRecord = vi.fn();
const mockTerminate = vi.fn();
const mockResolveBackend = vi.fn(() => ({ terminate: mockTerminate }));

vi.mock("../../src/routes/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createSessionRecord: mockCreateSessionRecord };
});
vi.mock("../../src/services/session-backend.js", () => ({
  resolveBackend: mockResolveBackend,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { reseedTaskIfSessionExited } = await import("../../src/services/task-reseed.js");

const tmpDb = path.join(os.tmpdir(), `task-reseed-test-${process.pid}.db`);

describe("reseedTaskIfSessionExited", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "reseed-test", cwd: "/tmp" },
    });
    projectId = res.json().id;
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockTerminate.mockResolvedValue(undefined);
  });

  function insertSessionRow(status: "active" | "exited") {
    return app.db
      .insert(sessions)
      .values({ projectId, command: "claude", cwd: "/tmp", status })
      .returning()
      .all()[0];
  }

  function insertTaskWithSession(status: "active" | "exited") {
    const sessionRow = insertSessionRow(status);
    const taskRow = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "in_progress",
        sessionId: sessionRow.id,
        worktreePath: "/tmp/wt",
        agentCommand: "claude",
        claimedAt: new Date(),
      })
      .returning()
      .all()[0];
    return { task: taskRow, sessionId: sessionRow.id };
  }

  // A real (freshly-inserted) session row for createSessionRecord's mocked
  // "spawn succeeded" result to point at — tasks.sessionId is a real FK, so
  // a fabricated numeric id the DB has never seen would fail the write this
  // function does on success.
  function mockSuccessfulSpawn() {
    const newSession = insertSessionRow("active");
    mockCreateSessionRecord.mockResolvedValue({
      ok: true,
      row: newSession,
      project: { hostId: "local" },
      initialPromptApplied: true,
    });
    return newSession.id;
  }

  const project = { id: 1, hostId: "local" } as never;

  it("no-ops when the task has no sessionId/worktreePath/agentCommand", async () => {
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, title: "t", status: "backlog" })
      .returning()
      .all();

    const result = await reseedTaskIfSessionExited(app, row, project, "prompt", "test");

    expect(result).toBe(false);
    expect(mockCreateSessionRecord).not.toHaveBeenCalled();
    expect(mockTerminate).not.toHaveBeenCalled();
  });

  it("spawns a fresh session when the previous one has already exited", async () => {
    const { task } = insertTaskWithSession("exited");
    const newSessionId = mockSuccessfulSpawn();

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test reject",
    );

    expect(result).toBe(true);
    expect(mockTerminate).not.toHaveBeenCalled();
    expect(mockCreateSessionRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: "/tmp/wt", command: "claude", initialPrompt: "prompt text" }),
    );
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(newSessionId);
  });

  it("without force: does nothing at all when the previous session is still active", async () => {
    const { task } = insertTaskWithSession("active");

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test reject",
    );

    expect(result).toBe(false);
    expect(mockTerminate).not.toHaveBeenCalled();
    expect(mockCreateSessionRecord).not.toHaveBeenCalled();
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(task.sessionId);
  });

  it("with force: true — terminates the still-active session, then spawns fresh", async () => {
    const { task, sessionId } = insertTaskWithSession("active");
    const newSessionId = mockSuccessfulSpawn();

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test review-feedback",
      { force: true },
    );

    expect(result).toBe(true);
    expect(mockTerminate).toHaveBeenCalledWith(String(sessionId));
    expect(mockCreateSessionRecord).toHaveBeenCalledTimes(1);
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(newSessionId);
  });

  it("with force: true — does NOT spawn a second agent when terminate itself fails", async () => {
    mockTerminate.mockRejectedValue(new Error("host unreachable"));
    const { task } = insertTaskWithSession("active");
    const warnSpy = vi.spyOn(app.log, "warn");

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test review-feedback",
      { force: true },
    );

    expect(result).toBe(false);
    expect(mockCreateSessionRecord).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id }),
      expect.stringContaining("failed to terminate"),
    );
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(task.sessionId);
  });

  it("logs and does not update the task row when the spawn itself fails", async () => {
    mockCreateSessionRecord.mockResolvedValue({ ok: false, reason: "spawn-failed" });
    const { task } = insertTaskWithSession("exited");
    const warnSpy = vi.spyOn(app.log, "warn");

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test reject",
    );

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id }),
      expect.stringContaining("re-seed spawn failed"),
    );
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(task.sessionId);
  });

  // Hermes review, PR #580 — the final sessionId write had no status guard;
  // force:true's new caller (task-reconciler.ts's review-feedback
  // auto-return) makes the window between its own CAS (reviewing ->
  // in_progress) and this write reachable by a concurrent transition in a
  // way reject's own path never was.
  it("does not clobber sessionId, and returns false, when a concurrent transition moves the task off 'in_progress' before the final write", async () => {
    const { task } = insertTaskWithSession("exited");
    mockSuccessfulSpawn();
    // Simulates a concurrent approve/reject/give-up landing between
    // createSessionRecord resolving and this function's own final CAS'd
    // write — the row itself has already moved off "in_progress".
    app.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id)).run();

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test reject",
    );

    expect(result).toBe(false);
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(task.sessionId);
    expect(updated.status).toBe("done");
  });
});
