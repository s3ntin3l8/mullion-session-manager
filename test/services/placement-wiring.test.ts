import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq, ne } from "drizzle-orm";
import { hosts, projects, sessions } from "../../src/db/schema.js";

// M5 — never lets a real systemd-run fire (#1137): both node-pty and
// node:child_process's spawn are faked, and every resolveBackend() call is
// replaced with a fake backend that records WHICH host it was asked for.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { createSessionRecord } = await import("../../src/services/session-lifecycle.js");
const { resolveTaskWorkerHost } = await import("../../src/services/session-live-info.js");

// Issue #1724 / roadmap 8.10 — the placement policy's EFFECT.
//
// #1723 shipped the decision (services/placement.ts); this file checks what
// happens when a session is actually created: the session runs on the
// decided host, its worktree is cut THERE, and the row records why.
//
// The important invariant is the one physics forces: a session runs in a
// directory, so the host and the directory have to agree. The worktree
// follows the session, and the project root on the placement host comes from
// the operator's per-host map (`projects.hostCwds`).

const tmpDb = path.join(os.tmpdir(), `placement-wiring-${process.pid}.db`);
const LOCAL_CWD = "/tmp/proj";
const REMOTE_CWD = "/srv/repo";
const WT = "/srv/repo/.mullion-worktrees/session-1";
const BRANCH = "mullion/session-1";

describe("placement decides where a session runs (issue #1724)", () => {
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
    // A clean slate per test: the app is shared (a second buildApp() would
    // fight the first one over the hooks socket), so the rows are.
    app.db.delete(sessions).run();
    app.db.delete(projects).run();
    app.db.delete(hosts).where(ne(hosts.id, "local")).run();
  });

  /** A backend that records the host it was asked for. */
  function fakeBackend() {
    const asked: string[] = [];
    const backend = {
      asked,
      createWorktree: vi.fn(async (baseCwd: string) => {
        asked.push(baseCwd);
        return { created: true, path: WT, branch: BRANCH };
      }),
      removeWorktree: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
      terminate: vi.fn().mockResolvedValue(undefined),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn().mockResolvedValue({}),
    };
    return backend;
  }

  async function setup(options: { placement?: "pinned" | "auto"; hostCwds?: string | null } = {}) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: `p-${Math.random()}`, cwd: LOCAL_CWD },
    });
    const projectId = project.json().id as number;

    // A remote host that is online and idle — the one an "auto" project
    // would be placed on.
    const hostRes = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "idle-agent", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = hostRes.json().id as string;
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, {
      platform: "linux",
      logicalCores: 8,
      loadAverage1m: 0.2,
      memory: { totalBytes: 1000, freeBytes: 500 },
      sessions: { tracked: 0, alive: 0 },
    });

    if (options.placement !== undefined) {
      app.db
        .update(projects)
        .set({ placement: options.placement, hostCwds: options.hostCwds ?? null })
        .where(eq(projects.id, projectId))
        .run();
    }

    const backend = fakeBackend();
    vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation(((
      _app: unknown,
      hostIdArg: string,
    ) => {
      backend.asked.push(`host:${hostIdArg}`);
      return backend as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>;
    }) as unknown as typeof sessionBackendModule.resolveBackend);

    return { app, projectId, hostId, backend };
  }

  it("puts an AUTO project's session on the decided host, and records why", async () => {
    const { app, projectId, hostId } = await setup({ placement: "auto" });
    const map = JSON.stringify({ [hostId]: REMOTE_CWD });
    app.db.update(projects).set({ hostCwds: map }).where(eq(projects.id, projectId)).run();

    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      // Unattended: a Task Master worker — no local bonus, so the idle
      // remote host wins.
      unattended: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The row records the host the session actually runs on...
    const row = app.db.select().from(sessions).where(eq(sessions.id, res.row.id)).all()[0];
    expect(row.hostId).toBe(hostId);
    // ...and why, in words.
    expect(row.placementReason).toMatch(/least loaded/);
  });

  it("cuts the worktree on the PLACEMENT host, from the project root THERE", async () => {
    // The worktree follows the session: the scope runs on the remote host,
    // so its directory has to be on the remote host too — and cut from the
    // project root AS IT IS THERE (`projects.hostCwds`), not the local one.
    const { app, projectId, hostId, backend } = await setup({ placement: "auto" });
    app.db
      .update(projects)
      .set({ hostCwds: JSON.stringify({ [hostId]: REMOTE_CWD }) })
      .where(eq(projects.id, projectId))
      .run();

    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      unattended: true,
      worktree: { baseRef: "main", branchName: BRANCH },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The backend was asked for the REMOTE host...
    expect(backend.asked).toContain(`host:${hostId}`);
    // ...and the worktree was cut from the remote host's project root.
    expect(backend.createWorktree).toHaveBeenCalledWith(REMOTE_CWD, "main", BRANCH, BRANCH);
  });

  it("leaves a PINNED project exactly where it was", async () => {
    const { app, projectId, hostId, backend } = await setup({ placement: "pinned" });
    app.db
      .update(projects)
      .set({ hostCwds: JSON.stringify({ [hostId]: REMOTE_CWD }) })
      .where(eq(projects.id, projectId))
      .run();

    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      unattended: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = app.db.select().from(sessions).where(eq(sessions.id, res.row.id)).all()[0];
    expect(row.hostId).toBe("local");
    expect(row.placementReason).toMatch(/pinned/);
    expect(backend.asked).not.toContain(`host:${hostId}`);
  });

  it("falls back to the project's host when the remote does not have the project", async () => {
    // No map entry → the remote host is not a candidate → the session goes
    // where it would have gone anyway, and the reason says so.
    const { app, projectId } = await setup({ placement: "auto" });

    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      unattended: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = app.db.select().from(sessions).where(eq(sessions.id, res.row.id)).all()[0];
    expect(row.hostId).toBe("local");
  });

  it("refuses a caller-supplied host the project is not on, rather than using a path that is not there", async () => {
    // A host the project is not on has no directory for the session, and
    // the project's own path is not an answer — it does not exist there.
    // So the create is refused, with a reason.
    const { app, projectId, hostId } = await setup({ placement: "auto" });
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      unattended: true,
      hostId,
      // No cwd of the caller's own: there is nothing to run in.
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("host-unknown-project");
  });

  it("honours a caller-supplied host — the placement policy is not consulted", async () => {
    // Task Master's reviewer and rebase worker must run where the task's
    // worktree is, which is not a decision the policy gets to make.
    const { app, projectId, hostId, backend } = await setup({ placement: "auto" });
    app.db
      .update(projects)
      .set({ hostCwds: JSON.stringify({ [hostId]: REMOTE_CWD }) })
      .where(eq(projects.id, projectId))
      .run();

    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      unattended: true,
      hostId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = app.db.select().from(sessions).where(eq(sessions.id, res.row.id)).all()[0];
    expect(row.hostId).toBe(hostId);
    expect(row.placementReason).toMatch(/caller/);
    expect(backend.asked).toContain(`host:${hostId}`);
  });
});

describe("a task's sessions share one host (issue #1724)", () => {
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

  it("resolves the host from the worker session's own row", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p", cwd: LOCAL_CWD },
    });
    const projectId = project.json().id as number;

    // A worker session that was PLACED on a remote host.
    const inserted = app.db
      .insert(sessions)
      .values({
        projectId,
        command: "bash",
        hostId: "remote-placed",
        status: "active",
      })
      .returning()
      .all()[0];

    expect(resolveTaskWorkerHost(app, { sessionId: inserted.id, projectId })).toBe("remote-placed");
    // A task whose worker never ran falls back to the project's host.
    expect(resolveTaskWorkerHost(app, { sessionId: null, projectId })).toBe("local");
  });
});
