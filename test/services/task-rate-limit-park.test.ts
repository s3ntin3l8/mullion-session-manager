import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { enqueueTask } = await import("../../src/services/task-claim.js");
const { parkRateLimitedTask } = await import("../../src/services/task-rate-limit-park.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const sessionLifecycle = await import("../../src/services/session-lifecycle.js");

const tmpDb = path.join(os.tmpdir(), `task-rate-limit-park-${process.pid}.db`);

function rollout(message: string, variant: string | null): string {
  return (
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        error: variant === null ? null : { message, codex_error_info: variant },
      },
    }) + "\n"
  );
}

async function setup(message: string, variant: string | null = "usage_limit_exceeded") {
  const app = await buildApp();
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name: `p-${Math.random()}`, cwd: "/tmp" },
  });
  const projectId = project.json().id as number;
  const backend = { terminate: vi.fn().mockResolvedValue(undefined) };
  vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(
    backend as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>,
  );
  const session = app.db
    .insert(sessions)
    .values({ projectId, command: "codex", status: "active" })
    .returning()
    .get();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-park-"));
  const dir = path.join(codexHome, "sessions", "2026", "11", "11");
  fs.mkdirSync(dir, { recursive: true });
  const transcriptPath = path.join(dir, "rollout-test.jsonl");
  fs.writeFileSync(transcriptPath, rollout(message, variant));
  vi.spyOn(app.pty, "codexTranscriptPathSessions").mockReturnValue([
    { id: String(session.id), transcriptPath, codexHome },
  ]);
  const reset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  reset.setMilliseconds(0);
  const task = app.db
    .insert(tasks)
    .values({
      projectId,
      title: "park me",
      status: "in_progress",
      sessionId: session.id,
      claimedAt: new Date(),
      startedAt: new Date(),
      lastRateLimitAt: new Date(),
      branchName: "mullion/task-1-park-me",
      worktreePath: "/tmp/park-me",
      agent: "claude",
    })
    .returning()
    .get();
  const load = () => app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
  const sessionStatus = () =>
    app.db.select().from(sessions).where(eq(sessions.id, session.id)).get()!.status;
  return { app, projectId, session, task, load, sessionStatus, reset, codexHome };
}

describe("parkRateLimitedTask (#2940)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("kills the worker and parks the task ready until the parsed reset", async () => {
    const reset = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    reset.setMilliseconds(0);
    const { app, projectId, session, task, load, sessionStatus } = await setup(
      `usage limit reached; try again at ${reset.toISOString()}`,
    );

    const parked = await parkRateLimitedTask(app, task, session.id, projectId);

    expect(parked).toBe(true);
    expect(sessionStatus()).toBe("killed");
    const row = load();
    expect(row.status).toBe("ready");
    expect(row.sessionId).toBeNull();
    expect(row.claimedAt).toBeNull();
    expect(row.startedAt).toBeNull();
    expect(row.resumeQueued).toBe(true);
    expect(row.branchName).toBe("mullion/task-1-park-me");
    expect(row.failureReason).toBe("rate limited; held until the provider reset");
    expect(row.rateLimitUntil?.toISOString()).toBe(reset.toISOString());
    expect(await parkRateLimitedTask(app, row, session.id, projectId)).toBe(false);

    const claimed = await enqueueTask(app, task.id, { auto: false });
    expect(claimed.ok).toBe(true);
    const after = load();
    expect(after.status).toBe("claimed");
    expect(after.rateLimitUntil).toBeNull();
    expect(after.resumeQueued).toBe(true);
    expect(after.branchName).toBe("mullion/task-1-park-me");
    expect(after.worktreePath).toBe("/tmp/park-me");
    await app.close();
  });

  it("leaves the task in grace when the message has no future reset", async () => {
    const { app, projectId, session, task, load, sessionStatus } = await setup(
      "exceeded retry limit, last status: 429",
    );
    expect(await parkRateLimitedTask(app, task, session.id, projectId)).toBe(false);
    expect(load().status).toBe("in_progress");
    expect(sessionStatus()).toBe("active");
    await app.close();
  });

  it("leaves the task in grace when the reset is already past", async () => {
    const past = new Date(Date.now() - 60_000);
    past.setMilliseconds(0);
    const { app, projectId, session, task, load, sessionStatus } = await setup(
      `try again at ${past.toISOString()}`,
    );
    expect(await parkRateLimitedTask(app, task, session.id, projectId)).toBe(false);
    expect(load().status).toBe("in_progress");
    expect(sessionStatus()).toBe("active");
    await app.close();
  });

  it("does not park a time-only phrase or a clean completion", async () => {
    const timed = await setup("try again at 8:00 PM");
    expect(
      await parkRateLimitedTask(timed.app, timed.task, timed.session.id, timed.projectId),
    ).toBe(false);
    expect(timed.sessionStatus()).toBe("active");
    await timed.app.close();

    const clean = await setup("done", null);
    expect(
      await parkRateLimitedTask(clean.app, clean.task, clean.session.id, clean.projectId),
    ).toBe(false);
    expect(clean.load().status).toBe("in_progress");
    await clean.app.close();
  });

  it("does not park a reviewing task or one outside grace", async () => {
    const reviewing = await setup("try again at 2030-01-02T01:00:00.000Z");
    reviewing.app.db
      .update(tasks)
      .set({ status: "reviewing" })
      .where(eq(tasks.id, reviewing.task.id))
      .run();
    const reviewingRow = reviewing.load();
    expect(
      await parkRateLimitedTask(
        reviewing.app,
        reviewingRow,
        reviewing.session.id,
        reviewing.projectId,
      ),
    ).toBe(false);
    expect(reviewing.sessionStatus()).toBe("active");
    await reviewing.app.close();

    const stale = await setup("try again at 2030-01-02T01:00:00.000Z");
    stale.app.db
      .update(tasks)
      .set({ lastRateLimitAt: new Date(Date.now() - 10 * 60 * 60 * 1000) })
      .where(eq(tasks.id, stale.task.id))
      .run();
    expect(
      await parkRateLimitedTask(stale.app, stale.load(), stale.session.id, stale.projectId),
    ).toBe(false);
    expect(stale.sessionStatus()).toBe("active");
    await stale.app.close();
  });

  it("does not change the task when the kill fails", async () => {
    const { app, projectId, session, task, load, sessionStatus } = await setup(
      "try again at 2030-01-02T01:00:00.000Z",
    );
    vi.spyOn(sessionLifecycle, "killSession").mockRejectedValueOnce(new Error("terminate down"));
    expect(await parkRateLimitedTask(app, task, session.id, projectId)).toBe(false);
    expect(load().status).toBe("in_progress");
    expect(load().rateLimitUntil).toBeNull();
    expect(sessionStatus()).toBe("active");
    vi.restoreAllMocks();
    await app.close();
  });
});
