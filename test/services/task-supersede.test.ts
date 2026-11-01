import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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

// #2292 — a task copy that a project merge superseded must never be retried:
// another task owns the issue now, so resuming this copy's branch would start
// a SECOND worker for work already in flight. `retryTask` refuses it, and the
// refusal is the retry-side twin of #2291's claim-side refusal.
//
// This lives in its own file rather than in test/services/task-claim.test.ts
// because that file is already at its size ceiling (scripts/check-max-file-
// lines.mjs is a ratchet: a file may not grow past its size at the reference
// commit), so the retryTask cases it holds cannot be added to.

vi.mock("node-pty", () => plainNodePtyMock());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual, { passthrough: ["git"] });
});

const { closeDb } = await import("../../src/db/client.js");
const { retryTask } = await import("../../src/services/task-claim.js");
const { tasks } = await import("../../src/db/schema.js");
const sessionsModule = await import("../../src/services/session-lifecycle.js");

const tmpDb = path.join(os.tmpdir(), `task-supersede-test-${process.pid}.db`);

describe("retryTask refuses a superseded copy (#2292)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getTask(app: Awaited<ReturnType<typeof buildTestApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  it("refuses a copy a project merge superseded, and starts nothing", async () => {
    const app = await buildTestApp();
    const cwd = createTaskGitRepo("task-supersede-test-repo-");
    const projectId = await createTaskProject(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 80, {
      archivedAt: new Date(),
      supersededAt: new Date(),
    });
    const spawnSpy = vi.spyOn(sessionsModule, "createSessionRecord");

    const outcome = await retryTask(app, task.id);

    expect(outcome).toMatchObject({ ok: false, reason: "superseded" });
    expect(outcome.ok === false && outcome.detail).toContain("superseded by a project merge");
    // Nothing was reserved, resumed or spawned.
    expect(spawnSpy).not.toHaveBeenCalled();
    const row = getTask(app, task.id);
    expect(row.status).toBe("failed");
    expect(row.sessionId).toBeNull();
    // The row is left exactly as it was — still archived, still holding its
    // branch and its failure reason.
    expect(row.archivedAt).not.toBeNull();
    expect(row.branchName).toBe(task.branchName);
    expect(row.failureReason).toBe("budget exceeded after 120 minutes");

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // The reason this is a COLUMN rather than a reading of `archivedAt`: the
  // marker is a fact about the row ("a merge superseded this copy"), and
  // Unarchive clears only `archivedAt` — unhiding a row does not undo the
  // fact, and must not re-arm the duplicate worker.
  it("still refuses a superseded copy that has been unarchived", async () => {
    const app = await buildTestApp();
    const cwd = createTaskGitRepo("task-supersede-test-repo-");
    const projectId = await createTaskProject(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 82, {
      archivedAt: null,
      supersededAt: new Date(),
    });
    const spawnSpy = vi.spyOn(sessionsModule, "createSessionRecord");

    const outcome = await retryTask(app, task.id);

    expect(outcome).toMatchObject({ ok: false, reason: "superseded" });
    expect(spawnSpy).not.toHaveBeenCalled();
    const row = getTask(app, task.id);
    expect(row.status).toBe("failed");
    expect(row.sessionId).toBeNull();
    expect(row.archivedAt).toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("reports the supersession rather than the missing branch", async () => {
    const app = await buildTestApp();
    const cwd = createTaskGitRepo("task-supersede-test-repo-");
    const projectId = await createTaskProject(app, cwd);
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "failed",
        branchName: null,
        archivedAt: new Date(),
        supersededAt: new Date(),
      })
      .returning()
      .all();

    const outcome = await retryTask(app, task.id);

    // "superseded" is the true diagnosis; "no-worktree" is only a symptom of
    // it, so it must not be what the caller is told.
    expect(outcome).toMatchObject({ ok: false, reason: "superseded" });

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("still retries a task the user merely archived (#1015)", async () => {
    const app = await buildTestApp();
    const cwd = createTaskGitRepo("task-supersede-test-repo-");
    const projectId = await createTaskProject(app, cwd);
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 81, {
      archivedAt: new Date(),
    });

    const outcome = await retryTask(app, task.id);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    const row = getTask(app, task.id);
    expect(row.status).toBe("in_progress");
    // The retry un-hides the row, as #1015 requires.
    expect(row.archivedAt).toBeNull();

    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
