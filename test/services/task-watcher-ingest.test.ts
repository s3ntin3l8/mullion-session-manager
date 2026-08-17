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
      payload: { createDir: true, name: "ingest-test-project", cwd },
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

  // #701 — the CASE WHEN title-invalidation logic in upsertIssueTask relies
  // on SQLite's ON CONFLICT DO UPDATE scoping rule (a bare/table-qualified
  // column reference in the SET/WHERE clause reads the row's CURRENT,
  // pre-update value). That's a real-DB semantic, not something a mocked
  // app.db could exercise faithfully — hence this file, not a unit test.
  describe("sub-issue hierarchy (#701)", () => {
    function rowFor(issueNumber: number) {
      return app.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, issueNumber)))
        .get()!;
    }

    it("writes parentIssueNumber/parentIssueRepo on first sighting, title stays null", () => {
      upsertIssueTask(app, projectId, {
        number: 910,
        title: "Child",
        body: null,
        htmlUrl: "https://x/910",
        parent: { repo: "owner/repo", number: 21 },
      });
      const row = rowFor(910);
      expect(row.parentIssueNumber).toBe(21);
      expect(row.parentIssueRepo).toBe("owner/repo");
      expect(row.parentIssueTitle).toBeNull();
    });

    it("a poll-sourced null parent clears a previously-stored one", () => {
      upsertIssueTask(app, projectId, {
        number: 911,
        title: "Was a child",
        body: null,
        htmlUrl: "https://x/911",
        parent: { repo: "owner/repo", number: 22 },
      });
      upsertIssueTask(app, projectId, {
        number: 911,
        title: "Was a child",
        body: null,
        htmlUrl: "https://x/911",
        parent: null,
      });
      const row = rowFor(911);
      expect(row.parentIssueNumber).toBeNull();
      expect(row.parentIssueRepo).toBeNull();
    });

    it("a webhook-sourced re-sighting (parent field omitted) preserves a stored parent", () => {
      upsertIssueTask(app, projectId, {
        number: 912,
        title: "Child",
        body: null,
        htmlUrl: "https://x/912",
        parent: { repo: "owner/repo", number: 23 },
      });
      // Simulates routes/webhooks.ts's ingest path, which has no
      // parent_issue_url to read and never sets the field at all.
      upsertIssueTask(app, projectId, {
        number: 912,
        title: "Child (retitled)",
        body: null,
        htmlUrl: "https://x/912",
      });
      const row = rowFor(912);
      expect(row.parentIssueNumber).toBe(23);
      expect(row.parentIssueRepo).toBe("owner/repo");
      expect(row.title).toBe("Child (retitled)");
    });

    it("a changed parent nulls a previously-filled title", () => {
      upsertIssueTask(app, projectId, {
        number: 913,
        title: "Child",
        body: null,
        htmlUrl: "https://x/913",
        parent: { repo: "owner/repo", number: 24 },
      });
      app.db
        .update(tasks)
        .set({ parentIssueTitle: "Phase 4 — old title" })
        .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, 913)))
        .run();
      expect(rowFor(913).parentIssueTitle).toBe("Phase 4 — old title");

      upsertIssueTask(app, projectId, {
        number: 913,
        title: "Child",
        body: null,
        htmlUrl: "https://x/913",
        parent: { repo: "owner/repo", number: 25 }, // re-parented
      });

      const row = rowFor(913);
      expect(row.parentIssueNumber).toBe(25);
      expect(row.parentIssueTitle).toBeNull();
    });

    it("an unchanged parent preserves a previously-filled title", () => {
      upsertIssueTask(app, projectId, {
        number: 914,
        title: "Child",
        body: null,
        htmlUrl: "https://x/914",
        parent: { repo: "owner/repo", number: 26 },
      });
      app.db
        .update(tasks)
        .set({ parentIssueTitle: "Phase 6 — title" })
        .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, 914)))
        .run();

      // Re-sighted with the SAME parent, but a real column (title) also
      // changes — must still go through the onConflictDoUpdate branch
      // without touching parentIssueTitle.
      upsertIssueTask(app, projectId, {
        number: 914,
        title: "Child (edited)",
        body: null,
        htmlUrl: "https://x/914",
        parent: { repo: "owner/repo", number: 26 },
      });

      const row = rowFor(914);
      expect(row.parentIssueNumber).toBe(26);
      expect(row.parentIssueTitle).toBe("Phase 6 — title");
      expect(row.title).toBe("Child (edited)");
    });

    it("writes subIssueTotal/subIssueCompleted and updates them on re-sighting", () => {
      upsertIssueTask(app, projectId, {
        number: 915,
        title: "Parent-shaped task",
        body: null,
        htmlUrl: "https://x/915",
        subIssues: { total: 3, completed: 1 },
      });
      expect(rowFor(915).subIssueTotal).toBe(3);
      expect(rowFor(915).subIssueCompleted).toBe(1);

      upsertIssueTask(app, projectId, {
        number: 915,
        title: "Parent-shaped task",
        body: null,
        htmlUrl: "https://x/915",
        subIssues: { total: 3, completed: 2 },
      });
      expect(rowFor(915).subIssueCompleted).toBe(2);
    });

    it("a webhook-sourced re-sighting (subIssues omitted) preserves stored sub-issue counts", () => {
      upsertIssueTask(app, projectId, {
        number: 916,
        title: "Parent-shaped task",
        body: null,
        htmlUrl: "https://x/916",
        subIssues: { total: 4, completed: 0 },
      });
      upsertIssueTask(app, projectId, {
        number: 916,
        title: "Parent-shaped task (retitled)",
        body: null,
        htmlUrl: "https://x/916",
      });
      const row = rowFor(916);
      expect(row.subIssueTotal).toBe(4);
      expect(row.subIssueCompleted).toBe(0);
    });
  });
});
