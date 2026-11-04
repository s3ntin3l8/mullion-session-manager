import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { projects, sessions } from "../../src/db/schema.js";
import { HostRequestError, RemoteHostClient } from "../../src/services/remote-host-client.js";

// Issue #2570 — the git routes take an optional `?sessionId=` and then act on
// that session's host and checkout (the execution-context resolver), never on
// the project's, and never fall back to the project after a session failure.
const tmpDb = path.join(os.tmpdir(), `projects-session-git-test-${process.pid}.db`);

type Spied = { hostId: string };
const hostOf = (client: unknown) => (client as Spied).hostId;

describe("session-scoped git routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;

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
  afterEach(() => vi.restoreAllMocks());

  async function addHost(baseUrl: string | null = "http://127.0.0.1:1") {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: `sg-host-${++n}`,
        ...(baseUrl === null ? {} : { baseUrl }),
        token: "t".repeat(24),
      },
    });
    return res.json().id as string;
  }
  function addProject(cwd: string, hostId: string, hostCwds?: Record<string, string>) {
    return app.db
      .insert(projects)
      .values({
        name: `sg-${++n}`,
        cwd,
        hostId,
        hostCwds: hostCwds ? JSON.stringify(hostCwds) : null,
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
  const status = { isRepo: true, status: { branch: "main" } };

  it("sends a session's git-status to its own host when two hosts share a path", async () => {
    const a = await addHost();
    const b = await addHost();
    const projectId = addProject("/work/p", a, { [b]: "/work/p" });
    const onA = addSession(projectId, "/work/p", a);
    const onB = addSession(projectId, "/work/p", b);
    const calls: { host: string; cwd: string }[] = [];
    vi.spyOn(RemoteHostClient.prototype, "resolveGitStatus").mockImplementation(function (
      this: unknown,
      cwd: string,
    ) {
      calls.push({ host: hostOf(this), cwd });
      return Promise.resolve(status as never);
    });
    for (const id of [onA, onB]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/git-status?sessionId=${id}`,
      });
      expect(res.statusCode).toBe(200);
    }
    expect(calls).toEqual([
      { host: a, cwd: "/work/p" },
      { host: b, cwd: "/work/p" },
    ]);
  });

  it("without a sessionId keeps the project's host and cwd", async () => {
    const a = await addHost();
    const b = await addHost();
    const projectId = addProject("/work/p", a, { [b]: "/work/p" });
    addSession(projectId, "/work/p", b);
    const spy = vi
      .spyOn(RemoteHostClient.prototype, "resolveGitStatus")
      .mockImplementation(function (this: unknown) {
        expect(hostOf(this)).toBe(a);
        return Promise.resolve(status as never);
      });
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/git-status` });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith("/work/p");
  });

  it("targets a remote sibling worktree's own directory", async () => {
    const a = await addHost();
    const projectId = addProject("/srv/repo", a);
    const sessionId = addSession(projectId, "/srv/repo-wt", null);
    vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockResolvedValue({
      branches: [],
      worktrees: [{ path: "/srv/repo-wt", branch: "feat", isMain: false }],
      remoteBranches: [],
    } as never);
    const spy = vi
      .spyOn(RemoteHostClient.prototype, "resolveGitStatus")
      .mockResolvedValue(status as never);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/git-status?sessionId=${sessionId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls[0][0]).toBe("/srv/repo-wt");
  });

  it("treats a legacy NULL-hostId session as the project's host", async () => {
    const a = await addHost();
    const projectId = addProject("/srv/repo", a);
    const sessionId = addSession(projectId, "/srv/repo/pkg", null);
    const spy = vi
      .spyOn(RemoteHostClient.prototype, "resolveGitStatus")
      .mockImplementation(function (this: unknown) {
        expect(hostOf(this)).toBe(a);
        return Promise.resolve(status as never);
      });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/git-status?sessionId=${sessionId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls[0][0]).toBe("/srv/repo/pkg");
  });

  it("answers 503 for an unavailable session host and never falls back to the project", async () => {
    const pending = await addHost(null);
    const projectId = addProject(os.tmpdir(), "local", { [pending]: "/x" });
    const sessionId = addSession(projectId, "/x", pending);
    const remote = vi.spyOn(RemoteHostClient.prototype, "resolveGitStatus");
    for (const url of [
      `/api/projects/${projectId}/git-status?sessionId=${sessionId}`,
      `/api/projects/${projectId}/git-log?sessionId=${sessionId}`,
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("host_unavailable");
    }
    const mutate = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/git-pull?sessionId=${sessionId}`,
    });
    expect(mutate.statusCode).toBe(503);
    expect(remote).not.toHaveBeenCalled();
  });

  it("answers 400 for a session of another project or a malformed id", async () => {
    const a = await addHost();
    const p1 = addProject("/srv/one", a);
    const p2 = addProject("/srv/two", a);
    const foreign = addSession(p2, "/srv/two", a);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${p1}/git-status?sessionId=${foreign}`,
    });
    expect(res.statusCode).toBe(400);
    const bad = await app.inject({
      method: "GET",
      url: `/api/projects/${p1}/git-status?sessionId=abc`,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("answers 501 when the agent can't list worktrees for a sibling session", async () => {
    const a = await addHost();
    const projectId = addProject("/srv/repo", a);
    const sessionId = addSession(projectId, "/srv/repo-wt", null);
    vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockRejectedValue(
      new HostRequestError(a, 404, ""),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/git-status?sessionId=${sessionId}`,
    });
    expect(res.statusCode).toBe(501);
  });

  it("runs a mutation only on the session's checkout, and reports an old agent as unsupported", async () => {
    const a = await addHost();
    const b = await addHost();
    const projectId = addProject("/work/p", a, { [b]: "/work/p" });
    const onB = addSession(projectId, "/work/p", b);
    const pull = vi
      .spyOn(RemoteHostClient.prototype, "resolveGitPull")
      .mockImplementationOnce(function (this: unknown) {
        expect(hostOf(this)).toBe(b);
        return Promise.resolve({ pulled: true } as never);
      });
    const ok = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/git-pull?sessionId=${onB}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ pulled: true });

    pull.mockRejectedValueOnce(new HostRequestError(b, 404, ""));
    const old = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/git-pull?sessionId=${onB}`,
    });
    expect(old.statusCode).toBe(501);
    expect(old.json().error).toBe("unsupported");
    // Only the session's host was ever asked.
    expect(pull).toHaveBeenCalledTimes(2);

    const checkout = vi
      .spyOn(RemoteHostClient.prototype, "resolveGitCheckout")
      .mockRejectedValueOnce(new HostRequestError(b, 404, ""));
    vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockResolvedValue({
      branches: [],
      worktrees: [],
      remoteBranches: [],
    } as never);
    const co = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/git-checkout?sessionId=${onB}`,
      payload: { branch: "x" },
    });
    expect(co.statusCode).toBe(501);
    expect(checkout).toHaveBeenCalledTimes(1);
  });
});
