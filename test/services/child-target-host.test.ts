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
    expect(res.detail).toBe(
      "no eligible host matches platform win32 (no host has reported platform win32)",
    );
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
    // The reason is named without naming the host (issue #2112).
    if (res.reason === "no-target-host") {
      expect(res.detail).toContain("the project has no checkout on a matching host");
    }
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
    // Says WHY, about the host the caller asked for only (issue #2112).
    if (res.reason === "no-target-host") expect(res.detail).toContain("parked/drained");
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
    if (res.ok || res.reason !== "no-target-host") return;
    expect(res.detail).toContain("a matching host is offline");
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

  // Issue #2006 — whether waiting could change a refusal's answer. The detail
  // (and so what a session-scoped caller learns) is the same either way.
  describe("a refusal says whether waiting could help (issue #2006)", () => {
    async function refusal(target: { platform: string } | { hostId: string }, projectId: number) {
      const project = app.db.select().from(projects).where(eq(projects.id, projectId)).all()[0];
      return resolveTargetHost(app, {
        project: {
          hostId: project.hostId,
          placement: project.placement,
          cwd: project.cwd,
          hostCwds: project.hostCwds,
        },
        target,
        unattended: true,
      });
    }

    // ONE setup for every case: project creation is rate limited per minute
    // (this file's other tests already use most of it), and the cases only
    // differ in the host's state.
    it("is transient while a matching host is parked or has no reading, permanent when none could match", async () => {
      const { projectId, hostId } = await setup();

      app.db.update(hosts).set({ drained: true }).where(eq(hosts.id, hostId)).run();
      expect(await refusal({ platform: "darwin" }, projectId)).toMatchObject({
        ok: false,
        transient: true,
      });

      app.db.update(hosts).set({ drained: false }).where(eq(hosts.id, hostId)).run();
      const readings = vi.spyOn(app.hostCapacityTracker!, "get").mockReturnValue(undefined);
      expect(await refusal({ hostId }, projectId)).toMatchObject({ ok: false, transient: true });
      readings.mockRestore();

      // A host that has not reported a platform yet (a Mac still offline after
      // a backend restart) might be the one: wait for it.
      app.db.update(hosts).set({ drained: true, platform: null }).where(eq(hosts.id, hostId)).run();
      vi.spyOn(app.hostCapacityTracker!, "get").mockReturnValue(undefined);
      expect(await refusal({ platform: "darwin" }, projectId)).toMatchObject({
        ok: false,
        transient: true,
      });
      vi.mocked(app.hostCapacityTracker!.get).mockRestore();

      // No host of that platform exists at all.
      app.db
        .update(hosts)
        .set({ drained: false, platform: "linux" })
        .where(eq(hosts.id, hostId))
        .run();
      expect(await refusal({ platform: "win32" }, projectId)).toMatchObject({
        ok: false,
        transient: false,
      });

      // The matching host exists but the project has no path on it.
      app.db.update(projects).set({ hostCwds: null }).where(eq(projects.id, projectId)).run();
      expect(await refusal({ platform: "darwin" }, projectId)).toMatchObject({
        ok: false,
        transient: false,
      });
    });
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
    expect(res).toEqual({
      ok: false,
      detail: "no eligible host matches platform darwin (the host list could not be read)",
      // Could not read the fleet at all: nothing says waiting would not help.
      transient: true,
      unreadable: true,
    });
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

  // Issue #1964 — a session records the worktree it owns, so it can be
  // reclaimed when the session ends (services/session-worktree-reclaim.ts).
  describe("worktree ownership", () => {
    it("records the worktree an isolated child owns, and the repo it was cut from on that host", async () => {
      const { projectId, hostId } = await setup();
      vi.spyOn(hostGitModule, "resolveHostBaseRef").mockResolvedValue({
        ok: true,
        value: { baseRef: "origin/main", sha: "abc123" },
      });

      const res = await createSessionRecord(app, {
        projectId,
        command: "bash",
        target: { hostId },
        isolate: true,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.row.worktreeBranch).toBe("mullion/child-x");
      // The repo ON THE PLACEMENT HOST — `git worktree remove` has to run there.
      expect(res.row.worktreeRepoCwd).toBe(REMOTE_CWD);
      expect(res.row.worktreeReclaimedAt).toBeNull();
    });

    it("records the worktree the launcher's isolate toggle cut", async () => {
      const { projectId } = await setup();

      const res = await createSessionRecord(app, {
        projectId,
        command: "bash",
        worktree: { baseRef: "main" },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.row.worktreeBranch).toBe("mullion/child-x");
      expect(res.row.worktreeRepoCwd).toBe(LOCAL_CWD);
    });

    it("records the worktree a caller cut itself and handed over (promote)", async () => {
      const { projectId } = await setup();

      const res = await createSessionRecord(app, {
        projectId,
        command: "bash",
        cwd: WT,
        ownedWorktree: { branch: "mullion/promote-1", repoCwd: LOCAL_CWD },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.row.worktreeBranch).toBe("mullion/promote-1");
      expect(res.row.worktreeRepoCwd).toBe(LOCAL_CWD);
    });

    it("records nothing for a Task Master session — the task owns its worktree", async () => {
      const { projectId } = await setup();

      const res = await createSessionRecord(app, {
        projectId,
        command: "bash",
        worktree: { baseRef: "main", branchName: "mullion/task-7" },
        taskId: 7,
        unattended: true,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.row.worktreeBranch).toBeNull();
      expect(res.row.worktreeRepoCwd).toBeNull();
    });

    it("records nothing for a dock preview, which checks out an existing branch", async () => {
      const { projectId } = await setup();

      const res = await createSessionRecord(app, {
        projectId,
        command: "bash",
        worktree: { branch: "feature/x" },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.row.cwd).toBe(WT);
      expect(res.row.worktreeBranch).toBeNull();
    });

    it("records nothing for an ordinary session", async () => {
      const { projectId } = await setup();

      const res = await createSessionRecord(app, { projectId, command: "bash" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.row.worktreeBranch).toBeNull();
      expect(res.row.worktreeRepoCwd).toBeNull();
    });
  });

  describe("contradictory options are refused by the service itself", () => {
    it("hostId together with target", async () => {
      const { projectId, hostId } = await setup();
      const res = await createSessionRecord(app, {
        projectId,
        command: "bash",
        hostId,
        target: { platform: "darwin" },
      });
      expect(res).toMatchObject({ ok: false, reason: "invalid-options" });
    });

    it("isolate together with worktree, or with cwd", async () => {
      const { projectId } = await setup();
      const withWorktree = await createSessionRecord(app, {
        projectId,
        command: "bash",
        isolate: true,
        worktree: { baseRef: "main" },
      });
      expect(withWorktree).toMatchObject({ ok: false, reason: "invalid-options" });
      const withCwd = await createSessionRecord(app, {
        projectId,
        command: "bash",
        isolate: true,
        cwd: "/etc",
      });
      expect(withCwd).toMatchObject({ ok: false, reason: "invalid-options" });
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

    it("answers 400, not 409, for a platform no host can report (a typo)", async () => {
      const { projectId } = await setup();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", targetPlatform: "macos" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("answers 409 when no eligible host matches the target", async () => {
      const { projectId } = await setup();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", targetPlatform: "win32" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe(
        "no eligible host matches platform win32 (no host has reported platform win32)",
      );
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
