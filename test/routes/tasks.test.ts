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
});
