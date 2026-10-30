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
// spawn are faked, and every resolveBackend() call is replaced with a fake.
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
const { previewPlacement, resolveTargetHost } = await import("../../src/services/placement.js");

// Issue #2241 — a project's steering flags (platform allow-list, allowBurst)
// bound where Auto may place work. Task Master's side is in task-claim.test.ts.

const tmpDb = path.join(os.tmpdir(), `placement-steering-${process.pid}.db`);
const LOCAL_CWD = "/tmp/steer-proj";
const REMOTE_CWD = "/remote/steer-proj";
const WT = "/remote/steer-proj/.mullion-worktrees/session-1";
// A platform the primary is NOT on, so the remote host is the only one a flag for it allows.
const OTHER = process.platform === "darwin" ? "linux" : "darwin";

describe("a project's placement steering flags (issue #2241)", () => {
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

  /** An online remote host of `platform`, with a capacity reading. */
  async function addHost(platform: string, name = `h-${Math.random()}`) {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = res.json().id as string;
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, {
      platform,
      logicalCores: 8,
      loadAverage1m: 0.2,
      memory: { totalBytes: 1000, freeBytes: 500 },
      sessions: { tracked: 0, alive: 0 },
    });
    return hostId;
  }

  function addProject(
    hostCwds: Record<string, string>,
    constraints: object | null,
    placement: "pinned" | "auto" = "auto",
  ) {
    const [project] = app.db
      .insert(projects)
      .values({
        name: `steer-${Math.random()}`,
        cwd: LOCAL_CWD,
        hostId: "local",
        placement,
        hostCwds: JSON.stringify(hostCwds),
        placementConstraints: constraints === null ? null : JSON.stringify(constraints),
      })
      .returning()
      .all();
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
      createWorktree: vi.fn(async () => ({ created: true, path: WT, branch: "b" })),
      removeWorktree: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
      terminate: vi.fn().mockResolvedValue(undefined),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);
    return project;
  }

  it("sends an Auto launch only to a host the platform flag allows, though the primary is preferred", async () => {
    const host = await addHost(OTHER);
    const project = addProject({ [host]: REMOTE_CWD }, { platform: [OTHER], allowBurst: false });

    const res = await createSessionRecord(app, { projectId: project.id, command: "bash" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.hostId).toBe(host);
  });

  it("refuses an Auto launch when no online host satisfies the flag — never the pinned host", async () => {
    const host = await addHost(OTHER);
    app.db.update(hosts).set({ drained: true }).where(eq(hosts.id, host)).run();
    const project = addProject({ [host]: REMOTE_CWD }, { platform: [OTHER] });

    const res = await createSessionRecord(app, { projectId: project.id, command: "bash" });

    expect(res.ok).toBe(false);
    if (res.ok || res.reason !== "no-target-host") return expect(res.ok).toBe(false);
    expect(res.detail).toContain(`project allows only ${OTHER} hosts`);
    expect(res.detail).toContain("parked/drained");
    // Names the flags, never a host.
    expect(res.detail).not.toContain(host);
    expect(app.db.select().from(sessions).all()).toHaveLength(0);
  });

  it("refuses a per-launch Auto on a pinned project the same way", async () => {
    const project = addProject({}, { platform: [OTHER] }, "pinned");

    const refused = await createSessionRecord(app, {
      projectId: project.id,
      command: "bash",
      placement: "auto",
    });
    expect(refused).toMatchObject({ ok: false, reason: "no-target-host" });

    // Pinned itself is untouched by the flags.
    const pinned = await createSessionRecord(app, { projectId: project.id, command: "bash" });
    expect(pinned.ok).toBe(true);
    if (pinned.ok) expect(pinned.row.hostId).toBe("local");
  });

  it("checks an explicit launcher target against the platform flag", async () => {
    const host = await addHost(OTHER);
    const project = addProject({ [host]: REMOTE_CWD }, { platform: [OTHER] });

    const ok = await createSessionRecord(app, {
      projectId: project.id,
      command: "bash",
      target: { hostId: host },
    });
    expect(ok.ok).toBe(true);

    // The primary reports another platform: the flag rules it out.
    const refused = await createSessionRecord(app, {
      projectId: project.id,
      command: "bash",
      target: { platform: process.platform },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.reason !== "no-target-host") return;
    expect(refused.detail).toContain(`project allows only ${OTHER} hosts`);
    expect(refused.detail).not.toContain(host);
  });

  it("lets a task directive override the flag (no project-flag check)", async () => {
    const host = await addHost(OTHER);
    const project = addProject({ [host]: REMOTE_CWD }, { platform: [OTHER] });
    const target = { platform: process.platform };
    const base = {
      project: {
        hostId: project.hostId,
        placement: project.placement,
        cwd: project.cwd,
        hostCwds: project.hostCwds,
        placementConstraints: project.placementConstraints,
      },
      target,
      unattended: true,
    };

    expect(resolveTargetHost(app, base)).toMatchObject({ ok: true });
    expect(resolveTargetHost(app, { ...base, checkProjectFlags: true })).toMatchObject({
      ok: false,
      transient: false,
    });
  });

  it("keeps burst hosts out of Auto unless the project allows them", async () => {
    const host = await addHost(OTHER);
    app.db.update(hosts).set({ role: "burst" }).where(eq(hosts.id, host)).run();
    const denied = addProject({ [host]: REMOTE_CWD }, { platform: [OTHER], allowBurst: false });

    const refused = await createSessionRecord(app, { projectId: denied.id, command: "bash" });
    expect(refused).toMatchObject({ ok: false, reason: "no-target-host" });
    if (!refused.ok && refused.reason === "no-target-host") {
      expect(refused.detail).toContain("burst host");
    }

    const allowed = addProject({ [host]: REMOTE_CWD }, { platform: [OTHER], allowBurst: true });
    const res = await createSessionRecord(app, { projectId: allowed.id, command: "bash" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.row.hostId).toBe(host);
  });

  it("explains each exclusion in the preview, and says when nothing was placed", async () => {
    const host = await addHost(process.platform);
    const project = addProject({ [host]: REMOTE_CWD }, { platform: [OTHER] });

    const decision = previewPlacement(app, {
      project: {
        hostId: project.hostId,
        placement: "auto",
        cwd: project.cwd,
        hostCwds: project.hostCwds,
        placementConstraints: project.placementConstraints,
      },
    });

    expect(decision.refusal).toBeDefined();
    expect(decision.reason).toContain("not placed");
    expect(decision.excluded).toContainEqual({
      hostId: "local",
      reason: `project allows only ${OTHER} hosts`,
    });
  });

  it("answers POST /api/sessions with a 409 and the reason when the flag leaves no host", async () => {
    const project = addProject({}, { platform: [OTHER] });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.id, command: "bash", placement: "auto" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain(`project allows only ${OTHER} hosts`);
    expect(app.db.select().from(sessions).all()).toHaveLength(0);
  });

  it("calls a refusal transient while a host that has not reported its platform might match", async () => {
    // No capacity reading and no self-reported platform: it cannot be told apart from a match.
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "unreported", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const project = addProject({ [res.json().id as string]: REMOTE_CWD }, { platform: [OTHER] });

    const decision = previewPlacement(app, {
      project: {
        hostId: project.hostId,
        placement: "auto",
        cwd: project.cwd,
        hostCwds: project.hostCwds,
        placementConstraints: project.placementConstraints,
      },
    });

    expect(decision.refusal?.transient).toBe(true);
    expect(decision.refusal?.detail).toContain("has not reported its platform");
  });

  it("does not change a project with no flags", async () => {
    const host = await addHost(OTHER);
    const project = addProject({ [host]: REMOTE_CWD }, null);

    const res = await createSessionRecord(app, { projectId: project.id, command: "bash" });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.row.hostId).toBe("local");
  });
});
