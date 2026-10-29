import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq, ne } from "drizzle-orm";
import { hosts, projects, sessions } from "../../src/db/schema.js";

// Never lets a real systemd-run fire (#1137): node-pty and node:child_process's
// spawn are faked, and every resolveBackend() call is replaced with a fake
// backend that records WHICH host it was asked for.
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

// Issue #1951 — a caller can NAME the host (or platform) a session runs on.
// Unlike automatic placement, a target is a hard requirement: when nothing
// eligible matches it is refused, never silently sent to the project's host.

const tmpDb = path.join(os.tmpdir(), `launch-host-target-${process.pid}.db`);
const LOCAL_CWD = "/tmp/proj";
const REMOTE_CWD = "/Users/dev/proj";
const WT = "/Users/dev/proj/.mullion-worktrees/session-1";

describe("launcher host target: placement:auto and targetHostId (issue #2237)", () => {
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
    app.db.delete(hosts).where(ne(hosts.id, "local")).run();
  });

  function fakeBackend() {
    const asked: string[] = [];
    return {
      asked,
      createWorktree: vi.fn(async () => ({ created: true, path: WT, branch: "mullion/child-x" })),
      removeWorktree: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
      terminate: vi.fn().mockResolvedValue(undefined),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn().mockResolvedValue({}),
      // A dock preview checks out an EXISTING branch, detached.
      checkoutBranchWorktree: vi.fn(async () => ({ path: WT })),
    };
  }

  /**
   * A PINNED project (the default — the point is that a target works
   * regardless of the placement mode) and a Mac agent host that is online,
   * with a capacity reading, and — unless `mapped: false` — mapped for it.
   */
  async function setup(options: { mapped?: boolean; platform?: string } = {}) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: `p-${Math.random()}`,
        cwd: LOCAL_CWD,
      },
    });
    const projectId = project.json().id as number;

    const hostRes = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "mac-agent", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = hostRes.json().id as string;
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, {
      platform: options.platform ?? "darwin",
      logicalCores: 8,
      loadAverage1m: 0.2,
      memory: { totalBytes: 1000, freeBytes: 500 },
      sessions: { tracked: 0, alive: 0 },
    });
    if (options.mapped !== false) {
      app.db
        .update(projects)
        .set({ hostCwds: JSON.stringify({ [hostId]: REMOTE_CWD }) })
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

    return { projectId, hostId, backend };
  }

  it("POST placement:auto applies Auto to one launch and leaves the project's stored mode alone (issue #2237)", async () => {
    const { projectId } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", placement: "auto" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().placementReason).not.toMatch(/^pinned to/);
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    expect(project.placement).toBe("pinned");
  });

  it("POST placement:auto is mutually exclusive with targetHostId/targetPlatform (issue #2237)", async () => {
    const { projectId, hostId } = await setup();
    for (const extra of [{ targetHostId: hostId }, { targetPlatform: "darwin" }]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", placement: "auto", ...extra },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(app.db.select().from(sessions).all()).toHaveLength(0);
  });

  it("placement:auto is refused alongside an explicit hostId (issue #2237)", async () => {
    const { projectId, hostId } = await setup();
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      placement: "auto",
      hostId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid-options");
  });

  it("POST targetHostId for a host with no path for the project is a 409 (issue #2237)", async () => {
    const { projectId, hostId } = await setup({ mapped: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", targetHostId: hostId },
    });
    expect(res.statusCode).toBe(409);
  });
});
