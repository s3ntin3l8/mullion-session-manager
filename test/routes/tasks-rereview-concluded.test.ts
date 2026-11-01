import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { tasks } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

// POST /api/tasks/:id/re-review for a review that CONCLUDED (not just an
// inconclusive one). Split out of tasks.test.ts, which this repo's file-size
// ratchet won't let grow; the session spawn is faked the same way
// (node-pty / systemd-run).
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
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `tasks-rereview-test-${process.pid}.db`);

describe("POST /api/tasks/:id/re-review on a concluded review", () => {
  let codexHome: string;
  let fakeHome: string;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-rereview-codex-home-"));
    process.env.CODEX_HOME = codexHome;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-rereview-fake-home-"));
    process.env.HOME = fakeHome;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  async function reviewingTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    verdict: string,
    rearmCount = 0,
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: `rereview-${verdict}`, cwd: "/tmp" },
    });
    const projectId = project.json().id;
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const reviewSessionId = session.json().id as number;
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "reviewed",
        status: "reviewing",
        lastReviewVerdict: verdict,
        lastReviewVerdictAt: new Date(),
        reviewSessionId,
        reviewFindingsIngestedSessionId: reviewSessionId,
        reviewSeedDelivered: true,
        inconclusiveReviewRearmCount: rearmCount,
      })
      .returning()
      .all();
    return task;
  }

  it.each(["changes-requested", "approved-with-suggestions", "clean"])(
    "re-arms a finished %s review without spending the inconclusive rearm count",
    async (verdict) => {
      const app = await buildApp();
      const task = await reviewingTask(app, verdict);
      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });

      expect(res.statusCode).toBe(200);
      // Re-armed: the handles are cleared so a fresh review spawns. The old verdict
      // stays until the new review overwrites it — the follow-up round reads it.
      expect(res.json()).toMatchObject({
        status: "reviewing",
        reviewSessionId: null,
        reviewFindingsIngestedSessionId: null,
        lastReviewVerdict: verdict,
        inconclusiveReviewRearmCount: 0,
      });
      await app.close();
    },
  );

  it("resets the entry time, so a second re-review at the same head is a new Hermes dispatch", async () => {
    const app = await buildApp();
    const task = await reviewingTask(app, "changes-requested");
    const longAgo = new Date("2026-01-01T00:00:00Z");
    app.db.update(tasks).set({ reviewingAt: longAgo }).where(eq(tasks.id, task.id)).run();
    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });
    expect(res.statusCode).toBe(200);
    // reviewingAt is part of the dispatch's idempotency key (hermes-task-review.ts).
    expect(new Date(res.json().reviewingAt).getTime()).toBeGreaterThan(longAgo.getTime());
    await app.close();
  });

  it("re-arms a finished external-reviewer run the same way", async () => {
    const app = await buildApp();
    const task = await reviewingTask(app, "changes-requested");
    app.db
      .update(tasks)
      .set({
        reviewSessionId: null,
        reviewFindingsIngestedSessionId: null,
        reviewRunId: "run_1",
        reviewRunIngestedId: "run_1",
      })
      .where(eq(tasks.id, task.id))
      .run();
    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      reviewRunId: null,
      reviewRunIngestedId: null,
      lastReviewVerdict: "changes-requested",
      inconclusiveReviewRearmCount: 0,
    });
    await app.close();
  });

  it("still counts a re-run of an inconclusive review against the rearm count", async () => {
    const app = await buildApp();
    const task = await reviewingTask(app, "inconclusive", 1);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });
    expect(res.statusCode).toBe(200);
    expect(res.json().inconclusiveReviewRearmCount).toBe(2);
    await app.close();
  });

  it("409s for a task with no finished review", async () => {
    const app = await buildApp();
    const task = await reviewingTask(app, "changes-requested");
    app.db.update(tasks).set({ lastReviewVerdict: null }).where(eq(tasks.id, task.id)).run();
    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/re-review` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
