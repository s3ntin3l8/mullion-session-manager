import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq, ne } from "drizzle-orm";
import { hosts, projects, sessions } from "../../src/db/schema.js";

// Never lets a real systemd-run fire (#1137): both node-pty and
// node:child_process's spawn are faked, and every resolveBackend() call is
// replaced with a fake backend that records which host it was asked for.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { LOCAL_HOST_ID } = await import("../../src/services/host-registry.js");
const { createSessionRecord } = await import("../../src/services/session-lifecycle.js");

// Issue #1958 — `promote_to_worktree` cuts the worktree and places the
// replacement session on ONE host: the host the source session runs on. The
// replacement is pinned there, so an `auto` project cannot move it away from
// the directory it was just given.

const tmpDb = path.join(os.tmpdir(), `sessions-promote-host-${process.pid}.db`);
const LOCAL_CWD = "/tmp/proj-promote-host";
const REMOTE_CWD = "/srv/promote-host";
const WORKTREE = `${REMOTE_CWD}/.mullion-worktrees/mullion-session-x`;

describe("promote lands the replacement where its worktree was cut (issue #1958)", () => {
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
  afterEach(() => {
    vi.restoreAllMocks();
    app.db.delete(sessions).run();
    app.db.delete(projects).run();
    app.db.delete(hosts).where(ne(hosts.id, LOCAL_HOST_ID)).run();
  });

  async function addHost(name: string, loadAverage1m: number): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = res.json().id as string;
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, {
      platform: "linux",
      logicalCores: 8,
      loadAverage1m,
      memory: { totalBytes: 1000, freeBytes: 500 },
      sessions: { tracked: 0, alive: 0 },
    });
    return hostId;
  }

  /**
   * One fake backend per host, created on first use, so a test can assert
   * WHICH host a call went to — not just that it happened.
   */
  function installFakeBackends(overrides: Record<string, Record<string, unknown>> = {}) {
    const byHost = new Map<string, ReturnType<typeof makeBackend>>();
    function makeBackend(hostId: string) {
      return {
        createWorktree: vi.fn().mockResolvedValue({
          created: true,
          path: WORKTREE,
          branch: "mullion/session-x",
        }),
        removeWorktree: vi.fn().mockResolvedValue(true),
        deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
        terminate: vi.fn().mockResolvedValue(undefined),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        spawn: vi.fn().mockResolvedValue({}),
        liveStatus: vi.fn().mockResolvedValue({}),
        resolvePendingPromote: vi.fn().mockResolvedValue(true),
        ...overrides[hostId],
      };
    }
    function backendFor(hostId: string) {
      let backend = byHost.get(hostId);
      if (!backend) {
        backend = makeBackend(hostId);
        byHost.set(hostId, backend);
      }
      return backend;
    }
    vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation(
      ((_app: unknown, hostIdArg: string) =>
        backendFor(hostIdArg) as unknown as ReturnType<
          typeof sessionBackendModule.resolveBackend
        >) as unknown as typeof sessionBackendModule.resolveBackend,
    );
    return { backendFor };
  }

  /** A local project with a checkout mapped on one remote host. */
  async function mappedProject(name: string, remote: string) {
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name, cwd: LOCAL_CWD },
    });
    const projectId = projectRes.json().id as number;
    app.db
      .update(projects)
      .set({ hostCwds: JSON.stringify({ [remote]: REMOTE_CWD }) })
      .where(eq(projects.id, projectId))
      .run();
    return projectId;
  }

  function sessionRow(id: number) {
    const [row] = app.db.select().from(sessions).where(eq(sessions.id, id)).all();
    return row;
  }

  it("keeps the replacement on the worktree's host when an auto project would place it elsewhere", async () => {
    // The project lives on a busy host A; an idle host B also has a checkout.
    // Left to the policy, the replacement would be scored onto B.
    const busy = await addHost("busy-agent", 7.5);
    const idle = await addHost("idle-agent", 0.1);
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "promote-auto", cwd: REMOTE_CWD, hostId: busy },
    });
    const projectId = projectRes.json().id as number;
    app.db
      .update(projects)
      .set({ hostCwds: JSON.stringify({ [idle]: "/srv/elsewhere" }) })
      .where(eq(projects.id, projectId))
      .run();
    const { backendFor } = installFakeBackends();

    // The source session is created while the project is still pinned, so it
    // runs on A; only then is the project switched to auto.
    const source = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "opencode" },
    });
    expect(source.statusCode).toBe(201);
    expect(sessionRow(source.json().id as number)?.hostId).toBe(busy);
    app.db.update(projects).set({ placement: "auto" }).where(eq(projects.id, projectId)).run();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${source.json().id}/promote`,
      payload: { baseRef: "main" },
    });

    expect(res.statusCode).toBe(201);
    const promoted = sessionRow(res.json().id as number);
    expect(promoted?.hostId).toBe(busy);
    expect(promoted?.cwd).toBe(WORKTREE);
    expect(promoted?.placementReason).toBe(`promoted on ${busy}, where its worktree was cut`);
    expect(backendFor(busy).createWorktree.mock.calls[0]?.[0]).toBe(REMOTE_CWD);
  });

  it("cuts the worktree on the source session's host when that is not the project's host", async () => {
    // A local project with a checkout on a remote host; the source session
    // runs there, so its cwd is a path on that host.
    const remote = await addHost("remote-agent", 0.2);
    const projectId = await mappedProject("promote-mapped", remote);
    const { backendFor } = installFakeBackends();

    const created = await createSessionRecord(app, {
      projectId,
      command: "opencode",
      hostId: remote,
      cwd: `${REMOTE_CWD}/packages/app`,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.row.id}/promote`,
      payload: { baseRef: "main" },
    });

    expect(res.statusCode).toBe(201);
    // The worktree is cut from the project's root ON THE REMOTE HOST — not
    // from the local project path, and not from the session's subdirectory.
    expect(backendFor(remote).createWorktree.mock.calls[0]?.[0]).toBe(REMOTE_CWD);
    expect(backendFor(LOCAL_HOST_ID).createWorktree).not.toHaveBeenCalled();
    expect(sessionRow(res.json().id as number)?.hostId).toBe(remote);
  });

  it("cleans up a failed spawn on the host the worktree was cut on", async () => {
    const remote = await addHost("cleanup-agent", 0.2);
    const projectId = await mappedProject("promote-cleanup", remote);
    const { backendFor } = installFakeBackends();

    const created = await createSessionRecord(app, {
      projectId,
      command: "opencode",
      hostId: remote,
      cwd: REMOTE_CWD,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Only now does the remote spawn start failing, so it is the PROMOTE's
    // spawn that dies — the project's own host stays healthy.
    backendFor(remote).spawn.mockRejectedValue(new Error("spawn exploded"));

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.row.id}/promote`,
      payload: { baseRef: "main" },
    });

    expect(res.statusCode).toBe(502);
    expect(backendFor(remote).removeWorktree).toHaveBeenCalledWith(WORKTREE, REMOTE_CWD);
    expect(backendFor(remote).deleteBranch).toHaveBeenCalled();
    expect(backendFor(LOCAL_HOST_ID).removeWorktree).not.toHaveBeenCalled();
  });

  it("judges seed delivery against the host the replacement runs on", async () => {
    const remote = await addHost("seed-agent", 0.2);
    const projectId = await mappedProject("promote-seed", remote);
    // A remote spawn that never echoes `initialPromptApplied` is an old build
    // dropping the field; a local one is always trusted. Using the project's
    // (local) host here would hide the warning.
    installFakeBackends({ [remote]: { spawn: vi.fn().mockResolvedValue({}) } });

    const created = await createSessionRecord(app, {
      projectId,
      command: "opencode",
      hostId: remote,
      cwd: REMOTE_CWD,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.row.id}/promote`,
      payload: { baseRef: "main", seedPrompt: "carry on" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toContain(
      "The promoted session is running, but its seed prompt could not be submitted as a first turn — it may be sitting idle until you send it a message.",
    );
  });

  it("cuts a cross-repo session from its own cwd on its host when the project has no path there", async () => {
    // Not a refusal: the session already runs in a repository of its own on
    // that host, and that is where its worktree belongs.
    const remote = await addHost("crossrepo-agent", 0.2);
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "promote-crossrepo", cwd: LOCAL_CWD },
    });
    const projectId = projectRes.json().id as number;
    const { backendFor } = installFakeBackends();

    const created = await createSessionRecord(app, {
      projectId,
      command: "opencode",
      hostId: remote,
      cwd: "/srv/other-repo",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.row.id}/promote`,
      payload: { baseRef: "main" },
    });

    expect(res.statusCode).toBe(201);
    expect(backendFor(remote).createWorktree.mock.calls[0]?.[0]).toBe("/srv/other-repo");
    // ...and the replacement is pinned to that host, not left to the project's.
    expect(sessionRow(res.json().id as number)?.hostId).toBe(remote);
  });

  it("refuses with a 409 when the project has no path on the host and the session has no cwd", async () => {
    const remote = await addHost("unmapped-agent", 0.2);
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "promote-unmapped", cwd: LOCAL_CWD },
    });
    const projectId = projectRes.json().id as number;
    installFakeBackends();

    const created = await createSessionRecord(app, {
      projectId,
      command: "opencode",
      hostId: remote,
      cwd: "/srv/anywhere",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    app.db.update(sessions).set({ cwd: null }).where(eq(sessions.id, created.row.id)).run();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.row.id}/promote`,
      payload: { baseRef: "main" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain(`no path on host ${remote}`);
  });
});
