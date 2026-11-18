import { describe, it, expect, vi } from "vitest";
import {
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  setupTasksRouteTestLifecycle,
} from "../helpers/tasks-routes-harness.js";
import { tasks } from "../../src/db/schema.js";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", () => mockTaskPromoteFactory());

const { buildApp } = await import("../../src/app.js");

describe("tasks route", () => {
  setupTasksRouteTestLifecycle("tasks-route-test");

  it("returns [] when no tasks exist", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("lists tasks joined with their project name", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "demo", cwd: "/tmp/demo" },
    });
    const projectId = project.json().id;

    app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 7,
        title: "Add feature",
        body: "some body",
        htmlUrl: "https://github.com/o/r/issues/7",
        // Phase 6 (6.9/#233) changed the column default to "backlog" —
        // pinned explicitly here since this test is asserting the row's
        // status verbatim, not exercising the claim route (which gates on
        // "ready", not "pending" — see routes/tasks.ts).
        status: "pending",
      })
      .run();

    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      projectId,
      projectName: "demo",
      issueNumber: 7,
      title: "Add feature",
      body: "some body",
      htmlUrl: "https://github.com/o/r/issues/7",
      status: "pending",
      sessionId: null,
    });

    await app.close();
  });

  // #701 — sub-issue hierarchy columns, on both GET /api/tasks and
  // GET /api/tasks/:id (TASK_ROW_COLUMNS is shared between the two, but
  // this pins both endpoints so a future column added to only one of them
  // is caught here rather than at the frontend).
  it("exposes the sub-issue hierarchy columns on GET /api/tasks and GET /api/tasks/:id", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "demo-hierarchy",
        cwd: "/tmp/demo-hierarchy",
      },
    });
    const projectId = project.json().id;

    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 44,
        title: "A child issue",
        status: "backlog",
        parentIssueNumber: 30,
        parentIssueRepo: "s3ntin3l8/branchdam",
        parentIssueTitle: "Phase 5 — Tier-1 project introspection",
        subIssueTotal: 4,
        subIssueCompleted: 1,
      })
      .returning({ id: tasks.id })
      .all();

    const listRes = await app.inject({ method: "GET", url: "/api/tasks" });
    const listed = (listRes.json() as { id: number }[]).find((t) => t.id === row.id);
    expect(listed).toMatchObject({
      parentIssueNumber: 30,
      parentIssueRepo: "s3ntin3l8/branchdam",
      parentIssueTitle: "Phase 5 — Tier-1 project introspection",
      subIssueTotal: 4,
      subIssueCompleted: 1,
    });

    const singleRes = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
    expect(singleRes.json()).toMatchObject({
      parentIssueNumber: 30,
      parentIssueRepo: "s3ntin3l8/branchdam",
      parentIssueTitle: "Phase 5 — Tier-1 project introspection",
      subIssueTotal: 4,
      subIssueCompleted: 1,
    });

    await app.close();
  });

  // Issue #957/#958 — model/smallModel columns were added to the tasks table
  // (drizzle 0056) but omitted from TASK_ROW_COLUMNS, the exact silent-drop
  // that previously bit #816/#818 (see this suite's own comment above).
  // Pins both endpoints, same posture as the sub-issue hierarchy test above —
  // deliberately reading the GET path, not a POST's `.returning()`, since a
  // `.returning()` bypasses TASK_ROW_COLUMNS entirely and would pass either way.
  it("exposes the model and smallModel columns on GET /api/tasks and GET /api/tasks/:id", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "demo-model",
        cwd: "/tmp/demo-model",
      },
    });
    const projectId = project.json().id;

    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 45,
        title: "An opencode-backed task",
        status: "backlog",
        model: "anthropic/claude-sonnet-4-5",
        smallModel: "openrouter/minimax-m3",
      })
      .returning({ id: tasks.id })
      .all();

    const listRes = await app.inject({ method: "GET", url: "/api/tasks" });
    const listed = (listRes.json() as { id: number }[]).find((t) => t.id === row.id);
    expect(listed).toMatchObject({
      model: "anthropic/claude-sonnet-4-5",
      smallModel: "openrouter/minimax-m3",
    });

    const singleRes = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
    expect(singleRes.json()).toMatchObject({
      model: "anthropic/claude-sonnet-4-5",
      smallModel: "openrouter/minimax-m3",
    });

    await app.close();
  });

  // Issue #1954 — `placementRequirement` is written at dispatch; without an
  // entry in TASK_ROW_COLUMNS it would never reach either GET (the silent drop
  // the test below records). Asserted through the GET paths, not a POST's
  // `.returning()`, which bypasses TASK_ROW_COLUMNS entirely.
  it("exposes placementRequirement on GET /api/tasks and GET /api/tasks/:id", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "demo-placement-req",
        cwd: "/tmp/demo-placement-req",
      },
    });
    const projectId = project.json().id;

    const requirement = JSON.stringify({ platform: "darwin" });
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "needs a Mac",
        status: "failed",
        placementRequirement: requirement,
      })
      .returning({ id: tasks.id })
      .all();

    const listRes = await app.inject({ method: "GET", url: "/api/tasks" });
    const listed = (listRes.json() as { id: number }[]).find((t) => t.id === row.id);
    expect(listed).toMatchObject({ placementRequirement: requirement });

    const singleRes = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
    expect(singleRes.json()).toMatchObject({ placementRequirement: requirement });

    await app.close();
  });

  // Issue #1038 — the first route-level test for autoReturnCapAnnouncedAt.
  // TASK_ROW_COLUMNS has silently dropped a new column four times already
  // (#816, #818, #957, lastReviewVerdict — see this file's own doc comment
  // on that list) — every prior case typechecked clean while every GET
  // response returned `undefined` at runtime. Asserted through the actual
  // GET path, not a POST's `.returning()`, which bypasses TASK_ROW_COLUMNS
  // entirely and would pass even if this column were missing from it.
  it("exposes autoReturnCapAnnouncedAt on GET /api/tasks and GET /api/tasks/:id", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "demo-cap-announced",
        cwd: "/tmp/demo-cap-announced",
      },
    });
    const projectId = project.json().id;

    const announcedAt = new Date("2026-09-04T09:34:44.000Z");
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "capped and announced",
        status: "reviewing",
        autoReturnRounds: 2,
        autoReturnCapAnnouncedAt: announcedAt,
      })
      .returning({ id: tasks.id })
      .all();

    const listRes = await app.inject({ method: "GET", url: "/api/tasks" });
    const listed = (listRes.json() as { id: number }[]).find((t) => t.id === row.id);
    expect(listed).toMatchObject({ autoReturnCapAnnouncedAt: announcedAt.toISOString() });

    const singleRes = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
    expect(singleRes.json()).toMatchObject({
      autoReturnCapAnnouncedAt: announcedAt.toISOString(),
    });

    await app.close();
  });

  it("lists a locally-created task with a null issue link", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "demo-local",
        cwd: "/tmp/demo-local",
      },
    });
    const projectId = project.json().id;

    app.db.insert(tasks).values({ projectId, title: "Local-only task", status: "backlog" }).run();

    const res = await app.inject({ method: "GET", url: `/api/tasks?projectId=${projectId}` });
    expect(res.statusCode).toBe(200);
    const own = res.json() as { projectId: number }[];
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      projectId,
      title: "Local-only task",
      issueNumber: null,
      htmlUrl: null,
      status: "backlog",
    });

    await app.close();
  });

  it("allows multiple locally-created tasks (null issueNumber) in the same project", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "demo-multi-local",
        cwd: "/tmp/demo-multi-local",
      },
    });
    const projectId = project.json().id;

    // Verifies the unique index on (projectId, issueNumber) treats NULLs as
    // distinct (6.9) — this would throw a constraint violation if it didn't.
    app.db.insert(tasks).values({ projectId, title: "Local task one" }).run();
    app.db.insert(tasks).values({ projectId, title: "Local task two" }).run();

    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    const own = (res.json() as { projectId: number }[]).filter((t) => t.projectId === projectId);
    expect(own).toHaveLength(2);

    await app.close();
  });
});
