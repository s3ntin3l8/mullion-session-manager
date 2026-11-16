import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import type { SessionBackend } from "../../src/services/session-backend.js";

// Issue #3151 — a task's `Capability:` directive through the claim/placement
// path. Same fakes as the requirement block in task-claim.test.ts (kept in a
// file of its own because that one is at its size ceiling).
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (command === "git") return actual.spawn(command, args, options);
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: vi.fn().mockResolvedValue(undefined),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { enqueueTask, dispatchClaimedTask } = await import("../../src/services/task-claim.js");
const { tasks, projects, sessions } = await import("../../src/db/schema.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const hostGitModule = await import("../../src/services/host-git.js");

const tmpDb = path.join(os.tmpdir(), `task-claim-capability-test-${process.pid}.db`);
const MAC_CWD = "/Users/me/proj";
const LINUX_CWD = "/srv/proj";
const NO_CAPS = { capabilities: [], agents: null, mullionVersion: null };

describe("a task's Capability: requirement (#3151)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function addHost(
    app: Awaited<ReturnType<typeof buildApp>>,
    name: string,
    platform: string,
    loadAverage1m: number,
  ) {
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
      loadAverage1m,
      memory: { totalBytes: 1000, freeBytes: 500 },
      sessions: { tracked: 0, alive: 0 },
    });
    return hostId;
  }

  // A project that lives on an idle Linux box and a busier Mac; neither the
  // local host nor the Linux box has Xcode, the Mac does.
  async function setup(name: string, body: string, macCapabilities: string[] = ["xcode"]) {
    const app = await buildApp();
    const mac = await addHost(app, `${name}-mac`, "darwin", 3);
    const linux = await addHost(app, `${name}-linux`, "linux", 0);
    const [project] = app.db
      .insert(projects)
      .values({
        name,
        cwd: "/srv/local-proj",
        hostId: "local",
        placement: "auto",
        hostCwds: JSON.stringify({ [linux]: LINUX_CWD, [mac]: MAC_CWD }),
      })
      .returning()
      .all();
    app.hostAgentTracker?.record("local", NO_CAPS);
    app.hostAgentTracker?.record(linux, NO_CAPS);
    app.hostAgentTracker?.record(mac, { ...NO_CAPS, capabilities: macCapabilities });
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        issueNumber: 1000 + Math.floor(Math.random() * 9000),
        title: "t",
        body,
        status: "ready",
      })
      .returning()
      .all();
    const fakeBackend = {
      spawn: vi.fn().mockResolvedValue({ initialPromptApplied: true }),
      createWorktree: vi.fn(async (baseCwd: string) => ({
        created: true,
        path: `${baseCwd}/.mullion-worktrees/mullion-task-x`,
        branch: "x",
      })),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn().mockResolvedValue(undefined),
      removeWorktree: vi.fn().mockResolvedValue(false),
      resolveSessionsDir: vi.fn().mockResolvedValue("/remote/sessions"),
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
      removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
      deleteBranch: vi.fn().mockResolvedValue({ deleted: false, reason: "no-such-branch" }),
      resumeTaskWorktree: vi.fn().mockResolvedValue(null),
      checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
      readTaskCommitTitle: vi.fn().mockResolvedValue(null),
    } as unknown as SessionBackend;
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(fakeBackend);
    vi.spyOn(hostGitModule, "resolveHostBaseRef").mockResolvedValue({
      ok: true,
      value: { baseRef: "origin/main", sha: "deadbeefcafe" },
    });
    return { app, mac, linux, task, fakeBackend };
  }

  async function claimAndDispatch(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const enqueued = await enqueueTask(app, taskId, { auto: false });
    if (!enqueued.ok) return enqueued;
    return dispatchClaimedTask(app, taskId);
  }

  function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  async function sessionOf(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const row = getTask(app, taskId);
    const [session] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, row.sessionId as number))
      .all();
    return session;
  }

  it("Capability: xcode lands the task on the host that has it, not the idle one that lacks it", async () => {
    const { app, mac, task } = await setup("req-cap", "Capability: XCode\nBuild the iOS target.");
    try {
      const outcome = await claimAndDispatch(app, task.id);

      expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
      expect(getTask(app, task.id).placementRequirement).toBe(
        JSON.stringify({ capabilities: ["xcode"] }),
      );
      expect((await sessionOf(app, task.id))?.hostId).toBe(mac);
    } finally {
      await app.close();
    }
  });

  it("Capability: refuses the claim, naming it, when every candidate host lacks it", async () => {
    const { app, task, fakeBackend } = await setup(
      "req-cap-none",
      "Platform: darwin\nCapability: xcode",
      [],
    );
    try {
      const outcome = await claimAndDispatch(app, task.id);

      expect(outcome).toMatchObject({ ok: false, reason: "placement-refused" });
      const row = getTask(app, task.id);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("lacks xcode");
      expect(row.failureReason).toContain("`Capability:`");
      expect(fakeBackend.createWorktree).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("Capability: holds the task (does not fail it) while the only host with it is parked", async () => {
    const { app, mac, task } = await setup("req-cap-hold", "Capability: xcode");
    try {
      const { hosts } = await import("../../src/db/schema.js");
      app.db.update(hosts).set({ drained: true }).where(eq(hosts.id, mac)).run();

      const outcome = await claimAndDispatch(app, task.id);

      expect(outcome).toMatchObject({ ok: false, reason: "placement-held" });
      const row = getTask(app, task.id);
      expect(row.status).toBe("claimed");
      expect(row.failureReason).toContain("capability xcode");
    } finally {
      await app.close();
    }
  });

  it("Capability: with a name no host can have is refused naming it", async () => {
    const { app, task } = await setup("req-cap-typo", "Capability: xcodee");
    try {
      const outcome = await claimAndDispatch(app, task.id);

      expect(outcome).toMatchObject({ ok: false, reason: "placement-refused" });
      expect(getTask(app, task.id).failureReason).toContain("unknown capability xcodee");
    } finally {
      await app.close();
    }
  });
});
