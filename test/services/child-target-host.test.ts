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
const hostGitModule = await import("../../src/services/host-git.js");
const { createSessionRecord } = await import("../../src/services/session-lifecycle.js");
const { resolveTargetHost } = await import("../../src/services/placement.js");

// Issue #1951 — a caller can NAME the host (or platform) a session runs on.
// Unlike automatic placement, a target is a hard requirement: when nothing
// eligible matches it is refused, never silently sent to the project's host.

const tmpDb = path.join(os.tmpdir(), `child-target-host-${process.pid}.db`);
const LOCAL_CWD = "/tmp/proj";
const REMOTE_CWD = "/Users/dev/proj";
const WT = "/Users/dev/proj/.mullion-worktrees/session-1";

describe("a session can be targeted at a host or platform (issue #1951)", () => {
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
      payload: { createDir: true, name: `p-${Math.random()}`, cwd: LOCAL_CWD },
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

  it("places a session on the host a platform names, even for a pinned project", async () => {
    const { projectId, hostId, backend } = await setup();
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      target: { platform: "darwin" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = app.db.select().from(sessions).where(eq(sessions.id, res.row.id)).all()[0];
    expect(row.hostId).toBe(hostId);
    expect(row.placementReason).toMatch(/platform darwin/);
    expect(backend.asked).toContain(`host:${hostId}`);
  });

  it("matches the platform case-insensitively", async () => {
    const { projectId, hostId } = await setup();
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      target: { platform: "Darwin" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.hostId).toBe(hostId);
  });

  it("places a session on the host an id names", async () => {
    const { projectId, hostId } = await setup();
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      target: { hostId },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.hostId).toBe(hostId);
    expect(res.row.placementReason).toMatch(new RegExp(`host ${hostId}`));
  });

  it("can name the local host by its platform", async () => {
    const { projectId } = await setup();
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      target: { platform: process.platform },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.hostId).toBe("local");
  });

  it("refuses when no host of that platform exists, naming only the target", async () => {
    const { projectId, hostId } = await setup();
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      target: { platform: "win32" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no-target-host");
    if (res.reason !== "no-target-host") return;
    expect(res.detail).toBe("no eligible host matches platform win32");
    // A session-scoped caller must not learn the fleet through the refusal.
    expect(res.detail).not.toContain(hostId);
    expect(app.db.select().from(sessions).all()).toHaveLength(0);
  });

  it("refuses a host the project is not mapped on, rather than using a path that is not there", async () => {
    const { projectId, hostId } = await setup({ mapped: false });
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      target: { hostId },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no-target-host");
  });

  it("refuses a drained host", async () => {
    const { projectId, hostId } = await setup();
    app.db.update(hosts).set({ drained: true }).where(eq(hosts.id, hostId)).run();
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      target: { hostId },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no-target-host");
  });

  it("refuses an offline host", async () => {
    const { projectId, hostId } = await setup();
    app.hostHeartbeatTracker?.recordFailure(hostId);
    app.hostHeartbeatTracker?.recordFailure(hostId);
    app.hostHeartbeatTracker?.recordFailure(hostId);
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      target: { hostId },
    });
    expect(res.ok).toBe(false);
  });

  it("falls back to the host's cached capacity platform when the host row has none", async () => {
    // A manually-added host never self-reports `hosts.platform`; the capacity
    // poll still knows it.
    const { projectId, hostId } = await setup({ platform: "darwin" });
    expect(app.db.select().from(hosts).where(eq(hosts.id, hostId)).all()[0].platform).toBeNull();
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      target: { platform: "darwin" },
    });
    expect(res.ok).toBe(true);
  });

  it("prefers the host row's self-reported platform", async () => {
    const { projectId, hostId } = await setup({ platform: "linux" });
    app.db.update(hosts).set({ platform: "darwin" }).where(eq(hosts.id, hostId)).run();
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      target: { platform: "darwin" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.hostId).toBe(hostId);
  });

  it("resolveTargetHost reports ok:false instead of throwing when the candidates cannot be read", async () => {
    const { projectId } = await setup();
    const project = app.db.select().from(projects).where(eq(projects.id, projectId)).all()[0];
    const spy = vi.spyOn(app.hostCapacityTracker!, "get").mockImplementation(() => {
      throw new Error("tracker exploded");
    });
    const res = resolveTargetHost(app, {
      project: {
        hostId: project.hostId,
        placement: project.placement,
        cwd: project.cwd,
        hostCwds: project.hostCwds,
      },
      target: { platform: "darwin" },
      unattended: false,
    });
    spy.mockRestore();
    expect(res).toEqual({ ok: false, detail: "no eligible host matches platform darwin" });
  });

  describe("isolate", () => {
    it("cuts the worktree on the placement host, off a base ref resolved THERE", async () => {
      const { projectId, hostId, backend } = await setup();
      const baseSpy = vi
        .spyOn(hostGitModule, "resolveHostBaseRef")
        .mockResolvedValue({ ok: true, value: { baseRef: "origin/main", sha: "abc123" } });

      const res = await createSessionRecord(app, {
        projectId,
        command: "bash",
        target: { platform: "darwin" },
        isolate: true,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // The base ref was resolved on the host the session was placed on, in
      // that host's path for the project — not the project's own host.
      expect(baseSpy).toHaveBeenCalledWith(app, hostId, REMOTE_CWD);
      expect(backend.createWorktree).toHaveBeenCalledTimes(1);
      const [baseCwd, baseRef] = backend.createWorktree.mock.calls[0] as unknown as [
        string,
        string,
      ];
      expect(baseCwd).toBe(REMOTE_CWD);
      expect(baseRef).toBe("origin/main");
      expect(res.row.cwd).toBe(WT);
      expect(res.row.hostId).toBe(hostId);
    });

    it("reports a worktree failure when the host cannot resolve a base ref", async () => {
      const { projectId } = await setup();
      vi.spyOn(hostGitModule, "resolveHostBaseRef").mockResolvedValue({
        ok: false,
        reason: "unreachable",
        detail: "connect ECONNREFUSED",
      });
      const res = await createSessionRecord(app, {
        projectId,
        command: "bash",
        target: { platform: "darwin" },
        isolate: true,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe("worktree-failed");
    });

    it("says an old agent must be upgraded when it does not serve the base-ref route", async () => {
      const { projectId, hostId } = await setup();
      vi.spyOn(hostGitModule, "resolveHostBaseRef").mockResolvedValue({
        ok: false,
        reason: "unsupported",
      });
      const res = await createSessionRecord(app, {
        projectId,
        command: "bash",
        target: { hostId },
        isolate: true,
      });
      expect(res.ok).toBe(false);
      if (res.ok || res.reason !== "worktree-failed") return;
      expect(res.detail).toMatch(/too old/);
    });
  });

  describe("POST /api/sessions", () => {
    it("rejects targetHostId together with targetPlatform", async () => {
      const { projectId, hostId } = await setup();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", targetHostId: hostId, targetPlatform: "darwin" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/mutually exclusive/);
    });

    it("rejects isolate together with cwd", async () => {
      const { projectId } = await setup();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", isolate: true, cwd: "/etc" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/isolate and cwd/);
    });

    it("rejects isolate together with worktree", async () => {
      const { projectId } = await setup();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", isolate: true, worktree: { baseRef: "main" } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/isolate and worktree/);
    });

    it("answers 409 when no eligible host matches the target", async () => {
      const { projectId } = await setup();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", targetPlatform: "win32" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe("no eligible host matches platform win32");
    });

    it("creates the session on the targeted host and reads its status from THAT host", async () => {
      const { projectId, hostId, backend } = await setup();
      const liveStatus = vi.fn().mockResolvedValue({});
      (backend as Record<string, unknown>).liveStatus = liveStatus;
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", targetHostId: hostId },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().hostId).toBe(hostId);
      // The reply's live status is asked of the session's own host, not the
      // project's — the two differ for a targeted session.
      expect(backend.asked.filter((a) => a === `host:${hostId}`).length).toBeGreaterThan(1);
    });
  });
});
