import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { sessions, tasks } from "../../src/db/schema.js";
import {
  findActiveDockSession,
  findTaskIdByBranch,
  getProjectById,
  getProjectsByIds,
  getSessionById,
  getTaskStatusForIssue,
  listActiveSessionsWithProject,
  listLocalProjectCwds,
  listTaskStatusesByIssue,
  listTaskWorktreeRefs,
  markActiveSessionExited,
  setProjectScaffoldStamp,
} from "../../src/services/project-records.js";

const tmpDb = path.join(os.tmpdir(), `project-records-test-${process.pid}.db`);

describe("project-records service", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;
  let otherId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    await app.ready();
    const mk = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            createDir: true,
            name,
            cwd: `/tmp/${name}-${process.pid}`,
          },
        })
      ).json().id as number;
    projectId = await mk("rec-a");
    otherId = await mk("rec-b");
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("looks projects up by id and by id list", () => {
    expect(getProjectById(app.db, projectId)?.name).toBe("rec-a");
    expect(getProjectById(app.db, 999999)).toBeNull();
    const rows = getProjectsByIds(app.db, [projectId, otherId, 999999]);
    expect(rows.map((r) => r.id).sort()).toEqual([projectId, otherId].sort());
  });

  it("lists the local project cwds", () => {
    expect(listLocalProjectCwds(app.db)).toContain(`/tmp/rec-a-${process.pid}`);
  });

  it("stamps slug and conventions hash", () => {
    setProjectScaffoldStamp(app.db, projectId, { slug: "rec-a", conventionsHash: "abc" });
    const p = getProjectById(app.db, projectId);
    expect(p?.slug).toBe("rec-a");
    expect(p?.conventionsHash).toBe("abc");
  });

  it("finds, marks and re-reads dock and active sessions", () => {
    const [dock] = app.db
      .insert(sessions)
      .values({ projectId, kind: "dock", name: "stack:x", status: "active", command: "true" })
      .returning()
      .all();
    expect(getSessionById(app.db, dock.id)?.name).toBe("stack:x");
    expect(getSessionById(app.db, 999999)).toBeNull();
    expect(findActiveDockSession(app.db, projectId, "stack:x")?.id).toBe(dock.id);
    expect(findActiveDockSession(app.db, otherId, "stack:x")).toBeNull();
    expect(findActiveDockSession(app.db, projectId, "stack:y")).toBeNull();

    const active = listActiveSessionsWithProject(app.db).find((r) => r.id === dock.id);
    expect(active?.projectCwd).toBe(`/tmp/rec-a-${process.pid}`);

    markActiveSessionExited(app.db, dock.id);
    expect(getSessionById(app.db, dock.id)?.status).toBe("exited");
    expect(findActiveDockSession(app.db, projectId, "stack:x")).toBeNull();
    expect(listActiveSessionsWithProject(app.db).some((r) => r.id === dock.id)).toBe(false);
  });

  it("reads resumable tasks by branch and worktree", () => {
    const [t] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "in_progress",
        issueNumber: 77,
        branchName: "mullion/task-77",
        worktreePath: "/tmp/wt-77",
      })
      .returning()
      .all();
    app.db
      .insert(tasks)
      .values({ projectId, title: "done", status: "done", issueNumber: 78, branchName: "b78" })
      .run();
    const resumable = ["claimed", "in_progress", "reviewing", "failed"] as const;
    expect(findTaskIdByBranch(app.db, projectId, "mullion/task-77", resumable)).toBe(t.id);
    expect(findTaskIdByBranch(app.db, projectId, "b78", resumable)).toBeNull();
    expect(findTaskIdByBranch(app.db, otherId, "mullion/task-77", resumable)).toBeNull();
    expect(listTaskWorktreeRefs(app.db, projectId, resumable)).toEqual([
      { sessionId: null, worktreePath: "/tmp/wt-77" },
    ]);
  });

  it("maps issue numbers to task statuses", () => {
    expect(listTaskStatusesByIssue(app.db, projectId, [])).toEqual([]);
    const rows = listTaskStatusesByIssue(app.db, projectId, [77, 78, 79]);
    expect(rows.map((r) => [r.issueNumber, r.status]).sort()).toEqual([
      [77, "in_progress"],
      [78, "done"],
    ]);
    expect(getTaskStatusForIssue(app.db, projectId, 77)).toBe("in_progress");
    expect(getTaskStatusForIssue(app.db, projectId, 79)).toBeNull();
  });
});
