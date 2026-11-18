import { describe, it, expect, vi } from "vitest";
import {
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  createGitRepo,
  createTaskProject as createProject,
  setupTasksRouteTestLifecycle,
} from "../helpers/tasks-routes-harness.js";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { applySettingsPatch } from "../../src/services/settings.js";
import { clearHermesKey, setHermesKey } from "../../src/services/hermes-integration.js";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", () => mockTaskPromoteFactory());

const { buildApp } = await import("../../src/app.js");
const { dispatchClaimedTask } = await import("../../src/services/task-claim.js");

describe("local task CRUD (6.9/#233)", () => {
  setupTasksRouteTestLifecycle("tasks-local-crud-route-test");

  it("POST /api/tasks creates a local task with no GitHub issue, flag-off included", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-1");

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { projectId, title: "Write the docs" },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({
      projectId,
      title: "Write the docs",
      issueNumber: null,
      htmlUrl: null,
      status: "backlog",
      boardOrder: 0,
    });

    await app.close();
  });

  it("POST /api/tasks 404s for an unknown project", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { projectId: 999999, title: "orphan" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST /api/tasks 400s on an unknown status value", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-2");
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { projectId, title: "bad status", status: "done" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("PATCH /api/tasks/:id edits title/body/boardOrder and toggles backlog<->ready", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-3");
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId, title: "Original title" },
      })
    ).json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: { title: "New title", body: "spec", boardOrder: 3, status: "ready" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      title: "New title",
      body: "spec",
      boardOrder: 3,
      status: "ready",
    });

    await app.close();
  });

  it("PATCH /api/tasks/:id refuses to edit title/body of a GitHub-linked task (Hermes review, PR #471)", async () => {
    // The watcher's onConflictDoUpdate resyncs title/body/htmlUrl from
    // the issue on every poll, so an edit here would be silently
    // reverted within one poll cycle with no error if this route let it
    // through — see task-watcher.ts.
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-linked-patch");
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 55,
        title: "From the issue",
        htmlUrl: "https://x/55",
        status: "backlog",
      })
      .returning()
      .all();

    const titleEdit = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${row.id}`,
      payload: { title: "Edited locally" },
    });
    expect(titleEdit.statusCode).toBe(409);

    const bodyEdit = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${row.id}`,
      payload: { body: "edited body" },
    });
    expect(bodyEdit.statusCode).toBe(409);

    // boardOrder and status remain editable regardless of the link.
    const orderEdit = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${row.id}`,
      payload: { boardOrder: 5, status: "ready" },
    });
    expect(orderEdit.statusCode).toBe(200);
    expect(orderEdit.json()).toMatchObject({
      title: "From the issue",
      boardOrder: 5,
      status: "ready",
    });

    await app.close();
  });

  it("PATCH /api/tasks/:id 404s for an unknown task", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/tasks/999999",
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH /api/tasks/:id 400s on a status outside backlog/ready (needs 6.2's state machine)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-4");
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId, title: "t" },
      })
    ).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: { status: "claimed" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("PATCH /api/tasks/:id 409s attempting to edit status once a task is already past backlog/ready", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-5");
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, title: "already claimed", status: "claimed" })
      .returning()
      .all();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${row.id}`,
      payload: { status: "backlog" },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("POST /api/tasks creates a task with explicit agent and reviewAgent", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-agent-1");

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        projectId,
        title: "Task with agents",
        agent: "codex",
        reviewAgent: "agy",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      projectId,
      title: "Task with agents",
      agent: "codex",
      reviewAgent: "agy",
    });

    await app.close();
  });

  it("PATCH /api/tasks/:id updates agent and reviewAgent on backlog/ready tasks", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-agent-2");
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId, title: "Task to patch agent" },
      })
    ).json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: { agent: "opencode", reviewAgent: "none" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      agent: "opencode",
      reviewAgent: "none",
    });

    await app.close();
  });

  it("PATCH /api/tasks/:id 400s on invalid agent name", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-agent-3");
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId, title: "Task to test bad agent" },
      })
    ).json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: { agent: "not-a-real-agent" },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("PATCH /api/tasks/:id 409s attempting to edit agent once past backlog/ready", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-agent-4");
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, title: "in progress task", status: "in_progress" })
      .returning()
      .all();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${row.id}`,
      payload: { agent: "codex" },
    });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it("PATCH /api/tasks/:id allows editing agent and reviewAgent on a failed task", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-agent-failed");
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, title: "failed task", status: "failed", agent: "claude" })
      .returning()
      .all();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${row.id}`,
      payload: { agent: "codex", reviewAgent: "none" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ agent: "codex", reviewAgent: "none" });

    await app.close();
  });

  describe("hermes as a review agent (#2369)", () => {
    type TestApp = Awaited<ReturnType<typeof buildApp>>;
    // The DB is shared across this file, so every test that sets Hermes up
    // takes it down again, pass or fail.
    async function withHermes<T>(app: TestApp, run: () => Promise<T>): Promise<T> {
      applySettingsPatch(app, {
        reviewRelay: { apiUrl: "http://hermes.test:8643", taskMasterReviewer: true },
      });
      setHermesKey(app, "test-key"); // pragma: allowlist secret
      try {
        return await run();
      } finally {
        clearHermesKey(app);
        applySettingsPatch(app, { reviewRelay: { apiUrl: "", taskMasterReviewer: false } });
      }
    }

    it("POST /api/tasks 400s on hermes while it isn't set up, and creates nothing", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-hermes-1");
      const count = () =>
        app.db.select().from(tasks).where(eq(tasks.projectId, projectId)).all().length;
      const before = count();

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId, title: "Hermes-reviewed", reviewAgent: "hermes" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("Review relay");
      expect(count()).toBe(before);

      await app.close();
    });

    it("POST /api/tasks stores hermes once it is set up", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-hermes-2");

      const res = await withHermes(app, () =>
        app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { projectId, title: "Hermes-reviewed", reviewAgent: "hermes" },
        }),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ reviewAgent: "hermes" });

      await app.close();
    });

    it("PATCH /api/tasks/:id 400s on hermes while it isn't set up, and accepts it once it is", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-hermes-3");
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { projectId, title: "Task to point at hermes" },
        })
      ).json();

      const refused = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${created.id}`,
        payload: { reviewAgent: "hermes" },
      });
      expect(refused.statusCode).toBe(400);
      expect(
        app.db.select().from(tasks).where(eq(tasks.id, created.id)).all()[0].reviewAgent,
      ).toBeNull();

      const accepted = await withHermes(app, () =>
        app.inject({
          method: "PATCH",
          url: `/api/tasks/${created.id}`,
          payload: { reviewAgent: "hermes" },
        }),
      );
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ reviewAgent: "hermes" });

      await app.close();
    });

    it("PATCH /api/tasks/:id still switches a task off hermes after Hermes stopped being usable", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-hermes-4");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "named hermes earlier", reviewAgent: "hermes" })
        .returning()
        .all();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${row.id}`,
        payload: { reviewAgent: "agy" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ reviewAgent: "agy" });

      await app.close();
    });

    it("POST /api/tasks/:id/claim 400s on a hermes override while it isn't set up", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-hermes-5");
      const [task] = app.db
        .insert(tasks)
        .values({ projectId, title: "Claim with hermes", status: "ready" })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/claim`,
        payload: { reviewAgent: "hermes" },
      });
      expect(res.statusCode).toBe(400);
      expect(app.db.select().from(tasks).where(eq(tasks.id, task.id)).all()[0].status).toBe(
        "ready",
      );

      await app.close();
    });

    it("POST /api/tasks/:id/retry 400s on a hermes override while it isn't set up", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-hermes-6");
      const [task] = app.db
        .insert(tasks)
        .values({ projectId, title: "Retry with hermes", status: "failed" })
        .returning()
        .all();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/retry`,
        payload: { reviewAgent: "hermes" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("Review relay");

      await app.close();
    });

    it("still rejects a review agent that is neither a known CLI, hermes, nor none", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, "/tmp/local-crud-hermes-7");

      for (const reviewAgent of ["not-a-real-agent", "Hermes"]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { projectId, title: "Bad reviewer", reviewAgent },
        });
        expect(res.statusCode).toBe(400);
      }

      await app.close();
    });
  });

  it("POST /api/tasks/:id/claim applies agent override from request body", async () => {
    const app = await buildApp();
    const cwd = createGitRepo();
    const projectId = await createProject(app, cwd);
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, title: "Claim with override", status: "ready" })
      .returning()
      .all();

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/claim`,
      payload: { agent: "codex", reviewAgent: "none" },
    });
    expect(res.statusCode).toBe(202);

    // agentCommand is stamped at dispatch, not enqueue — called directly
    // and awaited for determinism (see the claim describe block above).
    const outcome = await dispatchClaimedTask(app, task.id);
    expect(outcome.ok).toBe(true);

    const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(check.json()).toMatchObject({
      agent: "codex",
      reviewAgent: "none",
      agentCommand: "codex",
    });

    await app.close();
  });

  it("DELETE /api/tasks/:id removes a local task", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-6");
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { projectId, title: "to delete" },
      })
    ).json();

    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${created.id}` });
    expect(res.statusCode).toBe(204);

    const listed = await app.inject({ method: "GET", url: "/api/tasks" });
    expect((listed.json() as { id: number }[]).some((t) => t.id === created.id)).toBe(false);

    await app.close();
  });

  it("DELETE /api/tasks/:id refuses a GitHub-linked task", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-7");
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 99,
        title: "linked",
        htmlUrl: "https://x/99",
        status: "backlog",
      })
      .returning()
      .all();

    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("DELETE /api/tasks/:id refuses a task past backlog/ready", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, "/tmp/local-crud-8");
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, title: "claimed local", status: "claimed" })
      .returning()
      .all();

    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  // #729 — a GitHub-linked task auto-failed by a lost tracking label
  // (syncUnlabeledIssueToLocal) previously had no way out: not local
  // (issueNumber !== null) and past backlog/ready (failed), so it hit
  // both refusals above forever. These cases match isIssueStillTrackable's
  // own contract (task-github-sync.test.ts) at the route layer — confirmed
  // closed or unlabeled deletes a never-claimed (`branchName === null`)
  // task; still tracked, or unconfirmable, refuses — plus the separate
  // `branchName !== null` guard for a task that WAS claimed and has a
  // real branch Retry can resume, regardless of what its issue is doing.
});
