import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq, ne } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import * as sessionBackends from "../../src/services/session-backend.js";
import {
  worktreeInUse,
  sessionsUsingWorktree,
  WorktreeComparisonTimeout,
} from "../../src/services/worktree-usage.js";

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
  it("bounds a remote liveness probe during a sweep and does not compare afterward", async () => {
    app.db
      .insert(hosts)
      .values({ id: "remote-b", name: "remote-b", baseUrl: "http://remote-b.example" })
      .run();
    const project = seedProject("remote-b");
    app.db
      .insert(sessions)
      .values({ projectId: project, command: "bash", cwd: "/old", status: "exited" })
      .run();
    let finish!: (value: Record<string, string>) => void;
    const compareWorktreePaths = vi.fn().mockResolvedValue([]);
    const liveness = vi.fn(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          finish = resolve;
        }),
    );
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      liveness,
      compareWorktreePaths,
    } as unknown as sessionBackends.SessionBackend);
    vi.useFakeTimers();
    try {
      const result = sessionsUsingWorktree(app, worktreePath, "remote-b", undefined, true, {
        remoteTimeoutMs: 4000,
        deadHistory: { ids: new Set(), initialized: false },
      });
      const rejection = expect(result).rejects.toBeInstanceOf(WorktreeComparisonTimeout);
      await vi.advanceTimersByTimeAsync(4000);
      await rejection;
      finish({});
      await Promise.resolve();
      expect(compareWorktreePaths).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  it("avoids resolving many dead historical paths for each local worktree", async () => {
    const project = seedProject("local");
    for (let i = 0; i < 100; i++) {
      app.db
        .insert(sessions)
        .values({ projectId: project, command: "bash", cwd: `/historical/${i}`, status: "exited" })
        .run();
    }
    const liveness = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, "dead"])),
    );
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      liveness,
    } as unknown as sessionBackends.SessionBackend);
    const realpath = vi.spyOn(fs.promises, "realpath");
    const history = { ids: new Set<number>(), initialized: false };
    for (let i = 0; i < 10; i++) {
      expect(
        await sessionsUsingWorktree(app, `/tmp/target-${i}`, "local", undefined, true, {
          remoteTimeoutMs: 4000,
          deadHistory: history,
        }),
      ).toEqual({ active: [], alive: [], unknown: [] });
    }
    expect(
      realpath.mock.calls.filter(([value]) => String(value).startsWith("/historical/")),
    ).toHaveLength(0);
    expect(liveness).toHaveBeenCalledTimes(11);
  });

  it("does not trust a dead snapshot when a process reappears during the check", async () => {
    const project = seedProject("local");
    const id = Number(
      app.db
        .insert(sessions)
        .values({ projectId: project, command: "bash", cwd: "/outside", status: "exited" })
        .run().lastInsertRowid,
    );
    const liveness = vi
      .fn()
      .mockResolvedValueOnce({ [String(id)]: "dead" })
      .mockResolvedValue({ [String(id)]: "alive" });
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      liveness,
    } as unknown as sessionBackends.SessionBackend);
    expect(
      (
        await sessionsUsingWorktree(app, worktreePath, "local", undefined, true, {
          remoteTimeoutMs: 4000,
          deadHistory: { ids: new Set(), initialized: false },
        })
      ).unknown,
    ).toContain(id);
  });

  it("defers if a session starts during the final ended-session liveness check", async () => {
    const project = seedProject("local");
    const ended = Number(
      app.db
        .insert(sessions)
        .values({ projectId: project, command: "bash", cwd: worktreePath, status: "exited" })
        .run().lastInsertRowid,
    );
    let added = 0;
    const liveness = vi
      .fn()
      .mockResolvedValueOnce({ [String(ended)]: "alive" })
      .mockImplementationOnce(async () => {
        added = seedSession(project);
        return { [String(ended)]: "dead" };
      });
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      liveness,
    } as unknown as sessionBackends.SessionBackend);
    const result = await sessionsUsingWorktree(app, worktreePath, "local", undefined, true, {
      remoteTimeoutMs: 4000,
      deadHistory: { ids: new Set(), initialized: false },
    });
    expect([...result.active, ...result.unknown]).toContain(added);
  });

  it("does not report an unrelated new session as a manual-removal blocker", async () => {
    const project = seedProject("local");
    const ended = Number(
      app.db
        .insert(sessions)
        .values({ projectId: project, command: "bash", cwd: worktreePath, status: "exited" })
        .run().lastInsertRowid,
    );
    const liveness = vi
      .fn()
      .mockImplementationOnce(async () => {
        app.db
          .insert(sessions)
          .values({ projectId: project, command: "bash", cwd: "/unrelated" })
          .run();
        return { [String(ended)]: "dead" };
      })
      .mockResolvedValue({ [String(ended)]: "dead" });
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      liveness,
    } as unknown as sessionBackends.SessionBackend);
    expect(await sessionsUsingWorktree(app, worktreePath, "local")).toEqual({
      active: [],
      alive: [],
      unknown: [],
    });
  });

  it("detects a session entering the worktree during a manual-removal liveness probe", async () => {
    const project = seedProject("local");
    const ended = Number(
      app.db
        .insert(sessions)
        .values({ projectId: project, command: "bash", cwd: worktreePath, status: "exited" })
        .run().lastInsertRowid,
    );
    let added = 0;
    const liveness = vi
      .fn()
      .mockImplementationOnce(async () => {
        added = seedSession(project);
        return { [String(ended)]: "dead" };
      })
      .mockResolvedValue({ [String(ended)]: "dead" });
    vi.spyOn(sessionBackends, "resolveBackend").mockReturnValue({
      liveness,
    } as unknown as sessionBackends.SessionBackend);
    expect((await sessionsUsingWorktree(app, worktreePath, "local")).active).toContain(added);
  });

  it("observes new sessions and changed symlinks on the next sweep check", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sweep-"));
    try {
      const target = path.join(root, "target");
      const outside = path.join(root, "outside");
      const alias = path.join(root, "alias");
      fs.mkdirSync(target);
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, alias, "dir");
      const project = seedProject("local");
      const id = seedSession(project);
      const history = { ids: new Set<number>(), initialized: false };
      app.db.update(sessions).set({ cwd: alias }).where(eq(sessions.id, id)).run();
      expect(
        (
          await sessionsUsingWorktree(app, target, "local", undefined, true, {
            remoteTimeoutMs: 4000,
            deadHistory: history,
          })
        ).active,
      ).toEqual([]);
      fs.unlinkSync(alias);
      fs.symlinkSync(target, alias, "dir");
      expect(
        (
          await sessionsUsingWorktree(app, target, "local", undefined, true, {
            remoteTimeoutMs: 4000,
            deadHistory: history,
          })
        ).active,
      ).toContain(id);
      fs.unlinkSync(alias);
      fs.symlinkSync(outside, alias, "dir");
      const added = Number(
        app.db.insert(sessions).values({ projectId: project, command: "bash", cwd: target }).run()
          .lastInsertRowid,
      );
      expect(
        (
          await sessionsUsingWorktree(app, target, "local", undefined, true, {
            remoteTimeoutMs: 4000,
            deadHistory: history,
          })
        ).active,
      ).toContain(added);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
