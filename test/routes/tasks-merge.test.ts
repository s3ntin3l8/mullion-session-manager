import { describe, it, expect, vi } from "vitest";
import {
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  setupTasksRouteTestLifecycle,
} from "../helpers/tasks-routes-harness.js";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", () => mockTaskPromoteFactory());

const { buildApp } = await import("../../src/app.js");

describe("POST /api/tasks/:id/merge", () => {
  setupTasksRouteTestLifecycle("tasks-merge-route-test");

  async function createDoneTaskWithPR(
    app: Awaited<ReturnType<typeof buildApp>>,
    prNumber: number | null = 1,
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: `merge-endpoint-p-${Math.random()}`,
        cwd: "/tmp",
      },
    });
    const projectId = project.json().id;
    const { tasks } = await import("../../src/db/schema.js");
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "done task",
        status: "done",
        completedAt: new Date(),
        prNumber,
        prUrl: prNumber !== null ? `https://github.com/o/r/pull/${prNumber}` : null,
      })
      .returning()
      .all();
    return row;
  }

  it("sets mergeRequestedAt and clears mergeError for a done task with a linked PR", async () => {
    const app = await buildApp();
    const task = await createDoneTaskWithPR(app);
    app.db
      .update(tasks)
      .set({ mergeError: "stale error from a prior attempt" })
      .where(eq(tasks.id, task.id))
      .run();

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/merge` });
    expect(res.statusCode).toBe(200);
    expect(res.json().mergeRequestedAt).not.toBeNull();
    expect(res.json().mergeError).toBeNull();

    await app.close();
  });

  it("409s for a task not in status 'done'", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "merge-endpoint-not-done",
        cwd: "/tmp",
      },
    });
    const { tasks } = await import("../../src/db/schema.js");
    const [row] = app.db
      .insert(tasks)
      .values({ projectId: project.json().id, title: "still reviewing", status: "reviewing" })
      .returning()
      .all();

    const res = await app.inject({ method: "POST", url: `/api/tasks/${row.id}/merge` });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it("409s for a done task with no linked pull request", async () => {
    const app = await buildApp();
    const task = await createDoneTaskWithPR(app, null);

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/merge` });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it("404s for a task that doesn't exist", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/tasks/999999/merge" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403s while Task Master is disabled", async () => {
    const app = await buildApp();
    try {
      const task = await createDoneTaskWithPR(app);
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { enabled: "off" } },
      });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/merge` });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { enabled: "inherit" } },
      });
      await app.close();
    }
  });
});
