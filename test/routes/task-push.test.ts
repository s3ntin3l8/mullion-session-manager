import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type * as TaskPromote from "../../src/services/task-promote.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The gated push itself (preparePromotion/pushForPromotion) is covered in
// task-promote.test.ts; this file covers what the route adds: who may call it
// and how each outcome is handed back to the agent.
const mockOpenDraftPRForTask = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/task-promote.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TaskPromote>();
  return { ...actual, openDraftPRForTask: mockOpenDraftPRForTask };
});

const tmpDb = path.join(os.tmpdir(), `task-push-route-test-${process.pid}.db`);
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { sessions, tasks } = await import("../../src/db/schema.js");

describe("POST /api/sessions/:id/task-push (#2102)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-push-route-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "task-push-project", cwd },
    });
    projectId = res.json().id;
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  beforeEach(() => mockOpenDraftPRForTask.mockReset());

  const newSession = () =>
    app.db
      .insert(sessions)
      .values({ projectId, command: "bash", cwd: "/tmp", name: "s" } as never)
      .returning()
      .get().id;
  const newTask = (over: Partial<typeof tasks.$inferInsert>) =>
    app.db
      .insert(tasks)
      .values({ projectId, title: "t", status: "in_progress", prNumber: 9, ...over })
      .returning()
      .get();
  const push = (sessionId: number) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/task-push` });

  it("pushes the worker session's task through the gated path and returns the PR", async () => {
    const sessionId = newSession();
    const task = newTask({ sessionId });
    mockOpenDraftPRForTask.mockResolvedValue({
      ok: true,
      prUrl: "https://github.com/o/r/pull/9",
      prNumber: 9,
    });

    const res = await push(sessionId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, prUrl: "https://github.com/o/r/pull/9", prNumber: 9 });
    expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
    expect(mockOpenDraftPRForTask.mock.calls[0][1]).toMatchObject({ id: task.id });
  });

  it("allows the auto-rebase worker's session on a done or reviewing task", async () => {
    for (const status of ["done", "reviewing"] as const) {
      const sessionId = newSession();
      newTask({ sessionId, status });
      mockOpenDraftPRForTask.mockResolvedValue({ ok: true, prUrl: "u", prNumber: 9 });
      expect((await push(sessionId)).statusCode).toBe(200);
    }
  });

  it("hands a failure back with the reason, the detail and what to do next", async () => {
    const sessionId = newSession();
    newTask({ sessionId });
    mockOpenDraftPRForTask.mockResolvedValue({
      ok: false,
      reason: "push-failed",
      detail: "! [rejected] (stale info)",
    });

    const res = await push(sessionId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      ok: false,
      reason: "push-failed",
      detail: "! [rejected] (stale info)",
      guidance: expect.stringContaining("fetch, rebase"),
      // What the agent actually reads: the detail and the next step together.
      message: expect.stringMatching(/stale info\).*fetch, rebase/),
    });
  });

  it("tells the agent a held workflow change and a credentials problem are the operator's to fix", async () => {
    const sessionId = newSession();
    newTask({ sessionId });
    for (const [reason, needle] of [
      ["workflow-approval-required", "Only the operator can approve"],
      ["push-forbidden", "Only the operator can fix"],
    ] as const) {
      mockOpenDraftPRForTask.mockResolvedValue({ ok: false, reason, detail: "d" });
      const body = (await push(sessionId)).json();
      expect(body.reason).toBe(reason);
      expect(body.guidance).toContain(needle);
      expect(body.guidance).toContain("End your turn");
    }
  });

  it("tells the agent a permission-denied push failure is the operator's, and a lost worktree too", async () => {
    const sessionId = newSession();
    newTask({ sessionId });
    mockOpenDraftPRForTask.mockResolvedValue({
      ok: false,
      reason: "push-failed",
      detail: "Permission to o/r.git denied to the-bot",
    });
    expect((await push(sessionId)).json().guidance).toContain("permission denied or 403");
    mockOpenDraftPRForTask.mockResolvedValue({ ok: false, reason: "no-worktree" });
    expect((await push(sessionId)).json().guidance).toContain("cannot find this task's worktree");
  });

  it("falls back to generic guidance for an unlisted reason", async () => {
    const sessionId = newSession();
    newTask({ sessionId });
    mockOpenDraftPRForTask.mockResolvedValue({ ok: false, reason: "pr-create-failed" });
    expect((await push(sessionId)).json().guidance).toContain("End your turn");
  });

  it("refuses a session that is not a task's worker (a reviewer, or an ad-hoc session)", async () => {
    const reviewerId = newSession();
    newTask({ reviewSessionId: reviewerId, sessionId: newSession() });
    expect((await push(reviewerId)).statusCode).toBe(404);
    expect((await push(newSession())).statusCode).toBe(404);
    expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
  });

  it("refuses a task whose PR already merged, even with its worker session still around", async () => {
    const sessionId = newSession();
    newTask({ sessionId, status: "done", mergedAt: new Date() });
    expect((await push(sessionId)).statusCode).toBe(404);
    expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
  });

  it("refuses a task that already ended", async () => {
    const sessionId = newSession();
    newTask({ sessionId, status: "failed" });
    expect((await push(sessionId)).statusCode).toBe(404);
  });

  it("refuses when the task has no PR yet: Mullion opens the first draft itself", async () => {
    const sessionId = newSession();
    newTask({ sessionId, prNumber: null });
    const res = await push(sessionId);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("no pull request yet");
    expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric session id", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/sessions/abc/task-push" })).statusCode,
    ).toBe(400);
  });

  it("is forbidden while Task Master is disabled", async () => {
    const sessionId = newSession();
    newTask({ sessionId });
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { taskMaster: { enabled: "off" } },
    });
    try {
      expect((await push(sessionId)).statusCode).toBe(403);
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { enabled: "inherit" } },
      });
    }
  });
});
