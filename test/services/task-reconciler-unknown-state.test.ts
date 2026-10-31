// #2416 — the "we could not find out" states, at the call sites that used to
// swallow a failure and report it as a resolved answer.
//
// One defect class, three call sites:
//
//   A) the git-status read that decides whether a worker committed past the
//      task's base SHA. It is read at the budget-salvage gate AND at the
//      rate-limit-grace gate, which use the same answer with OPPOSITE
//      polarity: "no commits" fails the task at one and keeps it alive at
//      the other. An unreadable worktree used to be "no commits" at both.
//   B) the check-runs read on an `unstable` PR, which decides whether the
//      title-lint self-heal (#1035) can run. A failed lookup used to read as
//      "no checks", so the self-heal never ran and nothing said why.
//
// The reconciler's own test file (test/services/task-reconciler.test.ts)
// covers the OUTCOMES these gates produce and stays their regression net;
// this file covers the new part: an unreadable worktree and an unanswered
// check-runs lookup are told apart from "there is nothing there", and said
// — in the log, and (for the merge hold) in the operator's message.
//
// The harness is deliberately small: a temp DB, a real app, and the handful
// of git/GitHub edges these paths touch. The reconciler's own test file is at
// its file-size ceiling, so a new file is the only place these tests can
// live.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

// Every mock fn is hoisted: these modules transitively import each other
// during file evaluation, so a plain top-level const would be read before it
// ran ("Cannot access before initialization").
const {
  mockResolveHostGitStatus,
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockMergePullRequest,
  mockUpdatePullRequestTitle,
  mockFetchCheckRunsForHead,
} = vi.hoisted(() => ({
  mockResolveHostGitStatus: vi.fn(),
  mockResolveRepoRef: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockMergePullRequest: vi.fn(),
  mockUpdatePullRequestTitle: vi.fn(),
  mockFetchCheckRunsForHead: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHostGitStatus: mockResolveHostGitStatus,
  resolveRepoRef: mockResolveRepoRef,
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mockGetPullRequestByNumber,
  mergePullRequest: mockMergePullRequest,
  updatePullRequestTitle: mockUpdatePullRequestTitle,
}));
vi.mock("../../src/services/github.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCheckRunsForHead: mockFetchCheckRunsForHead,
}));

// A session is a real pty in production; here it only has to exist so the
// reconciler can join a task to it. The same fake the reconciler's own test
// file uses.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

// Creating a session for real would reach systemd-run (the scope guard in
// test/global-setup.ts blocks exactly that — issue #2003). The same fake the
// reconciler's own test file uses.
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
const { closeDb, getDb } = await import("../../src/db/client.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { resolveCommitsPastBase } = await import("../../src/services/commits-past-base.js");
const { resetPrCheckRunsWarningsForTests } = await import("../../src/services/pr-check-runs.js");
const { resetUnknownVerdictWarningsForTests } =
  await import("../../src/services/commits-past-base.js");
const { tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-unknown-state-${process.pid}.db`);

// Low-entropy on purpose (not a real commit hash) — a realistic-looking
// 40-char hex string trips detect-secrets' hex-high-entropy heuristic.
const BASE_SHA = "0000000111122223333444455556666777788889"; // pragma: allowlist secret

/** A resolved git status — HEAD is `hash`, `ahead`/`behind` aside. */
function gitStatus(hash: string | null, isClean = true) {
  return {
    ok: true,
    value: {
      isRepo: true,
      status: { branch: "mullion/task-999", hash, ahead: 0, behind: 0, files: [], isClean },
    },
  };
}

/** The "the host could not be asked" answer — a remote worker that is down. */
function unreachable() {
  return { ok: false, reason: "unreachable", detail: "connection refused" };
}

/** The live session info the reconciler derives its status from. */
function fakeInfo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    activity: "idle",
    errorState: "idle",
    errorDetail: null,
    errorAt: null,
    lastTurnEndedAt: null,
    outstandingBackgroundTasks: [],
    ...overrides,
    // Derived from the same override, so a fixture that ends the turn also
    // ends the work — the reconciler's #722 gate reads `workFinishedAt` (the
    // last turn end that meant the agent's work is done), not
    // `lastTurnEndedAt` (when a turn ended at all).
    workFinishedAt:
      "workFinishedAt" in overrides
        ? (overrides.workFinishedAt as number | null)
        : ((overrides.lastTurnEndedAt as number | null) ?? null),
  };
}

function mockPr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 9,
    state: "open",
    title: "chore: something",
    baseRef: "main",
    headRef: "mullion/task-9",
    headSha: "sha-head",
    mergeable: true,
    mergeableState: "clean",
    merged: false,
    mergedAt: null,
    ...overrides,
  };
}

describe("#2416 — the states that used to be swallowed", () => {
  const originalHome = process.env.HOME;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    // The budget-salvage handoff only fires with Task Master enabled — the
    // same posture the reconciler's own test file uses.
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    process.env.MULLION_TASK_BUDGET_MINUTES = "120";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
    delete process.env.MULLION_TASK_BUDGET_MINUTES;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  beforeEach(() => {
    mockResolveHostGitStatus.mockReset();
    mockResolveRepoRef.mockReset().mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockReset().mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockReset();
    mockMergePullRequest.mockReset().mockResolvedValue(undefined);
    mockUpdatePullRequestTitle.mockReset().mockResolvedValue(undefined);
    mockFetchCheckRunsForHead.mockReset().mockResolvedValue([]);
    resetPrCheckRunsWarningsForTests();
    resetUnknownVerdictWarningsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // These tests leave tasks behind on purpose (a task that stays in
    // progress IS the outcome some of them assert). This file shares one DB
    // across its run, so a leftover in_progress task would be swept by the
    // NEXT test's reconcile — clear the table between tests.
    try {
      getDb().delete(tasks).run();
    } catch {
      // No DB yet (the very first beforeEach runs before any buildApp()).
    }
  });

  /** A project, a session and a task with a base SHA and a worktree. */
  async function createSessionAndTaskWithBase(
    app: Awaited<ReturnType<typeof buildApp>>,
    status: "claimed" | "in_progress",
    claimedAt: Date = new Date(),
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const sessionId = session.json().id as number;
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "t",
        status,
        sessionId,
        claimedAt,
        startedAt: status === "in_progress" ? claimedAt : null,
        worktreePath: "/tmp/mullion-task-worktree",
        branchName: "mullion/task-999",
        baseSha: BASE_SHA,
      })
      .returning()
      .all();
    return { taskId: row.id, sessionId, projectId: project.json().id as number };
  }

  /** A "done" task with a PR and a pending merge — the merge sweep's shape. */
  async function createDoneTaskWithPendingMerge(
    app: Awaited<ReturnType<typeof buildApp>>,
    prNumber = 9,
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-merge", cwd: "/tmp" },
    });
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "merge-pending",
        status: "done",
        claimedAt: new Date(),
        completedAt: new Date(),
        prNumber,
        prUrl: `https://github.com/o/r/pull/${prNumber}`,
        mergeRequestedAt: new Date(),
      })
      .returning()
      .all();
    return { taskId: row.id, projectId: project.json().id as number };
  }

  async function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  describe("the three-state verdict (resolveCommitsPastBase)", () => {
    const task = {
      id: 42,
      projectId: 7,
      baseSha: BASE_SHA,
      worktreePath: "/tmp/mullion-task-worktree",
    } as never;

    it("says 'ahead' when HEAD moved past the base SHA", async () => {
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1"));
      const verdict = await resolveCommitsPastBase({ log: { warn: vi.fn() } } as never, task, "h1");
      expect(verdict).toEqual({ state: "ahead" });
    });

    it("says 'none' when the worktree resolved and has no commits past the base", async () => {
      mockResolveHostGitStatus.mockResolvedValue(gitStatus(BASE_SHA));
      const verdict = await resolveCommitsPastBase({ log: { warn: vi.fn() } } as never, task, "h1");
      expect(verdict).toEqual({ state: "none" });
    });

    it("says 'none' (a resolved answer) when the worktree is not a repo at all", async () => {
      mockResolveHostGitStatus.mockResolvedValue({
        ok: true,
        value: { isRepo: false, status: null },
      });
      const verdict = await resolveCommitsPastBase({ log: { warn: vi.fn() } } as never, task, "h1");
      expect(verdict).toEqual({ state: "none" });
    });

    it("says 'unknown' — and says it out loud — when the host could not be asked", async () => {
      mockResolveHostGitStatus.mockResolvedValue(unreachable());
      const warn = vi.fn();
      const verdict = await resolveCommitsPastBase({ log: { warn } } as never, task, "h1");
      expect(verdict.state).toBe("unknown");
      expect(warn).toHaveBeenCalledTimes(1);
      const [fields, message] = warn.mock.calls[0];
      expect(fields).toMatchObject({
        taskId: 42,
        projectId: 7,
        hostId: "h1",
        worktreePath: "/tmp/mullion-task-worktree",
      });
      expect(message).toContain("unknown");
    });

    it("says 'unknown' when the lookup itself throws", async () => {
      mockResolveHostGitStatus.mockRejectedValue(new Error("boom"));
      const warn = vi.fn();
      const verdict = await resolveCommitsPastBase({ log: { warn } } as never, task, "h1");
      expect(verdict.state).toBe("unknown");
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("the budget gate — an unreadable worktree still fails the task, but says why", () => {
    it("fails the task as before, and logs that the commits were unknown", async () => {
      process.env.MULLION_TASK_BUDGET_MINUTES = "1";
      const app = await buildApp();
      try {
        const warnSpy = vi.spyOn(app.log, "warn");
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const { taskId } = await createSessionAndTaskWithBase(app, "in_progress", twoHoursAgo);
        vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
        } as never);
        // The worker host cannot be reached — the lookup resolved NOTHING.
        mockResolveHostGitStatus.mockResolvedValue(unreachable());

        await reconcileTasks(app);

        // The outcome is unchanged: a task whose commits cannot be verified
        // is not salvaged, so it fails on budget.
        const row = await getTask(app, taskId);
        expect(row.status).toBe("failed");
        expect(row.failureReason).toContain("budget exceeded");
        // What changed: the failure is no longer silent, and it no longer
        // claims the worktree had no commits.
        expect(warnSpy).toHaveBeenCalled();
        const warning = warnSpy.mock.calls.find((call) => String(call[1]).includes("git status"));
        expect(warning).toBeDefined();
        expect(warning?.[0]).toMatchObject({ taskId, hostId: expect.any(String) });
      } finally {
        process.env.MULLION_TASK_BUDGET_MINUTES = "120";
        await app.close();
      }
    });

    it("still hands a worker with commits to reviewing (the resolved path is untouched)", async () => {
      process.env.MULLION_TASK_BUDGET_MINUTES = "1";
      const app = await buildApp();
      try {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const { taskId } = await createSessionAndTaskWithBase(app, "in_progress", twoHoursAgo);
        vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
        } as never);
        mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1"));

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.failureReason).toBeNull();
      } finally {
        process.env.MULLION_TASK_BUDGET_MINUTES = "120";
        await app.close();
      }
    });
  });

  describe("the rate-limit grace gate — an unreadable worktree keeps the task alive, and says why", () => {
    it("keeps the task in the grace window and logs that the commits were unknown", async () => {
      const app = await buildApp();
      try {
        const warnSpy = vi.spyOn(app.log, "warn");
        const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
        // The durable rate-limit capture is what opens the grace window; the
        // session's own error state has already TTL-cleared (the durable
        // signal is the one that survives), so the session derives to
        // "idle" — which is the branch that consults the worktree's commits.
        app.db.update(tasks).set({ lastRateLimitAt: new Date() }).where(eq(tasks.id, taskId)).run();
        vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo(),
        } as never);
        mockResolveHostGitStatus.mockResolvedValue(unreachable());

        await reconcileTasks(app);

        // Unchanged: "no commits" and "unknown" both keep the task alive.
        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        // What changed: it is no longer silent.
        const warning = warnSpy.mock.calls.find((call) => String(call[1]).includes("git status"));
        expect(warning).toBeDefined();
        expect(warning?.[0]).toMatchObject({ taskId });
      } finally {
        await app.close();
      }
    });
  });

  describe("the unstable merge hold — an unanswered check-runs lookup holds the PR and says why", () => {
    it("does not merge, and tells the operator the check list could not be read", async () => {
      const app = await buildApp();
      try {
        const warnSpy = vi.spyOn(app.log, "warn");
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
        // GitHub did not answer the check-runs lookup — the lookup throws.
        mockFetchCheckRunsForHead.mockRejectedValue(new Error("GitHub API error (HTTP 503)"));

        await reconcileTasks(app);

        // Unchanged: an unstable PR is never merged.
        expect(mockMergePullRequest).not.toHaveBeenCalled();
        // The title-lint self-heal did not run — and it cannot, because there
        // was no check list to read.
        expect(mockUpdatePullRequestTitle).not.toHaveBeenCalled();
        // What changed: the operator is told the check list was unreadable
        // (the old message claimed a check was failing, which was a guess).
        const row = await getTask(app, taskId);
        expect(row.mergeError).toContain("check list could not be read");
        // And the log says it too.
        expect(
          warnSpy.mock.calls.some((call) => String(call[1]).includes("could not read the PR")),
        ).toBe(true);
      } finally {
        await app.close();
      }
    });

    it("still names the red check when GitHub did answer", async () => {
      const app = await buildApp();
      try {
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
        mockFetchCheckRunsForHead.mockResolvedValue([
          { name: "codecov/patch", conclusion: "failure", detail: "66.66% of diff hit" },
        ]);

        await reconcileTasks(app);

        expect(mockMergePullRequest).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.mergeError).toContain("codecov/patch");
        expect(row.mergeError).not.toContain("check list could not be read");
      } finally {
        await app.close();
      }
    });
  });
});
