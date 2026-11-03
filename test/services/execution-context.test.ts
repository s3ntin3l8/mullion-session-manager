import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { resolveExecutionContext } from "../../src/services/execution-context.js";
import { RemoteHostClient } from "../../src/services/remote-host-client.js";

const tmpDb = path.join(os.tmpdir(), `execution-context-test-${process.pid}.db`);

describe("resolveExecutionContext", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let root: string;
  let n = 0;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exec-ctx-")));
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
  });

  afterEach(() => vi.restoreAllMocks());

  async function addHost(opts: { platform?: string; baseUrl?: string | null } = {}) {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: `ec-host-${++n}`,
        ...(opts.baseUrl === null ? {} : { baseUrl: opts.baseUrl ?? "http://127.0.0.1:1" }),
        token: "t".repeat(24),
      },
    });
    const id = res.json().id as string;
    if (opts.platform)
      app.db.update(hosts).set({ platform: opts.platform }).where(eq(hosts.id, id)).run();
    return id;
  }

  function addProject(values: { cwd: string; hostId?: string; hostCwds?: Record<string, string> }) {
    return app.db
      .insert(projects)
      .values({
        name: `ec-${++n}`,
        cwd: values.cwd,
        hostId: values.hostId ?? "local",
        hostCwds: values.hostCwds ? JSON.stringify(values.hostCwds) : null,
      })
      .returning({ id: projects.id })
      .get().id;
  }

  function addSession(projectId: number, cwd: string | null, hostId: string | null) {
    return app.db
      .insert(sessions)
      .values({ projectId, name: "s", command: "bash", cwd, hostId })
      .returning({ id: sessions.id })
      .get().id;
  }

  it("resolves a project default to the project's host and cwd", async () => {
    const projectId = addProject({ cwd: root });
    const r = await resolveExecutionContext(app, { projectId, projectDefault: true });
    expect(r).toMatchObject({
      ok: true,
      context: { hostId: "local", cwd: root, checkoutRoot: root, source: "project-default" },
    });
  });

  it("treats a NULL hostId row as inheriting the project's host", async () => {
    const host = await addHost();
    const projectId = addProject({ cwd: "/srv/a", hostId: host });
    const sessionId = addSession(projectId, "/srv/a/pkg", null);
    const r = await resolveExecutionContext(app, { projectId, sessionId });
    expect(r).toMatchObject({
      ok: true,
      context: { hostId: host, cwd: "/srv/a/pkg", source: "session" },
    });
  });

  it("serves an Auto-placed session from its own host, even with identical paths on both hosts", async () => {
    const b = await addHost();
    const projectId = addProject({ cwd: "/work/p", hostCwds: { [b]: "/work/p" } });
    const sessionId = addSession(projectId, "/work/p", b);
    const r = await resolveExecutionContext(app, { projectId, sessionId });
    expect(r).toMatchObject({ ok: true, context: { hostId: b, cwd: "/work/p" } });
  });

  it("uses the host's own hostCwds path as the root when the paths differ", async () => {
    const b = await addHost();
    const projectId = addProject({ cwd: root, hostCwds: { [b]: "/srv/other/p" } });
    const sessionId = addSession(projectId, "/srv/other/p/sub", b);
    const r = await resolveExecutionContext(app, { projectId, sessionId });
    expect(r).toMatchObject({
      ok: true,
      context: { hostId: b, cwd: "/srv/other/p/sub", checkoutRoot: "/srv/other/p" },
    });
    // the project's own path is NOT a valid root on host B
    vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockResolvedValue({
      branches: [],
      worktrees: [],
      remoteBranches: [],
    });
    const wrong = addSession(projectId, path.join(root, "sub"), b);
    const bad = await resolveExecutionContext(app, { projectId, sessionId: wrong });
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_context" } });
  });

  it("refuses a session of another project", async () => {
    const p1 = addProject({ cwd: root });
    const p2 = addProject({ cwd: root });
    const sessionId = addSession(p2, root, null);
    const r = await resolveExecutionContext(app, { projectId: p1, sessionId });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_context" } });
  });

  it("refuses a project with no checkout on the session's host", async () => {
    const b = await addHost();
    const projectId = addProject({ cwd: root });
    const sessionId = addSession(projectId, root, b);
    const r = await resolveExecutionContext(app, { projectId, sessionId });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_context" } });
  });

  it("applies windows path rules to a win32 host", async () => {
    const w = await addHost({ platform: "win32" });
    const projectId = addProject({ cwd: root, hostCwds: { [w]: "C:\\Work\\Proj" } });
    const inside = addSession(projectId, "c:\\work\\proj\\src", w);
    const ok = await resolveExecutionContext(app, { projectId, sessionId: inside });
    expect(ok).toMatchObject({
      ok: true,
      context: { hostId: w, platform: "win32", checkoutRoot: "C:\\Work\\Proj" },
    });
    const sibling = addSession(projectId, "C:\\Work\\Proj2", w);
    vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockResolvedValue({
      branches: [],
      worktrees: [],
      remoteBranches: [],
    });
    const out = await resolveExecutionContext(app, { projectId, sessionId: sibling });
    expect(out).toMatchObject({ ok: false, error: { code: "invalid_context" } });
    const posix = addSession(projectId, "/work/proj", w);
    expect(await resolveExecutionContext(app, { projectId, sessionId: posix })).toMatchObject({
      ok: false,
    });
  });

  it("accepts a remote sibling worktree the agent lists, and refuses an unlisted one", async () => {
    const b = await addHost();
    const projectId = addProject({ cwd: "/srv/repo", hostId: b });
    vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockResolvedValue({
      branches: [],
      worktrees: [{ path: "/srv/repo-wt/feat", branch: "feat", isMain: false }] as never,
      remoteBranches: [],
    });
    const wt = addSession(projectId, "/srv/repo-wt/feat", null);
    expect(await resolveExecutionContext(app, { projectId, sessionId: wt })).toMatchObject({
      ok: true,
      context: { hostId: b, cwd: "/srv/repo-wt/feat", checkoutRoot: "/srv/repo-wt/feat" },
    });
    const other = addSession(projectId, "/srv/elsewhere", null);
    expect(await resolveExecutionContext(app, { projectId, sessionId: other })).toMatchObject({
      ok: false,
      error: { code: "invalid_context" },
    });
  });

  it("is host_unavailable when the remote host can't be reached, with no fallback", async () => {
    const b = await addHost();
    const projectId = addProject({ cwd: "/srv/repo", hostId: b });
    vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockRejectedValue(new Error("down"));
    const sessionId = addSession(projectId, "/srv/repo-wt", null);
    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: false,
      error: { code: "host_unavailable" },
    });
  });

  it("is host_unavailable for a session on a host that isn't registered or has no address", async () => {
    const pending = await addHost({ baseUrl: null });
    const projectId = addProject({ cwd: root, hostCwds: { [pending]: "/x" } });
    const sessionId = addSession(projectId, "/x", pending);
    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: false,
      error: { code: "host_unavailable" },
    });
  });

  it("is unsupported when the agent predates worktree listing", async () => {
    const { HostRequestError } = await import("../../src/services/remote-host-client.js");
    const b = await addHost();
    const projectId = addProject({ cwd: "/srv/repo", hostId: b });
    vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockRejectedValue(
      new HostRequestError("nf", 404, ""),
    );
    const sessionId = addSession(projectId, "/srv/repo-wt", null);
    expect(await resolveExecutionContext(app, { projectId, sessionId })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
  });

  it("checks symlinks and sibling git worktrees on the local host", async () => {
    const proj = path.join(root, "local-proj");
    fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), path.join(proj, "escape"));
    const projectId = addProject({ cwd: proj });
    const ok = addSession(projectId, path.join(proj, "sub"), null);
    expect(await resolveExecutionContext(app, { projectId, sessionId: ok })).toMatchObject({
      ok: true,
    });
    const esc = addSession(projectId, path.join(proj, "escape"), null);
    expect(await resolveExecutionContext(app, { projectId, sessionId: esc })).toMatchObject({
      ok: false,
      error: { code: "invalid_context" },
    });
    const gone = addSession(projectId, path.join(proj, "gone"), null);
    expect(await resolveExecutionContext(app, { projectId, sessionId: gone })).toMatchObject({
      ok: false,
    });
  });

  it("trustSessionCwd keeps the session's host but skips containment", async () => {
    const projectId = addProject({ cwd: root });
    const sessionId = addSession(projectId, "/somewhere/else", null);
    const r = await resolveExecutionContext(
      app,
      { projectId, sessionId },
      { trustSessionCwd: true },
    );
    expect(r).toMatchObject({ ok: true, context: { hostId: "local", cwd: "/somewhere/else" } });
  });
});
