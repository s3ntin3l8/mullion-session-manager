import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mergeRecordedSet } from "../../src/services/task-merge-human.js";

// Direct tests for the DB access the task, task-push, review-relay and webhook
// routes used to run inline (issue #2817).
const tmpDb = path.join(os.tmpdir(), `task-store-test-${process.pid}.db`);
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { sessions } = await import("../../src/db/schema.js");
const store = await import("../../src/services/task-store.js");

describe("task-store", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;
  let otherProjectId: number;

  const mk = (over: Partial<Parameters<typeof store.insertTask>[1]> = {}) =>
    store.insertTask(app, { projectId, title: "t", ...over })!;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const mkProject = async (name: string) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-store-project-"));
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name, cwd },
      });
      return res.json().id as number;
    };
    projectId = await mkProject("task-store-a");
    otherProjectId = await mkProject("task-store-b");
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("reads projects, sessions and tasks by id", () => {
    const session = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", cwd: "/tmp", name: "s" } as never)
      .returning()
      .get();
    const task = mk();
    expect(store.getProjectById(app, projectId)?.name).toBe("task-store-a");
    expect(store.getProjectById(app, 999999)).toBeUndefined();
    expect(store.getSessionById(app, session.id)?.projectId).toBe(projectId);
    expect(store.getSessionById(app, 999999)).toBeUndefined();
    expect(store.getTaskById(app, task.id)?.id).toBe(task.id);
    expect(store.listProjects(app).map((p) => p.id)).toEqual(
      expect.arrayContaining([projectId, otherProjectId]),
    );
    const refs = store.listProjectRefsOldestFirst(app);
    expect(refs.findIndex((p) => p.id === projectId)).toBeLessThan(
      refs.findIndex((p) => p.id === otherProjectId),
    );
  });

  it("lists joined task rows, filtered and in board order", () => {
    const a = mk({ status: "ready", boardOrder: 2 });
    const b = mk({ status: "ready", boardOrder: 1 });
    mk({ projectId: otherProjectId, status: "ready" });
    const rows = store.listTaskRows(app, { status: "ready", projectId });
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(rows[0].projectName).toBe("task-store-a");
    expect(store.listTaskRows(app, {}).length).toBeGreaterThanOrEqual(3);
    expect(store.getTaskRowById(app, a.id)?.projectName).toBe("task-store-a");
    expect(store.getTaskRowById(app, 999999)).toBeUndefined();
  });

  it("updates, with and without a status compare-and-set, and deletes under a CAS", () => {
    const t = mk({ status: "reviewing" });
    expect(store.updateTask(app, t.id, { title: "x" }, { whenStatus: "done" })).toBeUndefined();
    expect(store.updateTask(app, t.id, { title: "x" }, { whenStatus: "reviewing" })?.title).toBe(
      "x",
    );
    expect(store.updateTask(app, t.id, { title: "y" })?.title).toBe("y");
    expect(store.updateTaskCount(app, t.id, { title: "z" })).toBe(1);
    expect(store.updateTaskCount(app, 999999, { title: "z" })).toBe(0);
    expect(store.deleteTaskWhenStatus(app, t.id, "done")).toBe(0);
    expect(store.deleteTaskWhenStatus(app, t.id, "reviewing")).toBe(1);
  });

  it("lists done and done-unmerged-with-PR tasks, optionally by project", () => {
    const merged = mk({ status: "done", prNumber: 5, mergedAt: new Date() });
    const open = mk({ status: "done", prNumber: 6 });
    const noPr = mk({ status: "done" });
    const other = mk({ projectId: otherProjectId, status: "done", prNumber: 7 });
    const done = store.listDoneTasks(app).map((t) => t.id);
    expect(done).toEqual(expect.arrayContaining([merged.id, open.id, noPr.id, other.id]));
    expect(store.listDoneTasks(app, [otherProjectId]).map((t) => t.id)).toContain(other.id);
    expect(store.listDoneTasks(app, [otherProjectId]).map((t) => t.id)).not.toContain(open.id);
    const unmerged = store.listDoneUnmergedWithPr(app).map((t) => t.id);
    expect(unmerged).toEqual(expect.arrayContaining([open.id, other.id]));
    expect(unmerged).not.toContain(merged.id);
    expect(unmerged).not.toContain(noPr.id);
    expect(store.listDoneUnmergedWithPr(app, [projectId]).map((t) => t.id)).not.toContain(other.id);
  });

  it("finds a session's pushable and active tasks", () => {
    const session = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", cwd: "/tmp", name: "w" } as never)
      .returning()
      .get();
    const t = mk({ status: "in_progress", sessionId: session.id, prNumber: 11 });
    expect(store.findPushableTaskBySession(app, session.id, ["in_progress"])?.id).toBe(t.id);
    expect(store.findPushableTaskBySession(app, session.id, ["done"])).toBeUndefined();
    store.updateTask(app, t.id, { mergedAt: new Date() });
    expect(store.findPushableTaskBySession(app, session.id, ["in_progress"])).toBeUndefined();
    store.updateTask(app, t.id, { mergedAt: null });
    expect(store.sessionHasActiveTask(app, session.id, ["in_progress"], undefined)).toBe(true);
    expect(store.sessionHasActiveTask(app, session.id, ["in_progress"], 11)).toBe(true);
    expect(store.sessionHasActiveTask(app, session.id, ["in_progress"], 12)).toBe(false);
    expect(store.sessionHasActiveTask(app, session.id, ["done"], undefined)).toBe(false);
  });

  it("matches tasks by PR, issue and records a merge once", () => {
    const t = mk({ status: "reviewing", prNumber: 21, issueNumber: 77, dependencyCount: 2 });
    expect(store.findUnmergedTaskByPr(app, projectId, 21)?.id).toBe(t.id);
    expect(store.findReviewingTaskByPr(app, projectId, 21)?.id).toBe(t.id);
    expect(store.findReviewingTaskByPr(app, otherProjectId, 21)).toBeUndefined();
    expect(store.findTaskByIssue(app, projectId, 77)?.id).toBe(t.id);
    expect(store.findTaskBlockerStateByIssue(app, projectId, 77)).toEqual({
      id: t.id,
      dependencyCount: 2,
    });
    expect(store.findTaskBlockerStateByIssue(app, projectId, 78)).toBeUndefined();
    expect(store.recordMergeIfUnmerged(app, t.id, mergeRecordedSet(new Date()))).toBe(1);
    expect(store.recordMergeIfUnmerged(app, t.id, mergeRecordedSet(new Date()))).toBe(0);
    expect(store.findUnmergedTaskByPr(app, projectId, 21)).toBeUndefined();
  });

  it("re-arms a stale review only while its handle and verdict still match", () => {
    const t = mk({
      status: "reviewing",
      lastReviewVerdict: "inconclusive",
      reviewRunId: "run-1",
      reviewRunIngestedId: "run-1",
    });
    const stale = {
      lastReviewVerdict: "inconclusive",
      reviewSessionId: null,
      reviewRunId: "run-1",
      reviewIsRun: true,
    };
    expect(
      store.rearmStaleReview(app, t.id, { reviewRunId: null }, { ...stale, reviewRunId: "run-2" }),
    ).toBeUndefined();
    expect(
      store.rearmStaleReview(app, t.id, { reviewRunId: null }, { ...stale, reviewIsRun: false }),
    ).toBeUndefined();
    expect(store.rearmStaleReview(app, t.id, { reviewRunId: null }, stale)?.reviewRunId).toBeNull();
  });
});
