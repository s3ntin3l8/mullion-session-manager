// #2750 — a human Reject resets the auto-rebase budget, so a worker that
// failed to rebase can be followed by a fresh auto-rebase. Its own file: the
// routes' test file is at its file-size ceiling.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

// Never let a real systemd-run fire (test/global-setup.ts, issue #2003).
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
const { tasks } = await import("../../src/db/schema.js");

const tmpDb = path.join(os.tmpdir(), `tasks-reject-rebase-reset-${process.pid}.db`);

beforeAll(() => {
  fs.rmSync(tmpDb, { force: true });
  process.env.DATABASE_URL = `file:${tmpDb}`;
  process.env.MULLION_TASK_MASTER_ENABLED = "true";
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDb, { force: true });
  delete process.env.DATABASE_URL;
  delete process.env.MULLION_TASK_MASTER_ENABLED;
});

describe("POST /api/tasks/:id/reject — rebase budget", () => {
  it("resets rebaseAttempts and clears a merge-tied needs-a-human reason", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "reject-rebase-p", cwd: "/tmp" },
    });
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "rebase budget spent",
        status: "reviewing",
        rebaseAttempts: 2,
        mergeError: "Conflicts with main — auto-rebase gave up after 2 attempt(s)",
        needsHumanReason: "rebase-exhausted",
      })
      .returning()
      .all();

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${row.id}/reject`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "in_progress",
      rebaseAttempts: 0,
      needsHumanReason: null,
    });
    await app.close();
  });
});
