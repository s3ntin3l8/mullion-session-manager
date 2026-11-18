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

describe("POST /api/tasks/:id/give-up (#483)", () => {
  setupTasksRouteTestLifecycle("tasks-give-up-route-test");

  async function createProjectAndReviewingTask(app: Awaited<ReturnType<typeof buildApp>>) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "give-up-p", cwd: "/tmp/give-up" },
    });
    const projectId = project.json().id;
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, title: "under review", status: "reviewing" })
      .returning()
      .all();
    return row;
  }

  it("transitions reviewing -> failed and records a default reason", async () => {
    const app = await buildApp();
    const task = await createProjectAndReviewingTask(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/give-up`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "failed",
      failureReason: "given up during review",
    });
    expect(res.json().completedAt).not.toBeNull();

    await app.close();
  });

  it("records a custom reason when given", async () => {
    const app = await buildApp();
    const task = await createProjectAndReviewingTask(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/give-up`,
      payload: { reason: "not the right approach" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "failed",
      failureReason: "not the right approach",
    });

    await app.close();
  });

  it("409s a task not in reviewing", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "give-up-not-reviewing-p",
        cwd: "/tmp/give-up-2",
      },
    });
    const [row] = app.db
      .insert(tasks)
      .values({ projectId: project.json().id, title: "still backlog", status: "backlog" })
      .returning()
      .all();

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${row.id}/give-up`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it("still works when Task Master is disabled — the same escape hatch reject already is", async () => {
    process.env.MULLION_TASK_MASTER_ENABLED = "false";
    try {
      const app = await buildApp();
      const task = await createProjectAndReviewingTask(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/give-up`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("failed");

      await app.close();
    } finally {
      process.env.MULLION_TASK_MASTER_ENABLED = "true";
    }
  });

  it("calls cleanupTaskWorktree — leaving reviewing for a terminal state, same as approve", async () => {
    const sessionBackendModule = await import("../../src/services/session-backend.js");
    const realResolveBackend = sessionBackendModule.resolveBackend;
    const removeWorktreeIfCleanMock = vi.fn().mockResolvedValue({ removed: true });
    const resolveBackendSpy = vi
      .spyOn(sessionBackendModule, "resolveBackend")
      .mockImplementation((appArg, hostId) => {
        const real = realResolveBackend(appArg, hostId);
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "removeWorktreeIfClean") return removeWorktreeIfCleanMock;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });

    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "give-up-cleanup-p",
        cwd: "/tmp/give-up-cleanup",
      },
    });
    const projectId = project.json().id;
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "under review",
        status: "reviewing",
        worktreePath: "/tmp/give-up-cleanup/.mullion-worktrees/mullion-task-1",
        branchName: "mullion/task-1",
      })
      .returning()
      .all();

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/give-up`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(removeWorktreeIfCleanMock).toHaveBeenCalledWith(
      "/tmp/give-up-cleanup/.mullion-worktrees/mullion-task-1",
      "/tmp/give-up-cleanup",
    );

    resolveBackendSpy.mockRestore();
    await app.close();
  });

  // #772 — nothing terminated a task's sessions on give-up either; both
  // lingered indefinitely once the task reached "failed".
  it("kills both the worker and review sessions on give-up", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "give-up-sessions-p",
        cwd: "/tmp/give-up-sessions",
      },
    });
    const projectId = project.json().id;
    const worker = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const reviewer = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "under review",
        status: "reviewing",
        sessionId: worker.json().id,
        reviewSessionId: reviewer.json().id,
      })
      .returning()
      .all();

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/give-up`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const { sessions } = await import("../../src/db/schema.js");
    const [workerRow] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, worker.json().id))
      .all();
    const [reviewRow] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, reviewer.json().id))
      .all();
    expect(workerRow.status).toBe("killed");
    expect(reviewRow.status).toBe("killed");

    await app.close();
  });
});

// Issue #1345 — the operator-facing counterpart to #1346's automatic
// reannounceInconclusiveReviewsAfterGrace sweep (task-reconciler.ts): a
// manual escape hatch for a task stuck on lastReviewVerdict ===
// "inconclusive" that doesn't wait for that sweep's own hour-long grace
// or respect its one-shot inconclusiveReviewRearmCount bound.
