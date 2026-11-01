import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see test/helpers/mock-pty.ts's header
// comment for the empirically confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { buildTestApp } from "../helpers/app.js";
import {
  createTaskGitRepo,
  createTaskProject,
  insertFailedTaskWithPreservedBranch,
} from "../helpers/task-retry-fixture.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";

// #2292 — the route-level half of the superseded-copy refusal:
// `POST /api/tasks/:id/retry` answers 409 for a copy a project merge
// superseded, instead of resuming its branch and spawning a duplicate worker.
//
// This lives in its own file rather than in test/routes/tasks.test.ts because
// that file is already at its size ceiling (scripts/check-max-file-lines.mjs
// is a ratchet: a file may not grow past its size at the reference commit).

vi.mock("node-pty", () => plainNodePtyMock());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual, { passthrough: ["git"] });
});

const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");

const tmpDb = path.join(os.tmpdir(), `tasks-retry-route-test-${process.pid}.db`);

describe("POST /api/tasks/:id/retry — a superseded copy is refused (#2292)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    // Retry is flag-gated (it spawns a session), same as Claim.
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  it("409s a copy a project merge superseded, and starts no session", async () => {
    const app = await buildTestApp();
    const cwd = createTaskGitRepo("tasks-retry-route-repo-");
    const projectId = await createTaskProject(app, cwd, "retry-superseded-p");
    // The shape a merge leaves behind: archived, its issue number cleared
    // (NULLs do not collide), and marked as superseded.
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 90, {
      issueNumber: null,
      archivedAt: new Date(),
      supersededAt: new Date(),
      failureReason: "Merged from project #7: superseded.",
    });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("superseded by a project merge");

    // The row is untouched: still failed, still archived, no session.
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(row.status).toBe("failed");
    expect(row.sessionId).toBeNull();
    expect(row.archivedAt).not.toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
