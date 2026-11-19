// Issue #3194 — `tasks.retryHostId` reaches the API.
//
// The column names the host a QUEUED RETRY waits for (its original worker's
// host, whose preserved branch the retry resumes). The frontend's "Start
// fresh" action — the operator's way out of a waiting retry — keys off
// exactly this field, on both the board card and the task sidebar.
//
// TASK_ROW_COLUMNS (src/services/task-store.ts) has silently dropped a new
// column four times already (#816, #818, #957, lastReviewVerdict — see that
// file's own doc comment on the list): every one of those typechecked clean
// while every GET response returned `undefined` at runtime.
//
// So this is asserted through the GET paths, not a POST's `.returning()`,
// which bypasses TASK_ROW_COLUMNS entirely and would pass even if this
// column were missing from it.
//
// It lives in its own file because tasks.test.ts is pinned by the
// max-file-lines ratchet and must not grow.
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

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (command === "git") return actual.spawn(command, args, options);
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");

const tmpDb = path.join(os.tmpdir(), `tasks-retry-host-id-test-${process.pid}.db`);

describe("tasks.retryHostId on the GET paths (#3194)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("exposes retryHostId on GET /api/tasks and GET /api/tasks/:id", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "demo-retry-host",
        cwd: "/tmp/demo-retry-host",
      },
    });
    const projectId = project.json().id;

    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "waits for its host",
        status: "claimed",
        resumeQueued: true,
        retryHostId: "macbook-host-id",
      })
      .returning({ id: tasks.id })
      .all();

    const listRes = await app.inject({ method: "GET", url: "/api/tasks" });
    const listed = (listRes.json() as { id: number }[]).find((t) => t.id === row.id);
    expect(listed).toMatchObject({ retryHostId: "macbook-host-id" });

    const singleRes = await app.inject({ method: "GET", url: `/api/tasks/${row.id}` });
    expect(singleRes.json()).toMatchObject({ retryHostId: "macbook-host-id" });

    await app.close();
  });
});
