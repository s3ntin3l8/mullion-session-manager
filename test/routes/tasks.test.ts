import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { tasks } from "../../src/db/schema.js";

// Claiming a task spawns a real session (routes/tasks.ts's claim endpoint
// reuses sessions.ts's createSessionRecord) — faked the same way
// test/routes/sessions.test.ts fakes node-pty/systemd-run/dtach for its own
// worktree-isolation tests, so this file exercises the route/DB layer
// without depending on a real systemd --user session existing in CI. `git`
// subprocesses (worktree creation, resolveDefaultBaseRef) are left real.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const listeners: Array<(data: string) => void> = [];
    return {
      onData: (cb: (data: string) => void) => {
        listeners.push(cb);
        return { dispose: () => {} };
      },
      onExit: () => ({ dispose: () => {} }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  }),
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

const tmpDb = path.join(os.tmpdir(), `tasks-route-test-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-route-test-repo-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

describe("tasks route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

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
      payload: { name: "demo", cwd: "/tmp/demo" },
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
        // pinned explicitly here since this test (unlike the claim tests
        // below) is asserting the row's status verbatim, not exercising
        // the claim route's still-"pending"-gated behavior (that flips in
        // 6.2/#215).
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

  it("lists a locally-created task with a null issue link", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "demo-local", cwd: "/tmp/demo-local" },
    });
    const projectId = project.json().id;

    app.db.insert(tasks).values({ projectId, title: "Local-only task", status: "backlog" }).run();

    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    // GET /api/tasks has no project filter yet (that lands with 6.2's
    // ?projectId= — see routes/tasks.ts's own comment on the GET route),
    // and this suite shares one DB across tests, so filter to this
    // project's own rows rather than asserting the full cross-test list.
    const own = (res.json() as { projectId: number }[]).filter((t) => t.projectId === projectId);
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
      payload: { name: "demo-multi-local", cwd: "/tmp/demo-multi-local" },
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

  describe("POST /api/tasks/:id/claim (issue #216)", () => {
    async function createProjectWithGitRepo(
      app: Awaited<ReturnType<typeof buildApp>>,
      cwd: string,
    ) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "claim-p", cwd },
      });
      return res.json().id as number;
    }

    function insertTask(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      issueNumber: number,
    ) {
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber,
          title: "Fix the thing",
          body: "some details",
          htmlUrl: `https://github.com/o/r/issues/${issueNumber}`,
          // Pinned explicitly (6.9 changed the column default to
          // "backlog") — the claim route's gate is still "pending" until
          // 6.2/#215 flips it to "ready".
          status: "pending",
        })
        .returning()
        .all();
      return row;
    }

    it("creates a worktree, spawns a session there, and marks the task claimed", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const task = insertTask(app, projectId, 42);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(res.statusCode).toBe(201);
      const session = res.json();
      expect(session.projectId).toBe(projectId);
      expect(session.cwd).toBe(path.join(cwd, ".mullion-worktrees", "mullion-task-42"));
      expect(fs.existsSync(session.cwd)).toBe(true);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const claimed = (listed.json() as { id: number }[]).find((t) => t.id === task.id);
      expect(claimed).toMatchObject({ status: "claimed", sessionId: session.id });
      expect((claimed as { claimedAt: string | null }).claimedAt).not.toBeNull();

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("only one of two concurrent claims for the same task wins (Hermes review, PR #280)", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const task = insertTask(app, projectId, 45);

      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` }),
        app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` }),
      ]);

      // Exactly one request wins (201). The loser's exact status depends on
      // *where* the two requests' async work interleaves: the deterministic
      // branch name (`mullion/task-<issueNumber>`) usually makes the loser's
      // own `git worktree add` collide first (502, reply.badGateway) rather
      // than reach the optimistic-lock UPDATE below (409, reply.conflict) —
      // both correctly reject the loser, so this only asserts the one
      // property that actually matters: no double-win, and the DB ends up
      // pointing at whichever request actually got a session.
      const winner = first.statusCode === 201 ? first : second;
      const loser = first.statusCode === 201 ? second : first;
      expect(winner.statusCode).toBe(201);
      expect([409, 502]).toContain(loser.statusCode);

      const listed = await app.inject({ method: "GET", url: "/api/tasks" });
      const claimed = (listed.json() as { id: number; sessionId: number; status: string }[]).find(
        (t) => t.id === task.id,
      );
      expect(claimed?.status).toBe("claimed");
      expect(claimed?.sessionId).toBe(winner.json().id);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("404s for an unknown task id", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/tasks/999999/claim" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("409s when the task is not pending", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const task = insertTask(app, projectId, 43);

      const first = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(second.statusCode).toBe(409);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("400s for a task on a remote-hosted project", async () => {
      const app = await buildApp();

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-p", cwd: "/tmp/remote", hostId },
      });
      const projectId = project.json().id;
      const task = insertTask(app, projectId, 44);

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/claim` });
      expect(res.statusCode).toBe(400);

      await app.close();
    });
  });

  describe("local task CRUD (6.9/#233)", () => {
    async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "local-crud-p", cwd },
      });
      return res.json().id as number;
    }

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
  });
});
