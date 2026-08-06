// #490a — upsertIssueTask's "ingested" /ws/tasks broadcast, tested against
// a real app+DB (not the hand-mocked db object task-watcher.test.ts uses
// for startTaskWatcher's own scheduling logic): the existed-check +
// onConflictDoUpdate + returning() sequence this depends on is real SQLite
// upsert semantics that a hand mock can't faithfully replicate. Kept in its
// own file, not appended to task-watcher.test.ts, because that file's
// module-level vi.mock() calls replace github-integration.js/task-claim.js
// etc. wholesale — fine for unit-testing startTaskWatcher's scheduling in
// isolation, but would break buildApp()'s real route registration if a
// real-DB test shared the same module registry.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const mockBroadcastTaskEvent = vi.fn();
vi.mock("../../src/services/task-events.js", () => ({
  broadcastTaskEvent: mockBroadcastTaskEvent,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");
const { upsertIssueTask } = await import("../../src/services/task-watcher.js");
const { eq, and } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-watcher-ingest-test-${process.pid}.db`);

describe("upsertIssueTask (#490a)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-watcher-ingest-test-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "ingest-test-project", cwd },
    });
    projectId = res.json().id;
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    mockBroadcastTaskEvent.mockClear();
  });

  it("broadcasts an 'ingested' event with the new row's id on first sighting", () => {
    upsertIssueTask(app, projectId, {
      number: 900,
      title: "New issue",
      body: null,
      htmlUrl: "https://x/900",
    });

    const [row] = app.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, 900)))
      .all();
    expect(mockBroadcastTaskEvent).toHaveBeenCalledExactlyOnceWith({
      taskId: row.id,
      projectId,
      kind: "ingested",
      ts: expect.any(Number),
    });
  });

  it("does not broadcast again on a re-sighting that changes a real column", () => {
    upsertIssueTask(app, projectId, {
      number: 901,
      title: "Original",
      body: null,
      htmlUrl: "https://x/901",
    });
    mockBroadcastTaskEvent.mockClear();

    upsertIssueTask(app, projectId, {
      number: 901,
      title: "Retitled",
      body: null,
      htmlUrl: "https://x/901",
    });

    expect(mockBroadcastTaskEvent).not.toHaveBeenCalled();
    const [row] = app.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, 901)))
      .all();
    expect(row.title).toBe("Retitled");
  });

  it("does not broadcast on a genuine no-op re-sighting (nothing changed)", () => {
    upsertIssueTask(app, projectId, {
      number: 902,
      title: "Stable",
      body: null,
      htmlUrl: "https://x/902",
    });
    mockBroadcastTaskEvent.mockClear();

    upsertIssueTask(app, projectId, {
      number: 902,
      title: "Stable",
      body: null,
      htmlUrl: "https://x/902",
    });

    expect(mockBroadcastTaskEvent).not.toHaveBeenCalled();
  });

  it("does not reset status/boardOrder on a re-sighting, and does not re-broadcast", () => {
    upsertIssueTask(app, projectId, {
      number: 903,
      title: "Claim me",
      body: null,
      htmlUrl: "https://x/903",
    });
    app.db
      .update(tasks)
      .set({ status: "claimed" })
      .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, 903)))
      .run();
    mockBroadcastTaskEvent.mockClear();

    upsertIssueTask(app, projectId, {
      number: 903,
      title: "Claim me (edited)",
      body: null,
      htmlUrl: "https://x/903",
    });

    expect(mockBroadcastTaskEvent).not.toHaveBeenCalled();
    const [row] = app.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, 903)))
      .all();
    expect(row.status).toBe("claimed");
  });
});
