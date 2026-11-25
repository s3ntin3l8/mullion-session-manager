import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { previews, projects, sessions } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

// Issue #3428 — a REMOTE project's branch preview, through POST /api/previews:
// the dock controls, the branch, the stale worktree and the port all go to the
// project's agent (scripted below; a method the test does not script rejects
// like an unreachable host), and the dock session is targeted at that host.
// The project's cwd does not exist on this machine, so a stray local git or
// filesystem step would fail the flow rather than pass silently.
const agent = vi.hoisted(() => ({
  scripted: {} as Record<string, (...args: unknown[]) => unknown>,
  calls: [] as { method: string; args: unknown[] }[],
}));
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  const client = new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        async (...args: unknown[]) => {
          agent.calls.push({ method, args });
          const fn = agent.scripted[method];
          if (!fn)
            throw new actual.HostUnreachableError(
              "scripted-agent",
              new Error(`${method} not scripted`),
            );
          return fn(...args);
        },
    },
  );
  return { ...actual, getRemoteHostClient: () => client };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const lifecycle = await import("../../src/services/session-lifecycle.js");
const sessionBackend = await import("../../src/services/session-backend.js");
const sessionBrowsers = await import("../../src/services/session-browsers.js");
const { HostRequestError } = await import("../../src/services/remote-host-client.js");
const { dockPreviewWorktreePath } = await import("../../src/services/git-worktree.js");
const { bindBranchPreview, upsertBranchPreview } =
  await import("../../src/services/preview-registry.js");

const tmpDb = path.join(os.tmpdir(), `previews-remote-branch-test-${process.pid}.db`);
const REMOTE_CWD = "/remote/does-not-exist/repo";

describe("branch previews on a remote host (#3428)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_BASE_HOST = "preview.example.com";
    app = await buildApp();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    agent.scripted = {};
    agent.calls = [];
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
  });

  async function remoteProject() {
    const hostRes = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: `bp-host-${++n}`, baseUrl: "http://127.0.0.1:1", token: "t".repeat(24) },
    });
    const hostId = hostRes.json().id as string;
    const [row] = app.db
      .insert(projects)
      .values({ name: `bp-${n}`, cwd: REMOTE_CWD, hostId })
      .returning()
      .all();
    return { projectId: row.id, hostId };
  }

  /** The agent's happy path; a test overrides one step. */
  function scriptAgent(port = 41234) {
    agent.scripted = {
      resolveDock: () => [{ id: "web", title: "Web", command: "vite --port $PORT" }],
      ensureGitBranch: () => true,
      resolveClearStalePreviewWorktree: (_cwd: unknown, name: unknown) => ({
        outcome: "absent",
        worktreePath: `${REMOTE_CWD}/.mullion-worktrees/${String(name)}`,
      }),
      allocatePreviewPort: () => port,
    };
  }

  /** Stands in for the real create (no PTY may spawn): inserts the row it would. */
  function fakeCreate(hostId: string) {
    return vi.spyOn(lifecycle, "createSessionRecord").mockImplementation(async (_a, params) => {
      const row = app.db
        .insert(sessions)
        .values({
          projectId: params.projectId,
          command: params.command,
          kind: params.kind,
          hostId,
          status: "active",
        })
        .returning()
        .get();
      return { ok: true, row, project: {} as never };
    });
  }

  const start = (projectId: number, branch = "feat/x") =>
    app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId, branch },
    });

  const calls = (method: string) => agent.calls.filter((c) => c.method === method);

  it("prepares the branch, worktree and port on the agent and targets the session there", async () => {
    const { projectId, hostId } = await remoteProject();
    // A port already bound to a branch preview on this host is passed as taken.
    const other = upsertBranchPreview(app, projectId, "feat/other");
    const holder = app.db
      .insert(sessions)
      .values({ projectId, command: "x", kind: "dock", hostId, status: "active" })
      .returning()
      .get();
    bindBranchPreview(app, other.slug, { sessionId: holder.id, upstreamPort: 40001 });
    scriptAgent(41234);
    const create = fakeCreate(hostId);

    const res = await start(projectId);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ branch: "feat/x", upstreamPort: 41234 });
    expect(calls("resolveDock")[0].args).toEqual([REMOTE_CWD]);
    expect(calls("ensureGitBranch")[0].args).toEqual([REMOTE_CWD, "feat/x", {}]);
    // The directory's name: the agent resolves it under its own checkout.
    expect(calls("resolveClearStalePreviewWorktree")[0].args).toEqual([
      REMOTE_CWD,
      path.basename(dockPreviewWorktreePath(REMOTE_CWD, "feat/x")),
    ]);
    expect([...(calls("allocatePreviewPort")[0].args[0] as Set<number>)]).toContain(40001);
    const params = create.mock.calls[0][1];
    expect(params.target).toBeUndefined();
    expect(params).toMatchObject({
      projectId,
      hostId,
      kind: "dock",
      command: "vite --port $PORT",
      worktree: { branch: "feat/x" },
      env: { PORT: "41234" },
    });
  });

  it("fast-forwards a PR's head branch on the agent", async () => {
    const { projectId, hostId } = await remoteProject();
    scriptAgent();
    fakeCreate(hostId);
    const { getOrCreateBranchPreview } = await import("../../src/services/branch-preview.js");
    await getOrCreateBranchPreview(app, projectId, "feat/pr", { fastForward: true });
    expect(calls("ensureGitBranch").map((c) => c.args[2])).toEqual([{ fastForward: true }, {}]);
  });

  it("refuses a branch the agent's checkout and origin don't have", async () => {
    const { projectId, hostId } = await remoteProject();
    scriptAgent();
    agent.scripted.ensureGitBranch = () => false;
    const create = fakeCreate(hostId);
    const res = await start(projectId, "feat/nowhere");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "unknown_branch" });
    expect(create).not.toHaveBeenCalled();
  });

  it("answers an unreachable host as host_unavailable, never as an unknown branch", async () => {
    const { projectId, hostId } = await remoteProject();
    scriptAgent();
    delete agent.scripted.ensureGitBranch;
    const create = fakeCreate(hostId);
    const res = await start(projectId);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "host_unavailable" });
    expect(create).not.toHaveBeenCalled();
  });

  it("answers an agent without the routes as host_unsupported, with the update hint", async () => {
    const { projectId, hostId } = await remoteProject();
    scriptAgent();
    agent.scripted.ensureGitBranch = () => {
      throw new HostRequestError(hostId, 404, "Not Found");
    };
    fakeCreate(hostId);
    const res = await start(projectId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "host_unsupported" });
    expect(res.json().message).toMatch(/update/i);
  });

  it("answers an agent that rejects the request as host_refused, not as a retryable outage", async () => {
    const { projectId, hostId } = await remoteProject();
    scriptAgent();
    agent.scripted.ensureGitBranch = () => {
      throw new HostRequestError(hostId, 400, "cwd must be within this agent's PROJECTS_ROOTS");
    };
    fakeCreate(hostId);
    const res = await start(projectId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "host_refused" });
    expect(res.json().message).toMatch(/PROJECTS_ROOTS/);
  });

  it("says why the session could not start on the project's host", async () => {
    const { projectId } = await remoteProject();
    scriptAgent();
    vi.spyOn(lifecycle, "createSessionRecord").mockResolvedValue({
      ok: false,
      reason: "spawn-failed",
      detail: "cwd does not exist",
    } as never);
    const res = await start(projectId);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "start_failed" });
    expect(res.json().message).toContain("spawn-failed: cwd does not exist");
  });

  it("works for a remote project whose cwd is stored as ~/…", async () => {
    const { projectId, hostId } = await remoteProject();
    app.db.update(projects).set({ cwd: "~/code/repo" }).where(eq(projects.id, projectId)).run();
    const agentPath = `/home/agent/code/repo/.mullion-worktrees/${path.basename(
      dockPreviewWorktreePath("~/code/repo", "feat/x"),
    )}`;
    // A live session the agent recorded at its own expanded path refuses ...
    const live = app.db
      .insert(sessions)
      .values({
        projectId,
        command: "vite",
        kind: "dock",
        cwd: agentPath,
        hostId,
        status: "active",
      })
      .returning()
      .get();
    vi.spyOn(sessionBackend, "resolveBackend").mockReturnValue({
      liveness: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "alive"])),
    } as unknown as ReturnType<typeof sessionBackend.resolveBackend>);
    scriptAgent();
    const create = fakeCreate(hostId);
    expect((await start(projectId)).json()).toMatchObject({ code: "worktree_busy" });
    expect(create).not.toHaveBeenCalled();
    // ... and once it is gone the preview starts, the agent naming the path.
    app.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, live.id)).run();
    const res = await start(projectId);
    expect(res.statusCode).toBe(201);
    expect(calls("resolveClearStalePreviewWorktree").at(-1)!.args[0]).toBe("~/code/repo");
  });

  it("answers an agent rejecting the dock read (cwd outside its roots) as host_refused", async () => {
    const { projectId, hostId } = await remoteProject();
    scriptAgent();
    agent.scripted.resolveDock = () => {
      throw new HostRequestError(hostId, 400, "cwd must be within this agent's PROJECTS_ROOTS");
    };
    fakeCreate(hostId);
    const res = await start(projectId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "host_refused" });
    expect(calls("ensureGitBranch")).toHaveLength(0);
  });

  /** A live session at `sessionCwd` on the host, for a project whose cwd is `projectCwd`. */
  async function occupied(projectCwd: string, sessionCwd: string) {
    const { projectId, hostId } = await remoteProject();
    app.db.update(projects).set({ cwd: projectCwd }).where(eq(projects.id, projectId)).run();
    app.db
      .insert(sessions)
      .values({
        projectId,
        command: "vite",
        kind: "dock",
        cwd: sessionCwd,
        hostId,
        status: "active",
      })
      .run();
    vi.spyOn(sessionBackend, "resolveBackend").mockReturnValue({
      liveness: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "alive"])),
    } as unknown as ReturnType<typeof sessionBackend.resolveBackend>);
    scriptAgent();
    fakeCreate(hostId);
    return (await start(projectId)).json() as { code?: string; branch?: string };
  }
  const nameOf = (branch: string) => path.basename(dockPreviewWorktreePath("/x", branch));

  it("treats a session in the home directory's preview worktree as an occupant of a bare ~ project", async () => {
    expect(await occupied("~", `/home/agent/.mullion-worktrees/${nameOf("feat/x")}`)).toMatchObject(
      { code: "worktree_busy" },
    );
  });

  it("matches a Windows checkout's preview worktree by win32 rules, and not another checkout's", async () => {
    expect(
      await occupied("C:\\work\\proj", `c:\\Work\\proj\\.mullion-worktrees\\${nameOf("feat/x")}`),
    ).toMatchObject({ code: "worktree_busy" });
    expect(
      await occupied("C:\\work\\proj", `D:\\other\\.mullion-worktrees\\${nameOf("feat/x")}`),
    ).toMatchObject({ branch: "feat/x" });
  });

  it("does not hand two concurrent creates on one host the same port", async () => {
    const { projectId, hostId } = await remoteProject();
    scriptAgent();
    // The agent's allocator: the lowest of two ports not in `taken`, answered
    // after a delay, as a round trip would.
    agent.scripted.allocatePreviewPort = async (taken: unknown) => {
      await new Promise((r) => setTimeout(r, 20));
      return [43000, 43001].find((p) => !(taken as Set<number>).has(p)) ?? null;
    };
    fakeCreate(hostId);
    const [a, b] = await Promise.all([start(projectId, "feat/a"), start(projectId, "feat/b")]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(new Set([a.json().upstreamPort, b.json().upstreamPort])).toEqual(
      new Set([43000, 43001]),
    );
  });

  it("answers an unreadable dock config as host_unavailable", async () => {
    const { projectId, hostId } = await remoteProject();
    scriptAgent();
    delete agent.scripted.resolveDock;
    fakeCreate(hostId);
    const res = await start(projectId);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "host_unavailable" });
    expect(calls("ensureGitBranch")).toHaveLength(0);
  });

  it("refuses when the agent has no free port, or can't be asked for one", async () => {
    const { projectId, hostId } = await remoteProject();
    scriptAgent();
    agent.scripted.allocatePreviewPort = () => null;
    const create = fakeCreate(hostId);
    expect((await start(projectId)).json()).toMatchObject({ code: "start_failed" });
    delete agent.scripted.allocatePreviewPort;
    expect((await start(projectId)).json()).toMatchObject({ code: "host_unavailable" });
    expect(create).not.toHaveBeenCalled();
  });

  describe("a leftover preview worktree on the agent", () => {
    it("is cleared there and its browsers released when no live session runs in it", async () => {
      const { projectId, hostId } = await remoteProject();
      const wt = dockPreviewWorktreePath(REMOTE_CWD, "feat/x");
      app.db
        .insert(sessions)
        .values({ projectId, command: "vite", kind: "dock", cwd: wt, hostId, status: "active" })
        .run();
      vi.spyOn(sessionBackend, "resolveBackend").mockReturnValue({
        liveness: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "dead"])),
      } as unknown as ReturnType<typeof sessionBackend.resolveBackend>);
      const release = vi.spyOn(sessionBrowsers, "closeCheckoutBrowsers").mockResolvedValue();
      scriptAgent();
      agent.scripted.resolveClearStalePreviewWorktree = () => ({
        outcome: "removed",
        worktreePath: wt,
      });
      const lifecycleWorktree = await import("../../src/services/git-worktree.js");
      // A dead session's tracked entry for the path goes too.
      const deadTracked = app.db
        .insert(sessions)
        .values({ projectId, command: "vite", kind: "dock", cwd: wt, hostId, status: "exited" })
        .returning()
        .get();
      lifecycleWorktree.trackPreviewWorktree(deadTracked.id, {
        worktreePath: wt,
        branch: "feat/x",
        worktreeRefresh: false,
        parentCwd: REMOTE_CWD,
        projectId,
      } as never);
      fakeCreate(hostId);
      expect((await start(projectId)).statusCode).toBe(201);
      expect(release.mock.calls.map((c) => c.slice(1))).toEqual([[projectId, hostId, wt]]);
      expect(lifecycleWorktree.getPreviewWorktree(deadTracked.id)).toBeUndefined();
    });

    it("is refused, and not touched, while a live session runs in it", async () => {
      const { projectId, hostId } = await remoteProject();
      const wt = dockPreviewWorktreePath(REMOTE_CWD, "feat/x");
      app.db
        .insert(sessions)
        .values({ projectId, command: "vite", kind: "dock", cwd: wt, hostId, status: "active" })
        .run();
      vi.spyOn(sessionBackend, "resolveBackend").mockReturnValue({
        liveness: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "alive"])),
      } as unknown as ReturnType<typeof sessionBackend.resolveBackend>);
      scriptAgent();
      const create = fakeCreate(hostId);
      const res = await start(projectId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "worktree_busy" });
      expect(calls("resolveClearStalePreviewWorktree")).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
    });

    it("is refused while a live session of ANOTHER project row on this checkout runs in it", async () => {
      const { projectId, hostId } = await remoteProject();
      const [twin] = app.db
        .insert(projects)
        .values({ name: `twin-${projectId}`, cwd: REMOTE_CWD, hostId })
        .returning()
        .all();
      const wt = dockPreviewWorktreePath(REMOTE_CWD, "feat/x");
      app.db
        .insert(sessions)
        .values({ projectId: twin.id, command: "vite", kind: "dock", cwd: wt, status: "active" })
        .run();
      vi.spyOn(sessionBackend, "resolveBackend").mockReturnValue({
        liveness: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "alive"])),
      } as unknown as ReturnType<typeof sessionBackend.resolveBackend>);
      scriptAgent();
      const create = fakeCreate(hostId);
      expect((await start(projectId)).json()).toMatchObject({ code: "worktree_busy" });
      expect(calls("resolveClearStalePreviewWorktree")).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
    });

    it("is refused when the agent could not remove it", async () => {
      const { projectId, hostId } = await remoteProject();
      scriptAgent();
      agent.scripted.resolveClearStalePreviewWorktree = () => ({ outcome: "not-removed" });
      const create = fakeCreate(hostId);
      const res = await start(projectId);
      expect(res.json()).toMatchObject({ code: "worktree_busy" });
      expect(create).not.toHaveBeenCalled();
    });

    it("maps the agent's invalid-path outcome (a 200) to an invalid branch", async () => {
      const { projectId, hostId } = await remoteProject();
      scriptAgent();
      agent.scripted.resolveClearStalePreviewWorktree = () => ({ outcome: "invalid-path" });
      fakeCreate(hostId);
      const res = await start(projectId);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid_branch" });
    });
  });

  it("binds the preview row to the remote session and port", async () => {
    const { projectId, hostId } = await remoteProject();
    scriptAgent(42000);
    fakeCreate(hostId);
    const res = await start(projectId, "feat/bound");
    const [row] = app.db.select().from(previews).where(eq(previews.slug, res.json().slug)).all();
    expect(row.upstreamPort).toBe(42000);
    const [bound] = app.db.select().from(sessions).where(eq(sessions.id, row.sessionId!)).all();
    expect(bound.hostId).toBe(hostId);
  });
});
