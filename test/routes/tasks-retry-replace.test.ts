// Issue #3194 — a retry that re-places onto a matching host when its
// original host is offline.
//
// The scenarios the issue names, driven through the REAL entry points: the
// retry route (`POST /api/tasks/:id/retry`, via app.inject()) and the
// dispatch sweep (dispatchQueuedTasks), so what is tested is what a user
// gets.
//
// The fakes are the ones task-claim-capability.test.ts /
// tasks-retry-host.test.ts already use: a fake SessionBackend per host, a
// fake heartbeat/capacity reading per host, and the GitHub helpers stubbed
// (the branch-on-origin check is the one thing here that talks to GitHub,
// and it must never be assumed).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { desc, eq } from "drizzle-orm";
import type { SessionBackend } from "../../src/services/session-backend.js";

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
const { dispatchQueuedTasks, resetDispatchBackoffForTests, resetDispatchStateForTests } =
  await import("../../src/services/task-dispatch.js");
const { tasks, projects, sessions, hosts } = await import("../../src/db/schema.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const hostGitModule = await import("../../src/services/host-git.js");
const githubIntegrationModule = await import("../../src/services/github-integration.js");
const githubRequestModule = await import("../../src/services/github-request.js");
const { GitHubApiError } = await import("../../src/services/github-fetch.js");

const tmpDb = path.join(os.tmpdir(), `tasks-retry-replace-test-${process.pid}.db`);
const MAC_CWD = "/Users/dev/proj";
const LINUX_CWD = "/srv/dev/proj";
const BRANCH = "mullion/task-9001-retry-replaces";

function fakeSessionBackend(overrides: Partial<SessionBackend>): SessionBackend {
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
    ...overrides,
  };
}

describe("a retry that re-places onto a matching host (#3194)", () => {
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

  async function addHost(
    app: Awaited<ReturnType<typeof buildApp>>,
    name: string,
    platform: string,
    opts: { online?: boolean } = {},
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = res.json().id as string;
    app.db.update(hosts).set({ platform }).where(eq(hosts.id, hostId)).run();
    if (opts.online !== false) {
      app.hostHeartbeatTracker?.recordSuccess(hostId);
      app.hostCapacityTracker?.record(hostId, {
        platform,
        logicalCores: 8,
        loadAverage1m: 1,
        memory: { totalBytes: 1000, freeBytes: 500 },
        sessions: { tracked: 0, alive: 0 },
      });
    } else {
      // The host has missed its pings: it reads as offline.
      app.hostHeartbeatTracker?.markOffline(hostId);
    }
    return hostId;
  }

  /**
   * A project on the LINUX host, mapped on both remote hosts, with a failed
   * task whose worker ran on the Mac (the host that holds the preserved
   * branch).
   */
  async function setup(
    name: string,
    opts: {
      body?: string;
      originalOnline?: boolean;
      replacementOnline?: boolean;
      branchOnOrigin?: boolean;
      replacementPlatform?: string;
    } = {},
  ) {
    const app = await buildApp();
    // Every test in this file shares one database file (the repo's pattern),
    // so the previous test's rows are cleared here: a task left `claimed` by
    // an earlier test would otherwise be picked up by this app's dispatch
    // sweep and answered against THIS test's fakes.
    app.db.delete(sessions).run();
    app.db.delete(tasks).run();
    app.db.delete(projects).run();
    app.db.delete(hosts).run();
    const mac = await addHost(app, `${name}-mac`, "darwin", {
      online: opts.originalOnline !== false,
    });
    const linux = await addHost(app, `${name}-linux`, opts.replacementPlatform ?? "linux", {
      online: opts.replacementOnline !== false,
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
        title: "retry replaces",
        body: opts.body ?? null,
        status: "failed",
        branchName: BRANCH,
        worktreePath: `${MAC_CWD}/.mullion-worktrees/mullion-task-9001-retry-replaces`,
        failureReason: "budget exceeded",
      })
      .returning()
      .all();
    // The worker session that ran on the Mac — the host the preserved
    // branch lives on.
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

    const macBackend = fakeSessionBackend({
      resumeTaskWorktree: vi.fn().mockResolvedValue({
        path: `${MAC_CWD}/.mullion-worktrees/mullion-task-9001-retry-replaces`,
        branch: BRANCH,
      }),
    });
    const linuxBackend = fakeSessionBackend({
      resumeTaskWorktree: vi.fn().mockResolvedValue({
        path: `${LINUX_CWD}/.mullion-worktrees/mullion-task-9001-retry-replaces`,
        branch: BRANCH,
      }),
    });
    vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation((_app, hostId) =>
      hostId === mac ? macBackend : linuxBackend,
    );
    // The GitHub side of the "is the branch on origin?" check. It is the one
    // thing that must never be assumed, so it is stubbed EXPLICITLY in every
    // test: "on origin" resolves, "not on origin" is GitHub's 404.
    vi.spyOn(hostGitModule, "resolveRepoRef").mockResolvedValue({ owner: "o", repo: "r" });
    vi.spyOn(githubIntegrationModule, "resolveGitHubToken").mockResolvedValue("tok");
    vi.spyOn(githubRequestModule, "githubRequest").mockImplementation(async () => {
      if (opts.branchOnOrigin === false) {
        throw new GitHubApiError("Not Found", 404);
      }
      return { ref: `refs/heads/${BRANCH}` } as never;
    });

    return { app, mac, linux, task, macBackend, linuxBackend };
  }

  function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  async function retryTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/retry` });
    expect(res.statusCode).toBe(202);
    return res;
  }

  it("resumes on the original host while it is online", async () => {
    const { app, mac, task, macBackend, linuxBackend } = await setup("retry-original");
    try {
      await retryTask(app, task.id);
      await vi.waitFor(() => {
        expect(getTask(app, task.id).status).toBe("in_progress");
      });

      expect(macBackend.resumeTaskWorktree).toHaveBeenCalledWith(MAC_CWD, BRANCH);
      expect(linuxBackend.resumeTaskWorktree).not.toHaveBeenCalled();
      const [session] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.taskId, task.id))
        .orderBy(desc(sessions.id))
        .all();
      expect(session?.hostId).toBe(mac);
    } finally {
      await app.close();
    }
  });

  it("re-places onto a second eligible host when the original is offline and the branch is on origin", async () => {
    const { app, linux, task, macBackend, linuxBackend } = await setup("retry-replace", {
      originalOnline: false,
      branchOnOrigin: true,
    });
    try {
      await retryTask(app, task.id);
      await vi.waitFor(() => {
        expect(getTask(app, task.id).status).toBe("in_progress");
      });

      // The original host is never asked to resume — it is offline.
      expect(macBackend.resumeTaskWorktree).not.toHaveBeenCalled();
      // The replacement checks the branch out FROM ORIGIN.
      expect(linuxBackend.resumeTaskWorktree).toHaveBeenCalledWith(LINUX_CWD, BRANCH, {
        fromOrigin: true,
      });
      const row = getTask(app, task.id);
      // The task's worktree now lives on the new host.
      expect(row.worktreePath).toBe(
        `${LINUX_CWD}/.mullion-worktrees/mullion-task-9001-retry-replaces`,
      );
      expect(row.retryHostId).toBeNull();
      const [session] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.taskId, task.id))
        .orderBy(desc(sessions.id))
        .all();
      expect(session?.hostId).toBe(linux);
    } finally {
      await app.close();
    }
  });

  it("waits with a reason when the original host is offline and the branch is not on origin", async () => {
    const { app, mac, task, macBackend, linuxBackend } = await setup("retry-not-on-origin", {
      originalOnline: false,
      branchOnOrigin: false,
    });
    try {
      await retryTask(app, task.id);
      await vi.waitFor(() => {
        expect(getTask(app, task.id).retryHostId).toBe(mac);
      });

      const row = getTask(app, task.id);
      expect(row.status).toBe("claimed");
      expect(row.failureReason).toContain("not on origin");
      expect(row.failureReason).toContain(mac);
      // The host is OFFLINE, and the reason says so — a parked host is a
      // different thing with a different fix.
      expect(row.failureReason).toContain("offline");
      expect(macBackend.resumeTaskWorktree).not.toHaveBeenCalled();
      expect(linuxBackend.resumeTaskWorktree).not.toHaveBeenCalled();
      expect(row.sessionId).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("waits when no other host is eligible either", async () => {
    const { app, mac, task } = await setup("retry-no-host", {
      originalOnline: false,
      replacementOnline: false,
      branchOnOrigin: true,
    });
    try {
      await retryTask(app, task.id);
      await vi.waitFor(() => {
        expect(getTask(app, task.id).failureReason).toContain("no other host");
      });

      const row = getTask(app, task.id);
      expect(row.status).toBe("claimed");
      expect(row.failureReason).toContain("no other host");
      // The reason names the host the retry is waiting for.
      expect(row.failureReason).toContain(mac);
      // The branch IS on origin, so nothing is stranded on the original host:
      // this wait is not exempt from the 6-hour give-up (it frees the task
      // slot, and the work is safe on origin). The wait host is still
      // recorded, though — the retry waits for THAT host, and "Start fresh"
      // is offered against it.
      expect(row.retryHostId).toBe(mac);
      expect(row.retryStrandedOnHost).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("gives up an on-origin retry wait after 6 hours, keeping the preserved branch", async () => {
    const { app, task } = await setup("retry-on-origin-give-up", {
      originalOnline: false,
      replacementOnline: false,
      branchOnOrigin: true,
    });
    try {
      await retryTask(app, task.id);
      await vi.waitFor(() => {
        expect(getTask(app, task.id).failureReason).toContain("no other host");
      });
      // The wait has been running for more than 6 hours.
      app.db
        .update(tasks)
        .set({ dispatchFailingSince: new Date(Date.now() - 7 * 60 * 60 * 1000) })
        .where(eq(tasks.id, task.id))
        .run();

      await dispatchQueuedTasks(app);

      const row = getTask(app, task.id);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("gave up after 6h");
      // The retry's branch is the PRESERVED one: a later Retry resumes it
      // instead of cutting a brand-new branch.
      expect(row.branchName).toBe(BRANCH);
    } finally {
      await app.close();
    }
  });

  it("never re-places a Platform: task onto a host of another platform", async () => {
    const { app, mac, task, linuxBackend } = await setup("retry-platform", {
      body: "Platform: darwin",
      originalOnline: false,
      branchOnOrigin: true,
    });
    try {
      await retryTask(app, task.id);
      await vi.waitFor(() => {
        expect(getTask(app, task.id).failureReason).toContain("no other host");
      });

      const row = getTask(app, task.id);
      expect(row.status).toBe("claimed");
      // The only other host is a Linux box: a darwin task must not land on it.
      expect(linuxBackend.resumeTaskWorktree).not.toHaveBeenCalled();
      expect(row.worktreePath).toBe(
        `${MAC_CWD}/.mullion-worktrees/mullion-task-9001-retry-replaces`,
      );
      // The branch is on origin, so the wait is not stranded on the Mac: it
      // keeps the 6-hour give-up. The wait host is still recorded — the
      // retry waits for the Mac, and "Start fresh" is offered against it.
      expect(row.retryHostId).toBe(mac);
      expect(row.retryStrandedOnHost).toBe(false);
      // The reason names the host the retry is waiting for.
      expect(row.failureReason).toContain(mac);
    } finally {
      await app.close();
    }
  });

  it("keeps a waiting retry queued past the 6h give-up", async () => {
    const { app, mac, task } = await setup("retry-give-up", {
      originalOnline: false,
      branchOnOrigin: false,
    });
    try {
      await retryTask(app, task.id);
      await vi.waitFor(() => {
        expect(getTask(app, task.id).retryHostId).toBe(mac);
      });
      // The wait has been running for more than 6 hours.
      app.db
        .update(tasks)
        .set({ dispatchFailingSince: new Date(Date.now() - 7 * 60 * 60 * 1000) })
        .where(eq(tasks.id, task.id))
        .run();

      await dispatchQueuedTasks(app);

      const row = getTask(app, task.id);
      // The branch is on that host — failing the task would free nothing.
      expect(row.status).toBe("claimed");
      expect(row.retryHostId).toBe(mac);
      expect(row.failureReason).toContain("not on origin");
    } finally {
      await app.close();
    }
  });

  it("still gives up a FRESH-claim placement wait after 6 hours", async () => {
    const { app, task } = await setup("retry-fresh-give-up", {
      originalOnline: false,
      // The only linux host is offline, so a linux task waits for it.
      replacementOnline: false,
      branchOnOrigin: true,
    });
    try {
      // A FRESH claim (not a retry): it waits for a linux host that is
      // offline. That wait has no preserved branch behind it, so failing it
      // after 6h frees something — the 6-hour give-up still applies to it.
      const [fresh] = app.db
        .insert(tasks)
        .values({
          projectId: getTask(app, task.id).projectId,
          title: "fresh claim waits for a host",
          body: "Platform: linux",
          status: "claimed",
          resumeQueued: false,
          dispatchHeld: true,
          dispatchFailingSince: new Date(Date.now() - 7 * 60 * 60 * 1000),
          failureReason:
            "this task requires platform linux, and a matching host is registered but not eligible right now",
        })
        .returning()
        .all();

      await dispatchQueuedTasks(app);

      const row = getTask(app, fresh.id);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("gave up after 6h");
    } finally {
      await app.close();
    }
  });

  it("Start fresh abandons the preserved branch and re-queues the task as a new claim", async () => {
    const { app, mac, task } = await setup("retry-start-fresh", {
      originalOnline: false,
      branchOnOrigin: false,
    });
    try {
      await retryTask(app, task.id);
      await vi.waitFor(() => {
        expect(getTask(app, task.id).retryHostId).toBe(mac);
      });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start-fresh` });
      expect(res.statusCode).toBe(202);

      const row = getTask(app, task.id);
      expect(row.status).toBe("claimed");
      expect(row.resumeQueued).toBe(false);
      expect(row.retryHostId).toBeNull();
      // A NEW claim derives its own branch and worktree path — the preserved
      // branch stays on the host that holds it.
      expect(row.branchName).not.toBeNull();
      expect(row.worktreePath).not.toBe(
        `${MAC_CWD}/.mullion-worktrees/mullion-task-9001-retry-replaces`,
      );
    } finally {
      await app.close();
    }
  });

  it("Start fresh works for a wait whose branch origin state could not be confirmed", async () => {
    const { app, mac, task } = await setup("retry-start-fresh-unconfirmed", {
      originalOnline: false,
      branchOnOrigin: false,
    });
    try {
      // The origin lookup cannot even be MADE — a local-only repository, a
      // project with no GitHub token. The branch's whereabouts are UNKNOWN,
      // so the retry waits for its original host (the work may be there) and
      // the wait KEEPS the 6-hour give-up: only a CONFIRMED-stranded branch
      // is exempt from it.
      vi.spyOn(hostGitModule, "resolveRepoRef").mockResolvedValue(null);

      await retryTask(app, task.id);
      await vi.waitFor(() => {
        expect(getTask(app, task.id).retryHostId).toBe(mac);
      });
      expect(getTask(app, task.id).retryStrandedOnHost).toBe(false);
      expect(getTask(app, task.id).branchName).toBe(BRANCH);

      // "Start fresh" is offered for this wait too — it is exactly the wait
      // that would otherwise never end.
      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start-fresh` });
      expect(res.statusCode).toBe(202);

      const row = getTask(app, task.id);
      expect(row.status).toBe("claimed");
      expect(row.resumeQueued).toBe(false);
      expect(row.retryHostId).toBeNull();
      expect(row.retryStrandedOnHost).toBe(false);
      // The preserved branch is abandoned — the row moves to a branch of its
      // own, and the old one stays on the host that holds it.
      expect(row.branchName).not.toBeNull();
      expect(row.branchName).not.toBe(BRANCH);
      expect(row.worktreePath).not.toBe(
        `${MAC_CWD}/.mullion-worktrees/mullion-task-9001-retry-replaces`,
      );
    } finally {
      await app.close();
    }
  });

  it("Start fresh refuses a task that is not waiting for a host", async () => {
    const { app, task } = await setup("retry-start-fresh-not-waiting", {
      originalOnline: false,
      branchOnOrigin: false,
    });
    try {
      // The task has never been retried, so it waits for nobody: there is no
      // preserved branch to abandon, and starting it fresh would throw work
      // away that nobody asked to abandon.
      const res = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start-fresh` });
      expect(res.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("Start fresh answers 404 for a task that does not exist", async () => {
    const { app } = await setup("retry-start-fresh-missing");
    try {
      const res = await app.inject({ method: "POST", url: "/api/tasks/999999/start-fresh" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("Start fresh answers 400 for a task id that is not a number", async () => {
    const { app } = await setup("retry-start-fresh-bad-id");
    try {
      const res = await app.inject({ method: "POST", url: "/api/tasks/not-a-number/start-fresh" });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("Start fresh is refused while Task Master is disabled", async () => {
    // The flag is read when the app is built, so it has to be off BEFORE the
    // app exists.
    const previous = process.env.MULLION_TASK_MASTER_ENABLED;
    process.env.MULLION_TASK_MASTER_ENABLED = "false";
    let app: Awaited<ReturnType<typeof buildApp>> | null = null;
    try {
      const setupResult = await setup("retry-start-fresh-disabled", {
        originalOnline: false,
        branchOnOrigin: false,
      });
      app = setupResult.app;
      // The action starts a session, so it is gated exactly like every other
      // Task Master action.
      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${setupResult.task.id}/start-fresh`,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      if (app) await app.close();
      process.env.MULLION_TASK_MASTER_ENABLED = previous;
    }
  });
});
