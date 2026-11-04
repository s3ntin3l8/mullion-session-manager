import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { resolveExecutionContext } from "../../src/services/execution-context.js";
import { HostRequestError, RemoteHostClient } from "../../src/services/remote-host-client.js";
import { resolveBackend } from "../../src/services/session-backend.js";
import { invalidateRemoteWorktreeCache } from "../../src/services/remote-worktree-cache.js";

// Issue #2583 — the resolver asks the agent for its worktree list whenever the
// session's directory lies outside the checkout. That answer changes only when
// a worktree is created or removed, so it is cached briefly: a busy file tree
// must not ask the agent once per file.
describe("the remote worktree listing cache", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let root: string;
  let n = 0;

  beforeAll(async () => {
    const tmpDb = path.join(os.tmpdir(), `remote-worktree-cache-${process.pid}.db`);
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rwc-")));
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(path.join(os.tmpdir(), `remote-worktree-cache-${process.pid}.db`), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => vi.restoreAllMocks());

  /** A remote host with a project on it and a session whose directory is a
   *  worktree OUTSIDE the checkout — the only shape that asks the agent. */
  async function remoteSession(worktreePath: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: `rwc-host-${++n}`,
        baseUrl: "http://127.0.0.1:1",
        token: "t".repeat(24),
      },
    });
    const hostId = res.json().id as string;
    const projectId = app.db
      .insert(projects)
      .values({ name: `rwc-${++n}`, cwd: "/srv/repo", hostId })
      .returning({ id: projects.id })
      .get().id;
    const sessionId = app.db
      .insert(sessions)
      .values({ projectId, name: "s", command: "bash", cwd: worktreePath })
      .returning({ id: sessions.id })
      .get().id;
    return { hostId, projectId, sessionId };
  }

  function listsWorktrees(paths: string[]) {
    return vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockResolvedValue({
      branches: [],
      worktrees: paths.map((p) => ({ path: p, branch: null, isMain: false })),
      remoteBranches: [],
    } as never);
  }

  it("answers the second request within the TTL without asking the agent again", async () => {
    const { hostId, projectId, sessionId } = await remoteSession("/srv/repo-wt/feat");
    const spy = listsWorktrees(["/srv/repo-wt/feat"]);

    const first = await resolveExecutionContext(app, { projectId, sessionId });
    expect(first).toMatchObject({ ok: true, context: { cwd: "/srv/repo-wt/feat" } });
    expect(spy).toHaveBeenCalledTimes(1);

    const second = await resolveExecutionContext(app, { projectId, sessionId });
    expect(second).toMatchObject({ ok: true, context: { cwd: "/srv/repo-wt/feat" } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(hostId).toBeTruthy();
  });

  it("asks the agent again once the TTL has passed", async () => {
    const { projectId, sessionId } = await remoteSession("/srv/repo-wt/feat");
    const spy = listsWorktrees(["/srv/repo-wt/feat"]);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
        ok: true,
      });
      expect(spy).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 11_000);
      expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
        ok: true,
      });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets a miss stay negative: a worktree created seconds ago is accepted", async () => {
    const { projectId, sessionId } = await remoteSession("/srv/repo-wt/feat");
    const spy = vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockResolvedValue({
      branches: [],
      worktrees: [],
      remoteBranches: [],
    } as never);

    // The agent does not know this worktree yet.
    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: false,
      error: { code: "invalid_context" },
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // It appears now. The cached list does not mention it, so the resolver
    // must ask the agent again rather than answer from the stale list.
    spy.mockResolvedValue({
      branches: [],
      worktrees: [{ path: "/srv/repo-wt/feat", branch: null, isMain: false }],
      remoteBranches: [],
    } as never);
    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: true,
      context: { cwd: "/srv/repo-wt/feat" },
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("shares one agent request between concurrent lookups for the same checkout", async () => {
    const { projectId, sessionId } = await remoteSession("/srv/repo-wt/feat");
    const spy = listsWorktrees(["/srv/repo-wt/feat"]);

    const [a, b] = await Promise.all([
      resolveExecutionContext(app, { projectId, sessionId }),
      resolveExecutionContext(app, { projectId, sessionId }),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("drops the listing when Mullion itself changes a worktree on the host", async () => {
    const { hostId, projectId, sessionId } = await remoteSession("/srv/repo-wt/feat");
    const spy = listsWorktrees(["/srv/repo-wt/feat"]);

    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // The removal goes through the same seam every remote worktree change
    // does (SessionBackend's remote side).
    vi.spyOn(RemoteHostClient.prototype, "resolveRemoveListedWorktree").mockResolvedValue({
      removed: true,
    } as never);
    await resolveBackend(app, hostId).removeListedWorktree("/srv/repo", "/srv/repo-wt/feat");

    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: true,
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("drops the listing for every other remote worktree change too", async () => {
    // Each of these changes the agent's worktree list, so each must drop
    // the listing: a worktree that is gone must stop being accepted, and one
    // that was just created must start being. The agent's own replies are
    // stubbed — these tests are about WHICH changes drop the listing, not
    // about what the agent says.
    const changes: Array<{ stub: () => void; change: (hostId: string) => Promise<unknown> }> = [
      {
        stub: () =>
          vi.spyOn(RemoteHostClient.prototype, "resolveRemoveWorktree").mockResolvedValue(true),
        change: (hostId) => resolveBackend(app, hostId).removeWorktree("/srv/repo-wt/feat"),
      },
      {
        stub: () =>
          vi
            .spyOn(RemoteHostClient.prototype, "resolveRemoveWorktreeIfClean")
            .mockResolvedValue({ removed: true } as never),
        change: (hostId) =>
          resolveBackend(app, hostId).removeWorktreeIfClean("/srv/repo-wt/feat", "/srv/repo"),
      },
      {
        stub: () =>
          vi
            .spyOn(RemoteHostClient.prototype, "resolvePruneWorktrees")
            .mockResolvedValue({ removed: [] } as never),
        change: (hostId) => resolveBackend(app, hostId).pruneWorktrees("/srv/repo", []),
      },
      {
        stub: () =>
          vi
            .spyOn(RemoteHostClient.prototype, "resolveClearOrphanedTaskWorktree")
            .mockResolvedValue({ cleared: false } as never),
        change: (hostId) =>
          resolveBackend(app, hostId).clearOrphanedTaskWorktree(
            "/srv/repo",
            "/srv/repo-wt/feat",
            "mullion/task-1",
          ),
      },
      {
        stub: () =>
          vi.spyOn(RemoteHostClient.prototype, "resolveResumeTaskWorktree").mockResolvedValue(null),
        change: (hostId) =>
          resolveBackend(app, hostId).resumeTaskWorktree("/srv/repo", "mullion/task-1"),
      },
      {
        stub: () =>
          vi
            .spyOn(RemoteHostClient.prototype, "resolveCheckoutBranchWorktree")
            .mockResolvedValue(null),
        change: (hostId) => resolveBackend(app, hostId).checkoutBranchWorktree("/srv/repo", "main"),
      },
    ];

    for (const { stub, change } of changes) {
      // A host of its own per change: the listing is cached per host, so a
      // shared one would carry the previous iteration's cache over.
      const { hostId, projectId, sessionId } = await remoteSession("/srv/repo-wt/feat");
      const spy = listsWorktrees(["/srv/repo-wt/feat"]);
      expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
        ok: true,
      });
      expect(spy).toHaveBeenCalledTimes(1);

      stub();
      await change(hostId);

      // The listing was dropped, so the next lookup asks the agent again.
      expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
        ok: true,
      });
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    }
  });

  it("does not cache a failure: the next request asks the agent again", async () => {
    const { projectId, sessionId } = await remoteSession("/srv/repo-wt/feat");
    const spy = vi
      .spyOn(RemoteHostClient.prototype, "resolveGitBranches")
      .mockRejectedValue(new HostRequestError("nf", 404, ""));

    const first = await resolveExecutionContext(app, { projectId, sessionId });
    expect(first).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(spy).toHaveBeenCalledTimes(1);

    const second = await resolveExecutionContext(app, { projectId, sessionId });
    expect(second).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a listing fetched under different host credentials", async () => {
    const { hostId, projectId, sessionId } = await remoteSession("/srv/repo-wt/feat");
    const spy = listsWorktrees(["/srv/repo-wt/feat"]);

    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // The host's credentials rotate: the listing may now come from a
    // different agent, so it must not be reused.
    app.db.update(hosts).set({ authTokenEnc: "rotated" }).where(eq(hosts.id, hostId)).run();

    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: true,
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a listing once the host's session credential expires", async () => {
    const { hostId, projectId, sessionId } = await remoteSession("/srv/repo-wt/feat");
    const spy = listsWorktrees(["/srv/repo-wt/feat"]);

    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // The session credential lapses: the agent now answers with a different
    // one, so the listing fetched under the old one is not reused.
    app.db
      .update(hosts)
      .set({ sessionExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(hosts.id, hostId))
      .run();

    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: true,
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("tolerates an invalidation for a host it has never listed", () => {
    // Nothing is cached for this host, so there is nothing to drop — the
    // call must be a no-op rather than an error.
    expect(() => invalidateRemoteWorktreeCache(app, "never-listed")).not.toThrow();
  });
});
