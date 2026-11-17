// Issue #3193 — Abandon (force DELETE of a task) must remove a remote-placed
// task's worktree on the WORKER's host, using that host's project path
// (projects.hostCwds), never the primary's project.cwd. The original incident
// sent the primary's path to a macbook agent, which rejected it and left the
// worktree behind. Lives in its own file because tasks.test.ts is at its
// size ceiling.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
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
    const resolveBackendSpy = vi
      .spyOn(sessionBackendModule, "resolveBackend")
      .mockImplementation((appArg, hostId) => {
        const real = realResolveBackend(appArg, hostId);
        if (hostId !== remoteHostId) return real;
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "removeWorktree") return removeWorktreeMock;
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

    resolveBackendSpy.mockRestore();
    await app.close();
  });
});
