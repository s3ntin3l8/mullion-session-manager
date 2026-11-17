// Issue #3193 — Abandon (force DELETE of a task) must remove a remote-placed
// task's worktree AND branch on the WORKER's host, using that host's project
// path (projects.hostCwds), never the primary's project.cwd. The original
// incident sent the primary's path to a macbook agent, which rejected it and
// left the worktree behind. The branch half is the same target: removeWorktree
// does not delete the ref, so looking for it on the primary leaks it on the
// worker. Lives in its own file because tasks.test.ts is at its size ceiling.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";

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
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      ee.stdout = new EventEmitter();
      setImmediate(() => {
        ee.emit("exit", 0);
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, sessions, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { gitEnv } = await import("../../src/services/git-env.js");

const tmpDb = path.join(os.tmpdir(), `tasks-abandon-remote-${process.pid}.db`);

describe("Abandon a remote-placed task (#3193)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("force-removes the worktree with the worker host's mapped project path, not the primary's cwd", async () => {
    const app = await buildApp();
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "abandon-remote-p", cwd: "/tmp" },
    });
    const projectId = projectRes.json().id as number;
    const remoteCwd = "/Users/bjoern/Projects/branchdam-mobile";
    const worktreePath = `${remoteCwd}/.mullion-worktrees/mullion-task-1`;

    const hostRes = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const remoteHostId = hostRes.json().id as string;

    const [session] = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", hostId: remoteHostId, status: "active" })
      .returning()
      .all();
    app.db
      .update(projects)
      .set({ hostCwds: JSON.stringify({ [remoteHostId]: remoteCwd }) })
      .where(eq(projects.id, projectId))
      .run();
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "remote task to abandon",
        status: "failed",
        failureReason: "budget exceeded",
        worktreePath,
        branchName: "mullion/task-3193",
        sessionId: session.id,
      })
      .returning()
      .all();

    const sessionBackendModule = await import("../../src/services/session-backend.js");
    const realResolveBackend = sessionBackendModule.resolveBackend;
    const removeWorktreeMock = vi.fn().mockResolvedValue(true);
    const deleteBranchMock = vi.fn().mockResolvedValue({ deleted: true });
    const resolveBackendSpy = vi
      .spyOn(sessionBackendModule, "resolveBackend")
      .mockImplementation((appArg, hostId) => {
        const real = realResolveBackend(appArg, hostId);
        if (hostId !== remoteHostId) return real;
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "removeWorktree") return removeWorktreeMock;
            if (prop === "deleteBranch") return deleteBranchMock;
            if (prop === "terminate") return async () => undefined;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });

    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
    expect(res.statusCode).toBe(204);

    // The mapped path as the parent cwd, never the primary's "/tmp".
    expect(removeWorktreeMock).toHaveBeenCalledWith(worktreePath, remoteCwd);
    expect(removeWorktreeMock.mock.calls[0][1]).not.toBe("/tmp");
    // The branch lives in the same clone. removeWorktree does not delete it.
    expect(deleteBranchMock).toHaveBeenCalledWith(remoteCwd, "mullion/task-3193", { force: true });
    expect(deleteBranchMock.mock.calls[0][0]).not.toBe("/tmp");

    resolveBackendSpy.mockRestore();
    await app.close();
  });

  it("leaves the worktree and the branch, and still answers 204, when the worker host has no mapped path", async () => {
    const app = await buildApp();
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "abandon-unmapped-p", cwd: "/tmp" },
    });
    const projectId = projectRes.json().id as number;
    const worktreePath = "/Users/bjoern/Projects/unknown/.mullion-worktrees/mullion-task-2";

    const hostRes = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "Unmapped", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const remoteHostId = hostRes.json().id as string;

    const [session] = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", hostId: remoteHostId, status: "active" })
      .returning()
      .all();
    // Deliberately no hostCwds entry for remoteHostId.
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "unmapped task to abandon",
        status: "failed",
        failureReason: "budget exceeded",
        worktreePath,
        branchName: "mullion/task-unmapped",
        sessionId: session.id,
      })
      .returning()
      .all();

    const sessionBackendModule = await import("../../src/services/session-backend.js");
    const realResolveBackend = sessionBackendModule.resolveBackend;
    const checkoutCalls: { hostId: string; method: string; args: unknown[] }[] = [];
    const resolveBackendSpy = vi
      .spyOn(sessionBackendModule, "resolveBackend")
      .mockImplementation((appArg, hostId) => {
        const real = realResolveBackend(appArg, hostId);
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "removeWorktree" || prop === "deleteBranch") {
              return (...args: unknown[]) => {
                checkoutCalls.push({ hostId, method: String(prop), args });
                return prop === "deleteBranch"
                  ? Promise.resolve({ deleted: true })
                  : Promise.resolve(true);
              };
            }
            if (prop === "terminate") return async () => undefined;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
    const warnSpy = vi.spyOn(app.log, "warn");

    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
    expect(res.statusCode).toBe(204);
    // Neither half guessed the primary's "/tmp".
    expect(checkoutCalls).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: remoteHostId }),
      expect.stringContaining("no path for this project on that host"),
    );

    resolveBackendSpy.mockRestore();
    await app.close();
  });
});

describe("clear-done branch delete on the worker host (#3193)", () => {
  const tmpDb = path.join(os.tmpdir(), `tasks-clear-done-host-${process.pid}.db`);

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  function git(cwd: string, args: string[]) {
    execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
  }

  function createGitRepoWithRemote(owner: string, repo: string): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-clear-done-host-"));
    git(cwd, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "initial", "--no-verify"]);
    git(cwd, ["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
    return cwd;
  }

  async function connectPat(app: Awaited<ReturnType<typeof buildApp>>, token: string) {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const { setPat } = await import("../../src/services/github-integration.js");
    await setPat(app, token);
    global.fetch = originalFetch;
  }

  it("deletes a placed task's branch in the worker's clone, not the primary's", async () => {
    const cwd = createGitRepoWithRemote("acme", "widgets-clear-done-worker");
    const app = await buildApp();
    try {
      await connectPat(app, "ghp_clear_done_worker_host");
      const merged = await import("../../src/services/github-merged-prs.js");
      const mergedSpy = vi
        .spyOn(merged, "isPullRequestMerged")
        .mockResolvedValue({ merged: true, mergedAt: "2026-11-16T00:00:00Z" });

      const projectRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, name: "clear-done-worker-p", cwd },
      });
      const projectId = projectRes.json().id as number;
      const remoteCwd = "/Users/bjoern/Projects/branchdam-mobile";
      const hostRes = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "ClearDoneRemote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remoteHostId = hostRes.json().id as string;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "claude", hostId: remoteHostId, status: "exited" })
        .returning()
        .all();
      app.db
        .update(projects)
        .set({ hostCwds: JSON.stringify({ [remoteHostId]: remoteCwd }) })
        .where(eq(projects.id, projectId))
        .run();
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "done on the worker",
          status: "done",
          branchName: "mullion/task-clear-done-worker",
          prNumber: 9,
          sessionId: session.id,
        })
        .returning()
        .all();

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const deleteBranchMock = vi.fn().mockResolvedValue({ deleted: true });
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          if (hostId !== remoteHostId) return real;
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "deleteBranch") return deleteBranchMock;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/clear-done",
        payload: { projectIds: [projectId], deleteBranches: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toEqual([row.id]);
      expect(res.json().branches).toEqual([
        { id: row.id, branch: "mullion/task-clear-done-worker", deleted: true },
      ]);
      expect(deleteBranchMock).toHaveBeenCalledWith(remoteCwd, "mullion/task-clear-done-worker", {
        force: true,
      });
      expect(deleteBranchMock.mock.calls[0][0]).not.toBe(cwd);

      resolveBackendSpy.mockRestore();
      mergedSpy.mockRestore();
    } finally {
      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports no-host-path and does not delete when the worker host has no mapped path", async () => {
    const cwd = createGitRepoWithRemote("acme", "widgets-clear-done-unmapped");
    const app = await buildApp();
    try {
      await connectPat(app, "ghp_clear_done_unmapped_host");
      const merged = await import("../../src/services/github-merged-prs.js");
      const mergedSpy = vi
        .spyOn(merged, "isPullRequestMerged")
        .mockResolvedValue({ merged: true, mergedAt: "2026-11-16T00:00:00Z" });

      const projectRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, name: "clear-done-unmapped-p", cwd },
      });
      const projectId = projectRes.json().id as number;
      const hostRes = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "ClearDoneUnmapped", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remoteHostId = hostRes.json().id as string;
      const [session] = app.db
        .insert(sessions)
        .values({ projectId, command: "claude", hostId: remoteHostId, status: "exited" })
        .returning()
        .all();
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "done, host unmapped",
          status: "done",
          branchName: "mullion/task-clear-done-unmapped",
          prNumber: 10,
          sessionId: session.id,
        })
        .returning()
        .all();

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const deleteBranchMock = vi.fn().mockResolvedValue({ deleted: true });
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "deleteBranch") return deleteBranchMock;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/clear-done",
        payload: { projectIds: [projectId], deleteBranches: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toEqual([row.id]);
      expect(res.json().branches).toEqual([
        {
          id: row.id,
          branch: "mullion/task-clear-done-unmapped",
          deleted: false,
          reason: "no-host-path",
        },
      ]);
      expect(deleteBranchMock).not.toHaveBeenCalled();

      resolveBackendSpy.mockRestore();
      mergedSpy.mockRestore();
    } finally {
      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
