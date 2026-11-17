// Issue #3194 — the 6-hour give-up, and the ONE wait it does not apply to.
//
// The dispatcher's give-up (DISPATCH_GIVE_UP_AFTER_MS, task-dispatch.ts)
// fails a queued task that has been waiting too long for a host. That is
// right for an ordinary placement wait: failing the task frees the queue
// slot.
//
// It is wrong for a retry waiting for its ORIGINAL host: the preserved
// branch (with the worker's commits) lives on that host, so failing the task
// would free nothing and would throw the work away. That wait is exempt.
//
// The exemption is keyed off `tasks.retryStrandedOnHost` — the branch is
// CONFIRMED to be only on the host the retry waits for (GitHub's 404 for the
// branch's ref) — so it covers that wait and NOTHING else. A retry that
// waits for a host whose origin state could NOT be confirmed keeps the
// 6-hour bound (its branch may well be on origin), and so does a retry that
// waits for something else (a checkout being prepared on the replacement
// host, where nothing is stranded on the original host): exactly like every
// other placement wait.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import type { SessionBackend } from "../../src/services/session-backend.js";
import type * as CheckoutMaterialize from "../../src/services/checkout-materialize.js";
import type * as ProjectOrigin from "../../src/services/project-origin.js";

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

// The checkout job itself is not what is under test here (the WAIT is), and a
// real clone would race this test — it would fail on a project path that
// does not exist, and a failed clone ends the wait before the give-up can.
vi.mock("../../src/services/checkout-materialize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CheckoutMaterialize>();
  return {
    ...actual,
    startMaterialize: vi.fn(() => ({
      projectId: 0,
      hostId: "unused",
      state: "cloning" as const,
      startedAt: 0,
    })),
    takeFailedMaterialize: vi.fn(() => null),
  };
});

// A git project with a known origin — the placement only materializes a
// checkout onto a host that has no path for it when the project is a git
// project (placement.ts's own `isGit`).
vi.mock("../../src/services/project-origin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectOrigin>();
  return {
    ...actual,
    cachedProjectOrigin: vi.fn(() => "github.com/o/r"),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { dispatchQueuedTasks, resetDispatchBackoffForTests, resetDispatchStateForTests } =
  await import("../../src/services/task-dispatch.js");
const { tasks, projects, sessions, hosts } = await import("../../src/db/schema.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const hostGitModule = await import("../../src/services/host-git.js");
const githubIntegrationModule = await import("../../src/services/github-integration.js");
const githubRequestModule = await import("../../src/services/github-request.js");
const { GitHubApiError } = await import("../../src/services/github-fetch.js");

const tmpDb = path.join(os.tmpdir(), `task-retry-give-up-test-${process.pid}.db`);
const MAC_CWD = "/Users/dev/proj";
const LINUX_CWD = "/srv/dev/proj";
const BRANCH = "mullion/task-9102-give-up";

function fakeSessionBackend(): SessionBackend {
  return {
    spawn: vi.fn().mockResolvedValue({ initialPromptApplied: true }),
    liveStatus: vi.fn().mockResolvedValue({}),
    liveness: vi.fn().mockResolvedValue({}),
    compareWorktreePaths: vi.fn().mockResolvedValue([]),
    terminate: vi.fn().mockResolvedValue(undefined),
    getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    getRenderedScrollback: vi.fn().mockResolvedValue(""),
    getTranscript: vi.fn().mockResolvedValue({ ok: false, status: 404, error: "not running" }),
    listSessionProcesses: vi.fn().mockResolvedValue([]),
    uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
    uploadFile: vi.fn().mockResolvedValue({ path: "/remote/upload.bin" }),
    resolveReviewGate: vi.fn().mockResolvedValue(false),
    acknowledgeAttention: vi.fn().mockResolvedValue(false),
    prompt: vi.fn().mockResolvedValue({ ok: true, outputOffset: 0 }),
    waitOutput: vi.fn().mockResolvedValue({ notRunning: true }),
    createWorktree: vi.fn().mockResolvedValue(null),
    checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
    removeWorktree: vi.fn().mockResolvedValue(false),
    syncWorktree: vi.fn().mockResolvedValue(false),
    resumeTaskWorktree: vi.fn().mockResolvedValue(null),
    listTaskWorktreeDirs: vi.fn().mockResolvedValue([]),
    stashSeed: vi.fn().mockResolvedValue(undefined),
    resolvePendingPromote: vi.fn().mockResolvedValue(false),
    removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
    pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
    clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    deleteBranch: vi.fn().mockResolvedValue({ deleted: false, reason: "no-such-branch" }),
    checkoutBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    createBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    rebaseBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    removeListedWorktree: vi.fn().mockResolvedValue({ removed: false, reason: "not-listed" }),
    pruneWorktreeMetadata: vi.fn().mockResolvedValue({ pruned: false }),
    readTaskReviewFindings: vi.fn().mockResolvedValue(null),
    deleteTaskReviewFindings: vi.fn().mockResolvedValue(undefined),
    resolveSessionsDir: vi.fn().mockResolvedValue("/remote/sessions"),
    readTaskCommitTitle: vi.fn().mockResolvedValue(null),
    readTaskRereviewRequest: vi.fn().mockResolvedValue(null),
  };
}

describe("the 6-hour give-up and the retry's original-host wait (#3194)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDispatchBackoffForTests();
    resetDispatchStateForTests();
  });

  /**
   * A failed task whose worker ran on an offline Mac, with the branch NOT on
   * origin — so the retry waits for the Mac.
   *
   * `originLookup` picks what the origin lookup says: "absent" is GitHub's
   * 404 (the branch is CONFIRMED to be only on the Mac), "unknown" is a
   * lookup that could not be made at all (a rate limit, a network error) —
   * the branch's whereabouts are then UNKNOWN, and the wait must not claim
   * the work is stranded on the Mac.
   */
  async function setupWaitingRetry(name: string, originLookup: "absent" | "unknown" = "absent") {
    const app = await buildApp();
    app.db.delete(sessions).run();
    app.db.delete(tasks).run();
    app.db.delete(projects).run();
    app.db.delete(hosts).run();

    const macRes = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: `${name}-mac`, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const mac = macRes.json().id as string;
    app.db.update(hosts).set({ platform: "darwin" }).where(eq(hosts.id, mac)).run();
    app.hostHeartbeatTracker?.markOffline(mac);

    const linuxRes = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: `${name}-linux`, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const linux = linuxRes.json().id as string;
    app.db.update(hosts).set({ platform: "linux" }).where(eq(hosts.id, linux)).run();
    app.hostHeartbeatTracker?.recordSuccess(linux);
    app.hostCapacityTracker?.record(linux, {
      platform: "linux",
      logicalCores: 8,
      loadAverage1m: 1,
      memory: { totalBytes: 1000, freeBytes: 500 },
      sessions: { tracked: 0, alive: 0 },
    });

    const [project] = app.db
      .insert(projects)
      .values({
        name,
        cwd: LINUX_CWD,
        hostId: linux,
        placement: "auto",
        hostCwds: JSON.stringify({ [mac]: MAC_CWD, [linux]: LINUX_CWD }),
      })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "waits for its host",
        status: "failed",
        branchName: BRANCH,
        failureReason: "budget exceeded",
      })
      .returning()
      .all();
    const [worker] = app.db
      .insert(sessions)
      .values({
        projectId: project.id,
        taskId: task.id,
        name: `Task #${task.id} · worker`,
        command: "claude",
        hostId: mac,
        status: "exited",
      })
      .returning()
      .all();
    app.db.update(tasks).set({ sessionId: worker.id }).where(eq(tasks.id, task.id)).run();

    vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation(() => fakeSessionBackend());
    vi.spyOn(hostGitModule, "resolveRepoRef").mockResolvedValue({ owner: "o", repo: "r" });
    vi.spyOn(githubIntegrationModule, "resolveGitHubToken").mockResolvedValue("tok");
    // The branch is NOT on origin: the retry can only wait for its Mac.
    if (originLookup === "absent") {
      vi.spyOn(githubRequestModule, "githubRequest").mockRejectedValue(
        new GitHubApiError("Not Found", 404),
      );
    } else {
      // The lookup could not be made — a rate limit, a network error. The
      // branch's whereabouts are UNKNOWN, which is NOT a confirmation that
      // it is stranded on the Mac.
      vi.spyOn(githubRequestModule, "githubRequest").mockRejectedValue(
        new GitHubApiError("Bad gateway", 502),
      );
    }

    const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => {
      const row = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      expect(row?.retryHostId).toBe(mac);
    });

    return { app, mac, task };
  }

  it("leaves a retry waiting for its original host queued past the 6-hour give-up", async () => {
    const { app, mac, task } = await setupWaitingRetry("give-up-exempt");
    try {
      const held = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      // The branch is CONFIRMED to be only on the Mac, so this wait is
      // exempt from the give-up.
      expect(held?.retryHostId).toBe(mac);
      expect(held?.retryStrandedOnHost).toBe(true);

      app.db
        .update(tasks)
        .set({ dispatchFailingSince: new Date(Date.now() - 7 * 60 * 60 * 1000) })
        .where(eq(tasks.id, task.id))
        .run();

      await dispatchQueuedTasks(app);

      const row = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      // The branch is on the Mac — failing the task would free nothing.
      expect(row?.status).toBe("claimed");
      expect(row?.retryHostId).toBe(mac);
    } finally {
      await app.close();
    }
  });

  it("gives up a retry whose origin state could not be confirmed, and still offers Start fresh", async () => {
    const { app, mac, task } = await setupWaitingRetry("give-up-unconfirmed", "unknown");
    try {
      const held = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      // The retry waits for its original host, so the host is recorded and
      // "Start fresh" is offered against it — the operator's only escape
      // from a wait that never ends.
      expect(held?.retryHostId).toBe(mac);
      // But the branch is NOT confirmed stranded there (the lookup never
      // happened), so the wait keeps the 6-hour bound: the branch may well
      // be on origin, and failing the task frees something.
      expect(held?.retryStrandedOnHost).toBe(false);

      app.db
        .update(tasks)
        .set({ dispatchFailingSince: new Date(Date.now() - 7 * 60 * 60 * 1000) })
        .where(eq(tasks.id, task.id))
        .run();

      await dispatchQueuedTasks(app);

      const failed = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      expect(failed?.status).toBe("failed");
      expect(failed?.failureReason).toContain("gave up after 6h");
      // The preserved branch survives: a later Retry resumes it instead of
      // cutting a brand-new branch.
      expect(failed?.branchName).toBe(BRANCH);
    } finally {
      await app.close();
    }
  });

  it("gives up a retry that is waiting for something OTHER than its original host", async () => {
    const app = await buildApp();
    try {
      app.db.delete(sessions).run();
      app.db.delete(tasks).run();
      app.db.delete(projects).run();
      app.db.delete(hosts).run();

      // The original (Mac) host: offline, so the retry cannot resume there.
      const macRes = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "checkout-mac", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const mac = macRes.json().id as string;
      app.db.update(hosts).set({ platform: "darwin" }).where(eq(hosts.id, mac)).run();
      app.hostHeartbeatTracker?.markOffline(mac);

      // The replacement (Linux) host: online and eligible, but the project is
      // NOT checked out there yet, so the placement computes needsCheckout.
      const linuxRes = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "checkout-linux", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const linux = linuxRes.json().id as string;
      app.db.update(hosts).set({ platform: "linux" }).where(eq(hosts.id, linux)).run();
      app.hostHeartbeatTracker?.recordSuccess(linux);
      app.hostCapacityTracker?.record(linux, {
        platform: "linux",
        logicalCores: 8,
        loadAverage1m: 1,
        memory: { totalBytes: 1000, freeBytes: 500 },
        sessions: { tracked: 0, alive: 0 },
      });

      const [project] = app.db
        .insert(projects)
        .values({
          name: "checkout-wait",
          // The project lives on the Mac; the Linux host is neither the
          // project's own host nor in `hostCwds`, so it needs a checkout.
          cwd: MAC_CWD,
          hostId: mac,
          placement: "auto",
          hostCwds: JSON.stringify({ [mac]: MAC_CWD }),
        })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId: project.id,
          title: "waits for a checkout",
          status: "failed",
          branchName: BRANCH,
          failureReason: "budget exceeded",
        })
        .returning()
        .all();
      const [worker] = app.db
        .insert(sessions)
        .values({
          projectId: project.id,
          taskId: task.id,
          name: `Task #${task.id} · worker`,
          command: "claude",
          hostId: mac,
          status: "exited",
        })
        .returning()
        .all();
      app.db.update(tasks).set({ sessionId: worker.id }).where(eq(tasks.id, task.id)).run();

      vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation(() =>
        fakeSessionBackend(),
      );
      // The branch IS on origin — the only reason a retry may leave its
      // original host at all.
      vi.spyOn(hostGitModule, "resolveRepoRef").mockResolvedValue({ owner: "o", repo: "r" });
      vi.spyOn(githubIntegrationModule, "resolveGitHubToken").mockResolvedValue("tok");
      vi.spyOn(githubRequestModule, "githubRequest").mockResolvedValue({
        ref: `refs/heads/${BRANCH}`,
      } as never);

      const retryRes = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(retryRes.statusCode).toBe(202);

      // The retry is re-placed onto the Linux host, which has no checkout yet,
      // so the task waits for the clone.
      await vi.waitFor(() => {
        const row = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
        expect(row?.failureReason).toContain("preparing checkout");
      });

      const held = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      expect(held?.status).toBe("claimed");
      // This wait is not about the original host — nothing is stranded there —
      // so the task is not marked as waiting for it.
      expect(held?.retryHostId).toBeNull();

      // More than 6 hours later the wait is over: this is an ordinary
      // placement wait, so the give-up applies.
      app.db
        .update(tasks)
        .set({ dispatchFailingSince: new Date(Date.now() - 7 * 60 * 60 * 1000) })
        .where(eq(tasks.id, task.id))
        .run();

      await dispatchQueuedTasks(app);

      const failed = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      expect(failed?.status).toBe("failed");
      expect(failed?.failureReason).toContain("gave up after 6h");
    } finally {
      await app.close();
    }
  });
});
