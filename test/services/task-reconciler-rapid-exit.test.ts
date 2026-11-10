// A worker whose agent dies within seconds must not spend a rebase attempt or
// complete a suggestions round (src/services/worker-rapid-exit.ts). Its own
// file: the reconciler's test file is at its file-size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockResume,
  mockHermesUsable,
  mockDispatchTaskReview,
} = vi.hoisted(() => ({
  mockResolveRepoRef: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockResume: vi.fn(),
  mockHermesUsable: vi.fn().mockReturnValue(false),
  mockDispatchTaskReview: vi.fn(),
}));

// Hermes is the network edge only; the dispatch sweep itself runs for real.
vi.mock("../../src/services/hermes-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hermesTaskReviewerUsable: mockHermesUsable,
}));
vi.mock("../../src/services/hermes-task-review.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchTaskReview: mockDispatchTaskReview,
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRepoRef: mockResolveRepoRef,
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mockGetPullRequestByNumber,
  fetchPullRequestReviewThreads: vi.fn().mockResolvedValue({ threads: [], truncated: false }),
}));
vi.mock("../../src/services/github.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRunsForHeadChecked: vi.fn().mockResolvedValue({ ok: true, runs: [] }),
}));
vi.mock("../../src/services/git-worktree.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resumeTaskWorktree: mockResume,
}));
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
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawn: vi.fn(() => {
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

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { reconcileTasks, resetMergeBackoff, autoReturnTask } =
  await import("../../src/services/task-reconciler.js");
const { settleRapidRebaseExit, attemptAutoRebase } =
  await import("../../src/services/task-auto-rebase.js");
const { Session } = await import("../../src/services/pty-manager.js");
const { LOCAL_HOST_ID } = await import("../../src/services/host-registry.js");
const { resolveBackend } = await import("../../src/services/session-backend.js");
const reviewSync = await import("../../src/services/task-github-sync.js");
const { RAPID_EXIT_BACKOFF_MS } = await import("../../src/services/worker-rapid-exit.js");
const lifecycle = await import("../../src/services/session-lifecycle.js");
const reseedModule = await import("../../src/services/task-reseed.js");
const commitsPastBase = await import("../../src/services/commits-past-base.js");
const { tasks, sessions, projects } = await import("../../src/db/schema.js");
const { eq, ne } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-rapid-exit-${process.pid}.db`);

function fakeInfo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    activity: "idle",
    attention: false,
    attentionKind: null,
    permissionState: "idle",
    planState: "idle",
    gateState: "idle",
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    elicitationState: "idle",
    elicitationServer: null,
    questionState: "idle",
    questionHeader: null,
    errorState: "idle",
    errorDetail: null,
    endedReason: null,
    exitCode: null,
    compactState: "idle",
    subagentCount: 0,
    lastTurnEndedAt: null,
    // Issue #1735 — the reconciler's worker->review gate reads
    // `workFinishedAt` (the last turn end that meant "the agent's work is
    // done"), not `lastTurnEndedAt` (when a turn ended at all). Derived
    // from the same override so the existing fixtures keep their meaning
    // — "the turn finished → the gate opens" — while a test that is
    // specifically about the work-finished signal can override it
    // independently.
    outstandingBackgroundTasks: [],
    ...overrides,
    // Assigned LAST and only once — it is derived from the same override so
    // the existing fixtures keep their meaning ("the turn finished → the
    // gate opens"), while a test that is specifically about the
    // work-finished signal can override it independently. (Assigning it
    // above the spread as well would just be an overwritten property.)
    workFinishedAt:
      "workFinishedAt" in overrides
        ? (overrides.workFinishedAt as number | null)
        : ((overrides.lastTurnEndedAt as number | null) ?? null),
  };
}

describe("a worker that exits within seconds", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  const apps: Array<{ close: () => Promise<unknown> }> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  function mockPr(
    headSha: string,
    state: { mergeable: boolean | null; mergeableState: string } = {
      mergeable: false,
      mergeableState: "dirty",
    },
  ) {
    mockGetPullRequestByNumber.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      nodeId: "PR_node9",
      draft: false,
      headSha,
      headRef: "mullion/task-x",
      baseRef: "main",
      title: "feat: do the thing",
      state: "open",
      merged: false,
      ...state,
    });
  }

  async function setupProject(name: string) {
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockResume.mockResolvedValue({
      path: "/tmp/.mullion-worktrees/mullion-task-x",
      branch: "mullion/task-x",
    });
    mockPr("sha-head");
    const app = await buildApp();
    apps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name, cwd: "/tmp" },
    });
    const projectId = created.json().id as number;
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { autoApprove: true },
    });
    const [session] = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", cwd: "/tmp", status: "active" })
      .returning()
      .all();
    return { app, projectId, session };
  }

  const getTask = (app: Awaited<ReturnType<typeof buildApp>>, id: number) =>
    app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  // A done task whose PR conflicts and whose last rebase worker was spawned
  // `spawnedAgoMs` ago, finishing `ranMs` after that.
  async function rebaseTask(
    name: string,
    opts: {
      ranMs: number;
      attempts?: number;
      aborted?: number;
      outruns?: number;
      headAtSpawn?: string | null;
    },
  ) {
    const { app, projectId, session } = await setupProject(name);
    const spawnedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 10 * 60_000);
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "conflicted",
        status: "done",
        claimedAt: new Date(),
        completedAt: new Date(),
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
        mergeRequestedAt: new Date(),
        branchName: "mullion/task-x",
        agentCommand: "claude",
        sessionId: session.id,
        rebaseAttempts: opts.attempts ?? 1,
        rebaseAbortedAttempts: opts.aborted ?? 0,
        rebaseOutrunCount: opts.outruns ?? 0,
        rebaseStartedAt: spawnedAt,
        rebaseSpawnHeadSha: opts.headAtSpawn === undefined ? "sha-head" : opts.headAtSpawn,
      })
      .returning()
      .all();
    const finishedAt = spawnedAt.getTime() + opts.ranMs;
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: finishedAt, workFinishedAt: finishedAt }),
    } as never);
    return { app, task };
  }

  it("does not spend a rebase attempt, then respawns after the backoff", async () => {
    const { app, task } = await rebaseTask("p-rapid-rebase", { ranMs: 3_000 });
    const create = vi.spyOn(lifecycle, "createSessionRecord");
    const warn = vi.spyOn(app.log, "warn");

    await reconcileTasks(app);

    let row = getTask(app, task.id);
    expect(row.rebaseAttempts).toBe(0);
    expect(row.rebaseAbortedAttempts).toBe(1);
    expect(row.rebaseSpawnHeadSha).toBeNull();
    expect(row.rapidExitRetryAfter!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, sessionId: row.sessionId, elapsedSeconds: 3 }),
      expect.stringContaining("exited within seconds"),
    );

    app.db
      .update(tasks)
      .set({ rapidExitRetryAfter: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, task.id))
      .run();
    resetMergeBackoff(task.id);
    const [respawned] = app.db
      .insert(sessions)
      .values({ projectId: task.projectId, command: "claude", cwd: "/tmp", status: "active" })
      .returning()
      .all();
    create.mockResolvedValue({
      ok: true,
      row: { id: respawned.id },
      initialPromptApplied: true,
    } as never);
    await reconcileTasks(app);

    row = getTask(app, task.id);
    expect(create).toHaveBeenCalledTimes(1);
    expect(row.rebaseAttempts).toBe(1);
    expect(row.rebaseSpawnHeadSha).toBe("sha-head");
    expect(row.rapidExitRetryAfter).toBeNull();
  });

  it("spawns no reviewer during the backoff, and one once the backoff ends", async () => {
    const { app, task } = await rebaseTask("p-rapid-no-reviewer", { ranMs: 3_000 });
    const create = vi.spyOn(lifecycle, "createSessionRecord");
    app.db
      .update(projects)
      .set({ defaultReviewAgent: "claude" })
      .where(eq(projects.id, task.projectId))
      .run();

    await reconcileTasks(app); // aborts the rapid-exit rebase, starts the backoff
    expect(getTask(app, task.id).rebaseStartedAt).toBeNull();
    expect(getTask(app, task.id).rapidExitRetryAfter).not.toBeNull();

    // The shape the abort leaves behind: rebaseStartedAt is null, so only the
    // backoff stamp can hold the reviewer spawn back.
    app.db
      .update(tasks)
      .set({
        status: "reviewing",
        reviewingAt: new Date(Date.now() - 3_600_000), // past the CI wait
        completedAt: null,
        worktreePath: "/tmp/.mullion-worktrees/mullion-task-x",
        reviewSessionId: null,
        reviewRunId: null,
      })
      .where(eq(tasks.id, task.id))
      .run();

    await reconcileTasks(app); // a sweep inside the backoff
    expect(create).not.toHaveBeenCalled();
    expect(getTask(app, task.id).reviewSessionId).toBeNull();
    expect(getTask(app, task.id).reviewSpawnClaimedAt).toBeNull();

    app.db
      .update(tasks)
      .set({ rapidExitRetryAfter: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, task.id))
      .run();
    await reconcileTasks(app); // past the backoff the held reviewer is eligible again
    expect(create).toHaveBeenCalled();
  });

  it("spawns nothing on a sweep inside the backoff, and retries the rebase once it ends", async () => {
    const { app, task } = await rebaseTask("p-rapid-backoff-sweep", { ranMs: 3_000 });
    // A configured review agent must not be spawned in the backoff either.
    app.db
      .update(projects)
      .set({ defaultReviewAgent: "claude" })
      .where(eq(projects.id, task.projectId))
      .run();
    const create = vi.spyOn(lifecycle, "createSessionRecord");

    await reconcileTasks(app); // aborts the rapid-exit rebase, starts the backoff
    expect(getTask(app, task.id).rebaseAbortedAttempts).toBe(1);

    resetMergeBackoff(task.id);
    await reconcileTasks(app); // a sweep inside the backoff
    let row = getTask(app, task.id);
    expect(create).not.toHaveBeenCalled();
    expect(row.rebaseAttempts).toBe(0);
    expect(row.rebaseAbortedAttempts).toBe(1);
    expect(row.rapidExitRetryAfter).not.toBeNull();
    expect(row.reviewSessionId).toBeNull();

    app.db
      .update(tasks)
      .set({ rapidExitRetryAfter: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, task.id))
      .run();
    resetMergeBackoff(task.id);
    const [respawned] = app.db
      .insert(sessions)
      .values({ projectId: task.projectId, command: "claude", cwd: "/tmp", status: "active" })
      .returning()
      .all();
    create.mockResolvedValue({
      ok: true,
      row: { id: respawned.id },
      initialPromptApplied: true,
    } as never);
    await reconcileTasks(app); // the backoff is over: the rebase is retried
    row = getTask(app, task.id);
    expect(create).toHaveBeenCalledTimes(1);
    expect(row.rebaseAttempts).toBe(1);
    expect(row.sessionId).toBe(respawned.id);
    expect(row.rapidExitRetryAfter).toBeNull();
  });

  it.each(["finished", "api_error"] as const)(
    "retries a %s abort after backoff, terminating the carried reviewer without posting again",
    async (ending) => {
      const { app, task } = await rebaseTask(`p-rapid-reviewer-${ending}`, { ranMs: 3_000 });
      // Use the real manager map and termination path: a permanent get() mock
      // would falsely keep returning api_error info after the session is killed.
      vi.spyOn(app.pty, "get").mockRestore();
      vi.spyOn(Session.prototype, "spawn").mockResolvedValue();
      const worker = app.pty.getOrCreate({
        id: String(task.sessionId),
        command: "claude",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      });
      const endedAt = task.rebaseStartedAt!.getTime() + 3_000;
      vi.spyOn(worker, "toInfo").mockReturnValue(
        fakeInfo(
          ending === "api_error"
            ? { errorState: "api_error", errorDetail: "overloaded", errorAt: endedAt }
            : { lastTurnEndedAt: endedAt, workFinishedAt: endedAt },
        ) as never,
      );
      const [reviewer] = app.db
        .insert(sessions)
        .values({
          projectId: task.projectId,
          command: "claude",
          cwd: "/tmp",
          status: "active",
        })
        .returning()
        .all();
      app.pty.getOrCreate({
        id: String(reviewer.id),
        command: "claude",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      });
      app.db
        .update(projects)
        .set({ defaultReviewAgent: "claude" })
        .where(eq(projects.id, task.projectId))
        .run();
      app.db
        .update(tasks)
        .set({
          status: "reviewing",
          completedAt: null,
          mergeRequestedAt: null,
          reviewingAt: new Date(Date.now() - 3_600_000),
          worktreePath: "/tmp/.mullion-worktrees/mullion-task-x",
          approvalCarriedAt: new Date(),
          reviewSessionId: reviewer.id,
          reviewFindingsIngestedSessionId: reviewer.id,
          lastReviewVerdict: "approved",
          lastReviewVerdictAt: new Date(),
        })
        .where(eq(tasks.id, task.id))
        .run();
      const terminate = vi.spyOn(app.pty, "terminate");
      const post = vi.spyOn(reviewSync, "postReviewFindingsComment");
      const create = vi.spyOn(lifecycle, "createSessionRecord");
      const t0 = Math.floor(Date.now() / 1000) * 1000;
      const now = vi.spyOn(Date, "now").mockReturnValue(t0);

      await reconcileTasks(app);
      let row = getTask(app, task.id);
      expect(row.rebaseStartedAt).toBeNull();
      expect(row.rebaseAttempts).toBe(0);
      expect(row.rebaseAbortedAttempts).toBe(1);
      expect(row.rapidExitRetryAfter!.getTime()).toBe(t0 + RAPID_EXIT_BACKOFF_MS);
      expect(terminate).toHaveBeenCalledExactlyOnceWith(String(task.sessionId));
      expect(app.pty.get(String(task.sessionId))).toBeUndefined();
      expect(
        await resolveBackend(app, LOCAL_HOST_ID).liveStatus([String(task.sessionId)], 1000),
      ).toEqual({
        [String(task.sessionId)]: null,
      });
      expect(
        app.db.select().from(sessions).where(eq(sessions.id, task.sessionId!)).get()!.status,
      ).toBe("killed");
      expect(row.reviewSessionId).toBe(reviewer.id);
      expect(app.pty.get(String(reviewer.id))).toBeDefined();
      expect(create).not.toHaveBeenCalled();

      now.mockReturnValue(t0 + 2 * 60_000);
      await reconcileTasks(app);
      expect(create).not.toHaveBeenCalled();
      expect(terminate).not.toHaveBeenCalledWith(String(reviewer.id));
      expect(getTask(app, task.id).reviewSessionId).toBe(reviewer.id);

      const [respawned] = app.db
        .insert(sessions)
        .values({
          projectId: task.projectId,
          command: "claude",
          cwd: "/tmp",
          status: "active",
        })
        .returning()
        .all();
      create.mockResolvedValue({
        ok: true,
        row: { id: respawned.id },
        initialPromptApplied: true,
      } as never);
      // Ten minutes plus one second: no additional 30-minute suggestions hold.
      now.mockReturnValue(t0 + RAPID_EXIT_BACKOFF_MS + 1000);
      await reconcileTasks(app);
      row = getTask(app, task.id);
      expect(create).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledWith(String(reviewer.id));
      expect(app.pty.get(String(reviewer.id))).toBeUndefined();
      expect(app.db.select().from(sessions).where(eq(sessions.id, reviewer.id)).get()!.status).toBe(
        "killed",
      );
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewFindingsIngestedSessionId).toBeNull();
      expect(row.sessionId).toBe(respawned.id);
      expect(row.rebaseAttempts).toBe(1);
      expect(row.rebaseStartedAt).not.toBeNull();
      expect(row.rapidExitRetryAfter).toBeNull();
      await reconcileTasks(app);
      expect(post).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
    },
  );

  it("still counts a normal rebase session", async () => {
    const { app, task } = await rebaseTask("p-normal-rebase", { ranMs: 5 * 60_000 });
    await reconcileTasks(app);
    const row = getTask(app, task.id);
    expect(row.rebaseAttempts).toBe(1);
    expect(row.rebaseAbortedAttempts).toBe(0);
    expect(row.rebaseSpawnHeadSha).toBeNull();
  });

  it("counts a quick rebase that moved the PR head", async () => {
    const { app, task } = await rebaseTask("p-quick-rebase", {
      ranMs: 3_000,
      headAtSpawn: "sha-before",
    });
    await reconcileTasks(app);
    const row = getTask(app, task.id);
    expect(row.rebaseAttempts).toBe(1);
    expect(row.rebaseAbortedAttempts).toBe(0);
  });

  it("fails open when the PR head cannot be read", async () => {
    const { app, task } = await rebaseTask("p-unreadable-head", { ranMs: 3_000 });
    mockGetPullRequestByNumber.mockRejectedValue(new Error("github down"));
    await reconcileTasks(app);
    const row = getTask(app, task.id);
    expect(row.rebaseAttempts).toBe(1);
    expect(row.rebaseAbortedAttempts).toBe(0);
  });

  it("stops refunding at the third aborted attempt, so the normal give-up applies", async () => {
    const { app, task } = await rebaseTask("p-capped-rebase", {
      ranMs: 3_000,
      attempts: 1,
      aborted: 2,
    });
    const create = vi.spyOn(lifecycle, "createSessionRecord");
    await reconcileTasks(app);
    const row = getTask(app, task.id);
    expect(row.rebaseAbortedAttempts).toBe(3);
    expect(row.rebaseAttempts).toBe(2);
    expect(row.mergeError).toContain("gave up after 2 attempt(s)");
    expect(create).not.toHaveBeenCalled();
  });

  // The worker ran for minutes and pushed (PR head moved off the spawn head).
  describe("a rebase that landed a head main then outran", () => {
    const pushed = { ranMs: 5 * 60_000, headAtSpawn: "sha-before" };

    it("refunds the attempt when GitHub reports the pushed head mergeable", async () => {
      const { app, task } = await rebaseTask("p-outrun-refund", pushed);
      mockPr("sha-after", { mergeable: true, mergeableState: "clean" });
      await reconcileTasks(app);
      const row = getTask(app, task.id);
      expect(row.rebaseAttempts).toBe(0);
      expect(row.rebaseOutrunCount).toBe(1);
      expect(row.rebaseSpawnHeadSha).toBeNull();
    });

    it("does not refund a head that is still conflicting", async () => {
      const { app, task } = await rebaseTask("p-outrun-dirty", pushed);
      mockPr("sha-after");
      await reconcileTasks(app);
      const row = getTask(app, task.id);
      expect(row.rebaseAttempts).toBe(1);
      expect(row.rebaseOutrunCount).toBe(0);
    });

    it("stops refunding after the fifth outrun", async () => {
      const { app, task } = await rebaseTask("p-outrun-cap", { ...pushed, outruns: 5 });
      mockPr("sha-after", { mergeable: true, mergeableState: "clean" });
      await reconcileTasks(app);
      const row = getTask(app, task.id);
      expect(row.rebaseAttempts).toBe(1);
      expect(row.rebaseOutrunCount).toBe(5);
    });

    it("does not refund while GitHub is still computing, then refunds on a clean later tick", async () => {
      const { app, task } = await rebaseTask("p-outrun-null", pushed);
      mockPr("sha-after", { mergeable: null, mergeableState: "unknown" });
      await reconcileTasks(app);
      let row = getTask(app, task.id);
      expect(row.rebaseAttempts).toBe(1);
      expect(row.rebaseOutrunCount).toBe(0);
      // Undetermined: the attempt marker survives so a later tick judges it.
      expect(row.rebaseSpawnHeadSha).toBe("sha-before");

      resetMergeBackoff(task.id);
      mockPr("sha-after", { mergeable: true, mergeableState: "clean" });
      await reconcileTasks(app);
      row = getTask(app, task.id);
      expect(row.rebaseAttempts).toBe(0);
      expect(row.rebaseOutrunCount).toBe(1);
      expect(row.rebaseSpawnHeadSha).toBeNull();
    });

    it("refunds a reviewing task's finished attempt at the auto-approve tick", async () => {
      const { app, task } = await rebaseTask("p-outrun-reviewing", pushed);
      app.db
        .update(tasks)
        .set({
          status: "reviewing",
          reviewingAt: new Date(),
          lastReviewVerdict: "clean",
          mergeRequestedAt: null,
        })
        .where(eq(tasks.id, task.id))
        .run();
      mockPr("sha-after", { mergeable: true, mergeableState: "clean" });
      await reconcileTasks(app);
      const row = getTask(app, task.id);
      expect(row.rebaseAttempts).toBe(0);
      expect(row.rebaseOutrunCount).toBe(1);
      expect(row.rebaseSpawnHeadSha).toBeNull();
    });

    it("keeps the hold-back and marker on a reviewing task when the settle read is still computing", async () => {
      const { app, task } = await rebaseTask("p-outrun-reviewing-null", pushed);
      app.db
        .update(tasks)
        .set({
          status: "reviewing",
          reviewingAt: new Date(),
          lastReviewVerdict: "clean",
          mergeRequestedAt: null,
          mergeError: "stale merge error",
        })
        .where(eq(tasks.id, task.id))
        .run();
      // The DB is shared across this file: rows left by earlier tests would be
      // swept in the same tick and consume the one-shot PR read below, so the
      // settle block never ran. Leave this task as the only one.
      app.db.delete(tasks).where(ne(tasks.id, task.id)).run();
      // First read (the tick's) is clean; the settle re-read is still computing.
      mockPr("sha-after", { mergeable: null, mergeableState: "unknown" });
      const computing = await mockGetPullRequestByNumber();
      mockPr("sha-after", { mergeable: true, mergeableState: "clean" });
      const clean = await mockGetPullRequestByNumber();
      mockGetPullRequestByNumber.mockReset();
      mockGetPullRequestByNumber.mockResolvedValueOnce(clean).mockResolvedValue(computing);
      await reconcileTasks(app);
      let row = getTask(app, task.id);
      expect(row.rebaseAttempts).toBe(1);
      expect(row.rebaseSpawnHeadSha).toBe("sha-before");
      expect(row.rebaseStartedAt).not.toBeNull();
      // The settle block ran (it clears the stale merge error); only the
      // refund was withheld.
      expect(row.mergeError).toBeNull();

      mockGetPullRequestByNumber.mockReset();
      mockGetPullRequestByNumber.mockResolvedValue(clean);
      await reconcileTasks(app);
      row = getTask(app, task.id);
      expect(row.rebaseAttempts).toBe(0);
      expect(row.rebaseOutrunCount).toBe(1);
      expect(row.rebaseSpawnHeadSha).toBeNull();
    });

    it("keeps the attempt marker when the PR cannot be read", async () => {
      const { app, task } = await rebaseTask("p-outrun-unreadable", pushed);
      mockGetPullRequestByNumber.mockRejectedValue(new Error("github down"));
      await reconcileTasks(app);
      const row = getTask(app, task.id);
      expect(row.rebaseAttempts).toBe(1);
      expect(row.rebaseSpawnHeadSha).toBe("sha-before");
    });
  });

  it("settles a reviewing task's rapid rebase exit through auto-approve", async () => {
    const { app, projectId, session } = await setupProject("p-rapid-reviewing");
    const [reviewer] = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", cwd: "/tmp", status: "active" })
      .returning()
      .all();
    const spawnedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 10 * 60_000);
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "reviewing conflict",
        status: "reviewing",
        claimedAt: spawnedAt,
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
        branchName: "mullion/task-x",
        agentCommand: "claude",
        sessionId: session.id,
        reviewSessionId: reviewer.id,
        reviewFindingsIngestedSessionId: reviewer.id,
        lastReviewVerdict: "approved",
        lastReviewVerdictAt: new Date(spawnedAt.getTime() - 60_000),
        lastReviewedHeadSha: "sha-head",
        rebaseAttempts: 1,
        rebaseStartedAt: spawnedAt,
        rebaseSpawnHeadSha: "sha-head",
      })
      .returning()
      .all();
    const finishedAt = spawnedAt.getTime() + 3_000;
    const toInfo = vi.fn(() =>
      fakeInfo({ lastTurnEndedAt: finishedAt, workFinishedAt: finishedAt }),
    );
    vi.spyOn(app.pty, "get").mockReturnValue({ toInfo } as never);
    const create = vi.spyOn(lifecycle, "createSessionRecord");

    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.rebaseAttempts).toBe(0);
    expect(row.rebaseAbortedAttempts).toBe(1);
    expect(row.rapidExitRetryAfter!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(create).not.toHaveBeenCalled();
  });

  it("looks at a still-running rebase worker once per tick on the auto-approve path", async () => {
    const { app, projectId, session } = await setupProject("p-settle-once");
    const [reviewer] = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", cwd: "/tmp", status: "active" })
      .returning()
      .all();
    const spawnedAt = new Date(Date.now() - 60_000);
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "running rebase",
        status: "reviewing",
        claimedAt: spawnedAt,
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
        branchName: "mullion/task-x",
        agentCommand: "claude",
        sessionId: session.id,
        reviewSessionId: reviewer.id,
        reviewFindingsIngestedSessionId: reviewer.id,
        lastReviewVerdict: "approved",
        lastReviewVerdictAt: new Date(spawnedAt.getTime() - 60_000),
        lastReviewedHeadSha: "sha-head",
        rebaseAttempts: 1,
        rebaseStartedAt: spawnedAt,
        rebaseSpawnHeadSha: "sha-head",
      })
      .returning()
      .all();
    const get = vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ workFinishedAt: null }),
    } as never);

    await reconcileTasks(app);

    expect(getTask(app, task.id).rebaseAttempts).toBe(1);
    const workerLookups = get.mock.calls.filter((c) => String(c[0]) === String(session.id));
    expect(workerLookups).toHaveLength(1);
  });

  // A suggestions round: the approved review's nits sent back to the worker,
  // approval carried, and a worker whose turn "finished" `ranMs` after the
  // round was seeded.
  async function suggestionsTask(name: string, opts: { ranMs: number; exits?: number }) {
    const { app, projectId, session } = await setupProject(name);
    const seededAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60_000);
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "nits",
        status: "in_progress",
        sessionId: session.id,
        claimedAt: seededAt,
        startedAt: seededAt,
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
        branchName: "mullion/task-x",
        worktreePath: "/tmp/.mullion-worktrees/mullion-task-x",
        agentCommand: "claude",
        reviewSessionId: session.id,
        lastReviewVerdict: "approved-with-suggestions",
        lastReviewVerdictAt: new Date(seededAt.getTime() - 60_000),
        lastReviewedHeadSha: "sha-head",
        lastAutoReturnReason: "suggestions",
        approvalCarriedAt: seededAt,
        suggestionsSeedPrompt: "apply the nits",
        suggestionsRapidExits: opts.exits ?? 0,
      })
      .returning()
      .all();
    const finishedAt = seededAt.getTime() + opts.ranMs;
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: finishedAt, workFinishedAt: finishedAt }),
    } as never);
    return { app, task };
  }

  it("re-seeds a suggestions worker that ended in 20 s with the head unchanged, instead of completing the round", async () => {
    const { app, task } = await suggestionsTask("p-rapid-suggestions", { ranMs: 20_000 });
    const reseed = vi.spyOn(reseedModule, "reseedTaskIfSessionExited").mockResolvedValue(true);

    await reconcileTasks(app);

    let row = getTask(app, task.id);
    expect(row.status).toBe("in_progress");
    expect(row.suggestionsRapidExits).toBe(1);
    expect(row.rapidExitRetryAfter).not.toBeNull();
    expect(reseed).not.toHaveBeenCalled();

    app.db
      .update(tasks)
      .set({ rapidExitRetryAfter: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, task.id))
      .run();
    resetMergeBackoff(task.id);
    await reconcileTasks(app);

    row = getTask(app, task.id);
    expect(reseed).toHaveBeenCalledTimes(1);
    expect(reseed.mock.calls[0][3]).toBe("apply the nits");
    expect(row.status).toBe("in_progress");
    expect(row.rapidExitRetryAfter).toBeNull();
    expect(row.claimedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("judges a null-workFinishedAt api_error death by its error time, not by failing open", async () => {
    const { app, task } = await suggestionsTask("p-null-finish-suggestions", { ranMs: 20_000 });
    const errorAt = task.claimedAt!.getTime() + 20_000;
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          errorState: "api_error",
          errorDetail: "overloaded",
          errorAt,
          workFinishedAt: null,
        }),
    } as never);
    vi.spyOn(reseedModule, "reseedTaskIfSessionExited").mockResolvedValue(true);

    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.status).toBe("in_progress");
    expect(row.suggestionsRapidExits).toBe(1);
    expect(row.rapidExitRetryAfter).not.toBeNull();
  });

  it("still completes the round for a null-workFinishedAt api_error death that ran long", async () => {
    const { app, task } = await suggestionsTask("p-null-finish-long", { ranMs: 20_000 });
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          errorState: "api_error",
          errorDetail: "overloaded",
          errorAt: task.claimedAt!.getTime() + 5 * 60_000,
          workFinishedAt: null,
        }),
    } as never);

    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.status).toBe("reviewing");
    expect(row.suggestionsRapidExits).toBe(0);
  });

  it("judges a null-workFinishedAt api_error rebase worker as a rapid exit", async () => {
    const { app, task } = await rebaseTask("p-rapid-rebase-api-error", { ranMs: 3_000 });
    const errorAt = task.rebaseStartedAt!.getTime() + 3_000;
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          errorState: "api_error",
          errorDetail: "overloaded",
          errorAt,
          lastTurnEndedAt: null,
          workFinishedAt: null,
        }),
    } as never);

    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.rebaseAttempts).toBe(0);
    expect(row.rebaseAbortedAttempts).toBe(1);
    expect(row.rebaseStartedAt).toBeNull();
    expect(row.rapidExitRetryAfter).not.toBeNull();
  });

  it("does not terminate or count a live rebase worker whose mid-loop turn ended within the window", async () => {
    const { app, task } = await rebaseTask("p-rebase-mid-loop-turn", { ranMs: 3_000 });
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          // A machine-woken turn end: lastTurnEndedAt moves, workFinishedAt does not.
          lastTurnEndedAt: task.rebaseStartedAt!.getTime() + 3_000,
          workFinishedAt: null,
          errorAt: null,
        }),
    } as never);

    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.rebaseAbortedAttempts).toBe(0);
    expect(row.rebaseAttempts).toBe(1);
    expect(row.rebaseStartedAt).not.toBeNull();
    expect(row.rapidExitRetryAfter).toBeNull();
  });

  it("does not count a live rebase worker with a stale non-api_error errorAt as a rapid exit", async () => {
    const { app, task } = await rebaseTask("p-rebase-recovered-error", { ranMs: 3_000 });
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          // Production nulls errorAt together with errorState, so a bare
          // "idle + errorAt" never exists. A live worker with a non-null errorAt
          // and no api_error is a tool failure it is still working through.
          errorState: "tool_failure",
          errorAt: task.rebaseStartedAt!.getTime() + 2_000,
          activity: "working",
          lastTurnEndedAt: null,
          workFinishedAt: null,
        }),
    } as never);

    await reconcileTasks(app);

    expect(getTask(app, task.id).rebaseAbortedAttempts).toBe(0);
  });

  it.each([
    ["lastTurnEndedAt", (t: number) => ({ lastTurnEndedAt: t, workFinishedAt: null })],
    [
      "errorAt",
      (t: number) => ({
        errorState: "api_error",
        errorDetail: "overloaded",
        errorAt: t,
        lastTurnEndedAt: null,
        workFinishedAt: null,
      }),
    ],
  ])(
    "judges a killed rebase worker whose only end signal is %s as a rapid exit",
    async (_signal, signal) => {
      const { app, task } = await rebaseTask(`p-rapid-gone-${_signal}`, { ranMs: 3_000 });
      app.db
        .update(sessions)
        .set({ status: "killed" })
        .where(eq(sessions.id, task.sessionId!))
        .run();
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo(signal(task.rebaseStartedAt!.getTime() + 3_000)),
      } as never);

      await reconcileTasks(app);

      const row = getTask(app, task.id);
      expect(row.rebaseAbortedAttempts).toBe(1);
      expect(row.rebaseAttempts).toBe(0);
      expect(row.rebaseStartedAt).toBeNull();
      expect(row.rapidExitRetryAfter).not.toBeNull();
    },
  );

  describe("an aborted rebase worker whose terminate failed or was skipped", () => {
    // A reviewing task with a carried approval is the only shape where
    // findRebaseBlocker consults the (dead) worker's session at all.
    async function abortedThenRetried(name: string, opts: { sessionStatus: "active" | "exited" }) {
      const { app, task } = await rebaseTask(name, { ranMs: 3_000 });
      vi.spyOn(app.pty, "get").mockRestore();
      vi.spyOn(Session.prototype, "spawn").mockResolvedValue();
      const worker = app.pty.getOrCreate({
        id: String(task.sessionId),
        command: "claude",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      });
      const endedAt = task.rebaseStartedAt!.getTime() + 3_000;
      // The api_error death: workFinishedAt stays null, so a session left in
      // the map reads as a suggestions round still in flight.
      vi.spyOn(worker, "toInfo").mockReturnValue(
        fakeInfo({ errorState: "api_error", errorDetail: "overloaded", errorAt: endedAt }) as never,
      );
      app.db
        .update(sessions)
        .set({ status: opts.sessionStatus })
        .where(eq(sessions.id, task.sessionId!))
        .run();
      app.db
        .update(tasks)
        .set({
          status: "reviewing",
          completedAt: null,
          mergeRequestedAt: null,
          reviewingAt: new Date(Date.now() - 3_600_000),
          worktreePath: "/tmp/.mullion-worktrees/mullion-task-x",
          approvalCarriedAt: new Date(),
        })
        .where(eq(tasks.id, task.id))
        .run();
      const create = vi.spyOn(lifecycle, "createSessionRecord");
      const t0 = Math.floor(Date.now() / 1000) * 1000;
      const now = vi.spyOn(Date, "now").mockReturnValue(t0);
      return { app, task, create, now, t0 };
    }

    async function expectRetryAtBackoff(ctx: Awaited<ReturnType<typeof abortedThenRetried>>) {
      const { app, task, create, now, t0 } = ctx;
      const project = app.db.select().from(projects).where(eq(projects.id, task.projectId)).get()!;
      // The sweep's judgement of the rapid-exit worker, then the retry attempt.
      await settleRapidRebaseExit(app, getTask(app, task.id), project);
      expect(getTask(app, task.id).rebaseAbortedAttempts).toBe(1);
      // The dead session is still in the map (terminate failed or was skipped).
      expect(app.pty.get(String(task.sessionId))).toBeDefined();
      expect(create).not.toHaveBeenCalled();

      const [respawned] = app.db
        .insert(sessions)
        .values({ projectId: task.projectId, command: "claude", cwd: "/tmp", status: "active" })
        .returning()
        .all();
      create.mockResolvedValue({
        ok: true,
        row: { id: respawned.id },
        initialPromptApplied: true,
      } as never);
      // Just past the backoff, far inside the 30 min suggestions-round hold.
      now.mockReturnValue(t0 + RAPID_EXIT_BACKOFF_MS + 1000);
      await attemptAutoRebase(app, getTask(app, task.id), project, "main");
      const row = getTask(app, task.id);
      expect(create).toHaveBeenCalledTimes(1);
      expect(row.sessionId).toBe(respawned.id);
      expect(row.rebaseAttempts).toBe(1);
      expect(row.mergeError ?? "").not.toContain("suggestions round is in flight");
    }

    it("retries at the backoff when the terminate throws", async () => {
      const ctx = await abortedThenRetried("p-abort-terminate-throws", { sessionStatus: "active" });
      // A transient failure: the sweep's best-effort stop throws once, and the
      // retry's own stop of the old worker then succeeds.
      vi.spyOn(ctx.app.pty, "terminate").mockRejectedValueOnce(new Error("scope busy"));
      await expectRetryAtBackoff(ctx);
    });

    it("retries at the backoff when the session was not active, so the terminate was skipped", async () => {
      const ctx = await abortedThenRetried("p-abort-not-active", { sessionStatus: "exited" });
      const terminate = vi.spyOn(ctx.app.pty, "terminate");
      await expectRetryAtBackoff(ctx);
      expect(terminate).not.toHaveBeenCalledWith(String(ctx.task.sessionId));
    });
  });

  it("sets no backoff hold when the rapid-exit abort exhausts the attempts", async () => {
    const { app, task } = await rebaseTask("p-exhausted-no-hold", {
      ranMs: 3_000,
      attempts: 1,
      aborted: 2,
    });
    await reconcileTasks(app);
    const row = getTask(app, task.id);
    expect(row.rebaseAbortedAttempts).toBe(3);
    expect(row.rapidExitRetryAfter).toBeNull();
  });

  it("starts no Hermes run during the rapid-exit backoff, and one once it ends", async () => {
    mockHermesUsable.mockReturnValue(true);
    mockDispatchTaskReview.mockRejectedValue(new Error("stop after dispatch"));
    const { app, task } = await rebaseTask("p-rapid-no-hermes", { ranMs: 3_000 });
    app.db
      .update(projects)
      .set({ defaultReviewAgent: "hermes" })
      .where(eq(projects.id, task.projectId))
      .run();
    app.db
      .update(tasks)
      .set({
        status: "reviewing",
        reviewingAt: new Date(Date.now() - 3_600_000),
        completedAt: null,
        worktreePath: "/tmp/.mullion-worktrees/mullion-task-x",
        rebaseStartedAt: null,
        rebaseSpawnHeadSha: null,
        reviewSessionId: null,
        reviewRunId: null,
        rapidExitRetryAfter: new Date(Date.now() + 5 * 60_000),
      })
      .where(eq(tasks.id, task.id))
      .run();

    await reconcileTasks(app);
    expect(mockDispatchTaskReview).not.toHaveBeenCalled();

    app.db
      .update(tasks)
      .set({ rapidExitRetryAfter: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, task.id))
      .run();
    await reconcileTasks(app);
    expect(mockDispatchTaskReview).toHaveBeenCalled();
    mockHermesUsable.mockReturnValue(false);
  });

  it("does not judge a rate-limit-grace worker with commits as a rapid exit", async () => {
    const { app, task } = await suggestionsTask("p-grace-not-rapid", { ranMs: 20_000 });
    app.db
      .update(tasks)
      .set({ lastRateLimitAt: new Date(task.claimedAt!.getTime() + 20_000) })
      .where(eq(tasks.id, task.id))
      .run();
    vi.spyOn(commitsPastBase, "resolveCommitsPastBase").mockResolvedValue({
      state: "ahead",
    } as never);
    // Only the durable grace admits the task. An errorAt inside the rapid window makes sessionEndedAt(info) non-null, so
    // only the guarded endedAt keeps this from being judged a rapid exit.
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () =>
        fakeInfo({
          lastTurnEndedAt: null,
          workFinishedAt: null,
          errorState: "tool_failure",
          activity: "working",
          errorAt: task.claimedAt!.getTime() + 20_000,
        }),
    } as never);

    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.suggestionsRapidExits).toBe(0);
    expect(row.rapidExitRetryAfter).toBeNull();
    expect(row.status).toBe("reviewing");
  });

  it("leaves no backoff stamp behind a round that completes, so a following rebase is not delayed", async () => {
    const { app, task } = await suggestionsTask("p-stamp-cleared", { ranMs: 5 * 60_000 });
    // A stamp left by an earlier consumer, on a task whose round is not the
    // suggestions kind that would honour and clear it.
    app.db
      .update(tasks)
      .set({ rapidExitRetryAfter: new Date(Date.now() + 600_000), lastAutoReturnReason: null })
      .where(eq(tasks.id, task.id))
      .run();

    await reconcileTasks(app);

    expect(getTask(app, task.id).status).toBe("reviewing");
    expect(getTask(app, task.id).rapidExitRetryAfter).toBeNull();
  });

  it("flags a second rapid exit for a human and keeps the approval carried", async () => {
    const { app, task } = await suggestionsTask("p-rapid-suggestions-twice", {
      ranMs: 20_000,
      exits: 1,
    });
    vi.spyOn(reseedModule, "reseedTaskIfSessionExited").mockResolvedValue(true);

    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.status).toBe("reviewing");
    expect(row.approvalCarriedAt).not.toBeNull();
    expect(row.needsHumanReason).toBe("no-progress");
    expect(row.autoReturnCapAnnouncedAt).not.toBeNull();
  });

  it("does not penalise a suggestions worker that moved the head quickly", async () => {
    const { app, task } = await suggestionsTask("p-quick-suggestions", { ranMs: 20_000 });
    mockPr("sha-fixed");
    const reseed = vi.spyOn(reseedModule, "reseedTaskIfSessionExited").mockResolvedValue(true);

    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.status).toBe("reviewing");
    expect(row.suggestionsRapidExits).toBe(0);
    expect(row.needsHumanReason).toBeNull();
    expect(reseed).not.toHaveBeenCalled();
  });

  it("resets the rapid-exit ledger whenever autoReturnTask seeds a suggestions round", async () => {
    const { app, projectId, session } = await setupProject("p-seed-reset");
    const reseed = vi.spyOn(reseedModule, "reseedTaskIfSessionExited").mockResolvedValue(true);
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "batch",
        status: "reviewing",
        sessionId: session.id,
        prNumber: 9,
        branchName: "mullion/task-x",
        worktreePath: "/tmp/.mullion-worktrees/mullion-task-x",
        agentCommand: "claude",
        reviewSessionId: session.id,
        lastReviewVerdict: "approved-with-suggestions",
        lastReviewVerdictAt: new Date(Date.now() - 60_000),
        lastReviewedHeadSha: "sha-head",
        suggestionsSeedPrompt: "OLD round prompt",
        suggestionsRapidExits: 1,
        rapidExitRetryAfter: new Date(Date.now() + 600_000),
      })
      .returning()
      .all();
    const project = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!;

    const res = await autoReturnTask(app, task, project, {
      reason: "suggestions",
      seedPrompt: "NEW comments-batch prompt",
    });

    expect(res.ok).toBe(true);
    const row = getTask(app, task.id);
    expect(row.suggestionsSeedPrompt).toBe("NEW comments-batch prompt");
    expect(row.suggestionsRapidExits).toBe(0);
    expect(row.rapidExitRetryAfter).toBeNull();

    // End to end: the new round's worker ends in 20 s with the head unchanged;
    // the guard re-seeds the NEW prompt, not the previous round's.
    const finishedAt = row.claimedAt!.getTime() + 20_000;
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: finishedAt, workFinishedAt: finishedAt }),
    } as never);
    await reconcileTasks(app);
    expect(getTask(app, task.id).suggestionsRapidExits).toBe(1);
    app.db
      .update(tasks)
      .set({ rapidExitRetryAfter: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, task.id))
      .run();
    resetMergeBackoff(task.id);
    await reconcileTasks(app);
    expect(reseed).toHaveBeenCalledTimes(2);
    expect(reseed.mock.calls[1][3]).toBe("NEW comments-batch prompt");
  });
});
