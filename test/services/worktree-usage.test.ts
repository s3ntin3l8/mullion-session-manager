import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { ne } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import * as sessionBackends from "../../src/services/session-backend.js";
import { worktreeInUse, sessionsUsingWorktree } from "../../src/services/worktree-usage.js";

// Issue #1722 / roadmap 8.8 — "local" means the SESSION's own host is
// local, not its project's. A session placed on a remote host has a cwd on
// that other machine, so it cannot be holding a LOCAL worktree open.
//
// Real DB, real joins — the same posture the ownership tests take: the rule
// lives in a SQL predicate, and a mocked query builder could pass while the
// predicate was wrong.

const tmpDb = path.join(os.tmpdir(), `worktree-usage-host-scope-test-${process.pid}.db`);

describe("worktreeInUse — the session's own host decides locality (issue #1722)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    app.db.delete(sessions).run();
    app.db.delete(projects).run();
    // `where` takes an SQL chunk, not a bare string — `ne()` builds the
    // same `id != 'local'` predicate from the column itself.
    app.db.delete(hosts).where(ne(hosts.id, "local")).run();
  });

  afterEach(() => vi.restoreAllMocks());

  const worktreePath = "/tmp/mullion-worktree-usage-test";

  function seedProject(hostId: string): number {
    const [row] = app.db
      .insert(projects)
      .values({ name: "p", cwd: worktreePath, hostId })
      .returning({ id: projects.id })
      .all();
    return row.id;
  }

  function seedSession(projectId: number, hostId?: string): number {
    const [row] = app.db
      .insert(sessions)
      .values({
        projectId,
        command: "bash",
        cwd: worktreePath,
        ...(hostId === undefined ? {} : { hostId }),
      })
      .returning({ id: sessions.id })
      .all();
    return row.id;
  }

  it("counts an active session that lives HERE and holds the worktree", () => {
    const projectId = seedProject("local");
    seedSession(projectId);
    expect(worktreeInUse(app, worktreePath)).toBe(true);
  });

  it("does NOT count a session PLACED on a remote host (issue #1722)", () => {
    // Its project lives here, so the old project-derived filter would have
    // counted it — and this host's worktrees would look busy forever.
    app.db
      .insert(hosts)
      .values({ id: "remote-b", name: "remote-b", baseUrl: "http://remote-b.example" })
      .run();
    const projectId = seedProject("local");
    seedSession(projectId, "remote-b");
    expect(worktreeInUse(app, worktreePath)).toBe(false);
  });

  it("still counts a session that inherits its project's LOCAL host (issue #1722)", () => {
    // Every pre-existing row is NULL here and must keep behaving exactly as
    // before the column existed.
    const projectId = seedProject("local");
    seedSession(projectId);
    expect(worktreeInUse(app, worktreePath)).toBe(true);
  });
  it("compares all sessions on the owning remote host including aliases and fallback cwd", async () => {
    app.db
      .insert(hosts)
      .values({ id: "remote-b", name: "remote-b", baseUrl: "http://remote-b.example" })
      .run();
    const project = seedProject("remote-b");
    const alias = app.db
      .insert(sessions)
      .values({ projectId: project, command: "bash", cwd: "/alias/sub" })
      .run();
    const fallback = app.db
      .insert(sessions)
      .values({ projectId: project, command: "bash", cwd: null })
      .run();
    const local = seedProject("local");
    seedSession(local);
    const compareWorktreePaths = vi.fn(async (_target: string, entries: { cwd: string | null }[]) =>
      entries.map((entry) => (entry.cwd === "/alias/sub" ? "inside" : "outside")),
    );
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      compareWorktreePaths,
    } as unknown as sessionBackends.SessionBackend);
    const usage = await sessionsUsingWorktree(app, worktreePath, "remote-b");
    expect(usage.active).toEqual([Number(alias.lastInsertRowid)]);
    expect(usage.unknown).toEqual([]);
    expect(compareWorktreePaths).toHaveBeenCalledWith(
      worktreePath,
      expect.arrayContaining([{ id: String(fallback.lastInsertRowid), cwd: null }]),
    );
    expect(compareWorktreePaths.mock.calls[0]![1]).toHaveLength(2);
  });

  it("marks remote sessions unknown when the agent cannot compare paths", async () => {
    app.db
      .insert(hosts)
      .values({ id: "remote-b", name: "remote-b", baseUrl: "http://remote-b.example" })
      .run();
    const project = seedProject("remote-b");
    const id = seedSession(project);
    const compareWorktreePaths = vi.fn().mockRejectedValue(new Error("old or unreachable"));
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      compareWorktreePaths,
    } as unknown as sessionBackends.SessionBackend);
    expect(await sessionsUsingWorktree(app, worktreePath, "remote-b")).toEqual({
      active: [],
      alive: [],
      unknown: [id],
    });
  });
  it("blocks a session added while ended-session liveness is checked", async () => {
    app.db
      .insert(hosts)
      .values({ id: "remote-b", name: "remote-b", baseUrl: "http://remote-b.example" })
      .run();
    const project = seedProject("remote-b");
    app.db
      .insert(sessions)
      .values({ projectId: project, command: "bash", cwd: worktreePath, status: "exited" })
      .run();
    let created = 0;
    const compareWorktreePaths = vi.fn(async (_target: string, candidates: unknown[]) =>
      candidates.map(() => "inside"),
    );
    const liveness = vi.fn(async () => {
      created = seedSession(project);
      return {};
    });
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      compareWorktreePaths,
      liveness,
    } as unknown as sessionBackends.SessionBackend);
    const usage = await sessionsUsingWorktree(app, worktreePath, "remote-b");
    expect(usage.unknown).toContain(created);
  });
  it("rechecks live paths after querying ended-session liveness", async () => {
    app.db
      .insert(hosts)
      .values({ id: "remote-b", name: "remote-b", baseUrl: "http://remote-b.example" })
      .run();
    const project = seedProject("remote-b");
    const active = seedSession(project);
    app.db
      .insert(sessions)
      .values({ projectId: project, command: "bash", cwd: worktreePath, status: "exited" })
      .run();
    const liveness = vi.fn().mockResolvedValue({});
    const compareWorktreePaths = vi.fn(async () =>
      liveness.mock.calls.length ? ["inside", "outside"] : ["outside", "outside"],
    );
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      compareWorktreePaths,
      liveness,
    } as unknown as sessionBackends.SessionBackend);
    expect((await sessionsUsingWorktree(app, worktreePath, "remote-b")).active).toContain(active);
  });
  it("does not trust a primary-host project path for a remotely placed session with no cwd", async () => {
    app.db
      .insert(hosts)
      .values({ id: "remote-b", name: "remote-b", baseUrl: "http://remote-b.example" })
      .run();
    const project = seedProject("local");
    const sessionId = Number(
      app.db
        .insert(sessions)
        .values({ projectId: project, command: "bash", cwd: null, hostId: "remote-b" })
        .run().lastInsertRowid,
    );
    const compareWorktreePaths = vi.fn().mockResolvedValue(["unknown"]);
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      compareWorktreePaths,
    } as unknown as sessionBackends.SessionBackend);
    expect((await sessionsUsingWorktree(app, worktreePath, "remote-b")).unknown).toEqual([
      sessionId,
    ]);
    expect(compareWorktreePaths).toHaveBeenCalledWith(worktreePath, [
      { id: String(sessionId), cwd: null },
    ]);
  });
  it("does not resolve paths for confirmed-dead historical sessions", async () => {
    app.db
      .insert(hosts)
      .values({ id: "remote-b", name: "remote-b", baseUrl: "http://remote-b.example" })
      .run();
    const project = seedProject("remote-b");
    const id = Number(
      app.db
        .insert(sessions)
        .values({ projectId: project, command: "bash", cwd: "/old/alias", status: "exited" })
        .run().lastInsertRowid,
    );
    const compareWorktreePaths = vi.fn().mockResolvedValue([]);
    const liveness = vi.fn().mockResolvedValue({ [String(id)]: "dead" });
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      compareWorktreePaths,
      liveness,
    } as unknown as sessionBackends.SessionBackend);
    expect(await sessionsUsingWorktree(app, worktreePath, "remote-b")).toEqual({
      active: [],
      alive: [],
      unknown: [],
    });
    expect(compareWorktreePaths).toHaveBeenCalledWith(worktreePath, []);
  });
});
