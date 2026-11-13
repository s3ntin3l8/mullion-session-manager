// #2904 — a non-Actions status (codecov's `codecov/patch`) that stays
// `pending` on a head whose Actions checks are all green.
//
// Task Master merges only when every check is green, required or not, so a
// status the provider never settles holds the PR — and with it the task —
// forever. The red-check path cannot help: the status is PENDING, not red,
// and it has no workflow run of its own behind it.
//
// These tests drive the real reconciler (`reconcileTasks`) with a faked
// GitHub client, because the mechanism only exists in the merge sweep's
// `unstable` branch: that is where the PR is actually held.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockRerunJob,
  mockFetchRunsForHeadChecked,
  mockFetchCheckRunsForHead,
  mockGetJobs,
} = vi.hoisted(() => ({
  mockResolveRepoRef: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockRerunJob: vi.fn(),
  mockFetchRunsForHeadChecked: vi.fn(),
  mockFetchCheckRunsForHead: vi.fn(),
  mockGetJobs: vi.fn(),
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
  rerunJob: mockRerunJob,
}));
vi.mock("../../src/services/github.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRunsForHeadChecked: mockFetchRunsForHeadChecked,
  fetchCheckRunsForHead: mockFetchCheckRunsForHead,
  getWorkflowRunJobsChecked: mockGetJobs,
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
// Never let a real systemd-run fire (test/global-setup.ts, issue #2003).
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
const { reconcileTasks, resetMergeBackoff } = await import("../../src/services/task-reconciler.js");
const { tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-coverage-reupload-${process.pid}.db`);

// The clock the whole file runs on: the stall window, the spacing window and
// the reconciler's own merge backoff are all measured against it, so it is
// mocked rather than slept through.
const REAL_NOW = Date.now();
let nowMs = REAL_NOW;

const HEAD = "sha-head";

function mockPr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 9,
    htmlUrl: "https://github.com/o/r/pull/9",
    nodeId: "PR_node9",
    draft: false,
    headSha: HEAD,
    headRef: "mullion/task-x",
    baseRef: "main",
    title: "fix: something",
    state: "open",
    merged: false,
    mergedAt: null,
    mergeable: true,
    mergeableState: "unstable",
    ...overrides,
  };
}

/** A check run's `details_url`: it names the workflow run that owns the check. */
function runUrl(runId: number, job = 1) {
  return `https://github.com/o/r/actions/runs/${runId}/job/${job}`;
}

function minutesAgo(minutes: number): string {
  return new Date(nowMs - minutes * 60_000).toISOString();
}

/** An Actions check run that finished green. */
function greenActionsCheck(name = "test-node / test-merge", runId = 4242) {
  return {
    name,
    conclusion: "success",
    status: "completed",
    app: "github-actions",
    startedAt: minutesAgo(45),
    url: runUrl(runId),
  };
}

/** Codecov's `codecov/patch`: posted by the Codecov app, never completed. */
function pendingCodecovCheck(pendingMinutes = 45) {
  return {
    name: "codecov/patch",
    conclusion: null,
    status: "in_progress",
    app: "codecov",
    startedAt: minutesAgo(pendingMinutes),
    url: "https://app.codecov.io/gh/o/r/commit/abc",
  };
}

/** A workflow run of the head — the layer that says whether CI is still going. */
function workflowRun(status: "completed" | "in_progress" = "completed") {
  return {
    id: 4242,
    name: "CI/CD",
    status,
    conclusion: status === "completed" ? "success" : null,
    htmlUrl: "https://x/1",
    headSha: HEAD,
  };
}

/** A completed job with a Codecov upload step — the thing worth re-running. */
function coverageJob(id: number, name = "test-node / test-merge") {
  return {
    id,
    name,
    status: "completed",
    conclusion: "success",
    startedAt: minutesAgo(45),
    completedAt: minutesAgo(40),
    htmlUrl: "https://github.com/o/r/actions/runs/4242/job/" + id,
    steps: [
      { name: "Run tests", status: "completed", conclusion: "success", number: 1 },
      { name: "Upload coverage to Codecov", status: "completed", conclusion: "success", number: 2 },
    ],
  };
}

describe("#2904 — a non-Actions status stuck pending after green CI", () => {
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

  beforeEach(() => {
    nowMs = REAL_NOW;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mockResolveRepoRef.mockReset().mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockReset().mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockReset().mockResolvedValue(mockPr());
    mockRerunJob.mockReset().mockResolvedValue("accepted");
    mockFetchRunsForHeadChecked.mockReset().mockResolvedValue({ ok: true, runs: [workflowRun()] });
    mockFetchCheckRunsForHead
      .mockReset()
      .mockResolvedValue([greenActionsCheck(), pendingCodecovCheck()]);
    mockGetJobs.mockReset().mockResolvedValue({ ok: true, jobs: [coverageJob(7001)] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      getDb().delete(tasks).run();
    } catch {
      // No DB yet (the very first beforeEach runs before any buildApp()).
    }
  });

  /** A "done" task whose merge is requested and whose PR is `unstable`. */
  async function createTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    overrides: Partial<typeof tasks.$inferInsert> = {},
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: `p-coverage-${Math.random()}`,
        cwd: "/tmp",
      },
    });
    const projectId = project.json().id as number;
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { autoApprove: true },
    });
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "coverage pending",
        status: "done",
        claimedAt: new Date(),
        completedAt: new Date(),
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
        mergeRequestedAt: new Date(),
        branchName: "mullion/task-x",
        agentCommand: "claude",
        ...overrides,
      })
      .returning()
      .all();
    // The merge sweep's own backoff is module state; a fresh task id must not
    // inherit the previous test's window.
    resetMergeBackoff(row.id);
    return row.id;
  }

  const getTask = (app: Awaited<ReturnType<typeof buildApp>>, id: number) =>
    app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  it("re-runs the coverage upload once for a stuck pending status", async () => {
    const app = await buildApp();
    const id = await createTask(app);

    await reconcileTasks(app);

    // The job that uploads the coverage is re-run, so Codecov reprocesses the
    // commit and posts the status it never did.
    expect(mockRerunJob).toHaveBeenCalledTimes(1);
    expect(mockRerunJob).toHaveBeenCalledWith("tok", "o", "r", 7001);
    // Re-running a job needs `actions: write`, which only the dispatch scope
    // carries — the same scope the red-check rerun uses.
    expect(mockResolveGitHubToken).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "o", repo: "r" },
      "dispatch",
    );
    const row = getTask(app, id);
    expect(row.coverageReuploadCount).toBe(1);
    expect(row.coverageReuploadHeadSha).toBe(HEAD);
    expect(row.coverageReuploadAt).not.toBeNull();
    // The task is still working on it: not a "needs a human" yet.
    expect(row.needsHumanReason).toBeNull();
    expect(row.mergeError).toContain("codecov/patch");
    await app.close();
  });

  it("does not re-run the upload again inside the 20-minute spacing window", async () => {
    const app = await buildApp();
    const id = await createTask(app);

    await reconcileTasks(app);
    expect(mockRerunJob).toHaveBeenCalledTimes(1);

    // Five minutes later: the merge sweep runs again, but the spacing window
    // keeps the budget from being spent on the same stall.
    nowMs += 5 * 60_000;
    await reconcileTasks(app);

    expect(mockRerunJob).toHaveBeenCalledTimes(1);
    expect(getTask(app, id).coverageReuploadCount).toBe(1);
    expect(getTask(app, id).needsHumanReason).toBeNull();
    await app.close();
  });

  it("re-runs the upload again once the spacing window has passed", async () => {
    const app = await buildApp();
    const id = await createTask(app);

    await reconcileTasks(app);
    expect(mockRerunJob).toHaveBeenCalledTimes(1);

    nowMs += 21 * 60_000;
    await reconcileTasks(app);

    expect(mockRerunJob).toHaveBeenCalledTimes(2);
    expect(getTask(app, id).coverageReuploadCount).toBe(2);
    expect(getTask(app, id).needsHumanReason).toBeNull();
    await app.close();
  });

  it("tries the next candidate job when GitHub refuses the first one", async () => {
    const app = await buildApp();
    await createTask(app);
    mockGetJobs.mockResolvedValue({
      ok: true,
      jobs: [coverageJob(7001), coverageJob(7002), coverageJob(7003)],
    });
    // GitHub refuses to re-run the first job (its run already used its
    // attempt) and accepts the second.
    mockRerunJob.mockImplementation(async (_t: string, _o: string, _r: string, jobId: number) =>
      jobId === 7002 ? "accepted" : "refused",
    );

    await reconcileTasks(app);

    expect(mockRerunJob).toHaveBeenCalledTimes(2);
    expect(mockRerunJob).toHaveBeenNthCalledWith(1, "tok", "o", "r", 7001);
    expect(mockRerunJob).toHaveBeenNthCalledWith(2, "tok", "o", "r", 7002);
    // One accepted re-run is enough — the third job is not touched.
    expect(mockRerunJob).not.toHaveBeenCalledWith("tok", "o", "r", 7003);
    await app.close();
  });

  it("flags the task for a human once the budget is spent, and re-runs nothing", async () => {
    const app = await buildApp();
    const id = await createTask(app, {
      coverageReuploadHeadSha: HEAD,
      coverageReuploadCount: 2,
      coverageReuploadAt: new Date(nowMs - 60 * 60_000),
    });

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    const row = getTask(app, id);
    expect(row.needsHumanReason).toBe("ci-status-stalled");
    // The message names the stuck status and says it is a provider-side stall.
    expect(row.mergeError).toContain("codecov/patch");
    expect(row.mergeError).toContain("Codecov-side stall");
    await app.close();
  });

  it("does not re-run the upload for a status that is not pending long enough", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    // Pending for 10 minutes: Codecov still has time to post it.
    mockFetchCheckRunsForHead.mockResolvedValue([greenActionsCheck(), pendingCodecovCheck(10)]);

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    expect(getTask(app, id).coverageReuploadCount).toBe(0);
    await app.close();
  });

  it("does not re-run the upload while an Actions job is still running", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    // The Actions check has not finished: a pending status is the normal
    // state of a CI that has not reported yet, not a stalled provider.
    mockFetchCheckRunsForHead.mockResolvedValue([
      {
        name: "test-node / test-merge",
        conclusion: null,
        status: "in_progress",
        app: "github-actions",
        startedAt: minutesAgo(45),
        url: runUrl(4242),
      },
      pendingCodecovCheck(),
    ]);
    mockFetchRunsForHeadChecked.mockResolvedValue({ ok: true, runs: [workflowRun("in_progress")] });

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    expect(getTask(app, id).coverageReuploadCount).toBe(0);
    await app.close();
  });

  it("does not re-run the upload while the head's workflow run is still going", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    // Every check run says green, but the run itself has not completed: the
    // status can still be pending because the upload job is running.
    mockFetchRunsForHeadChecked.mockResolvedValue({ ok: true, runs: [workflowRun("in_progress")] });

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    expect(getTask(app, id).coverageReuploadCount).toBe(0);
    await app.close();
  });

  it("does not flag a human while the head's workflow run is still going, even with the budget spent", async () => {
    const app = await buildApp();
    const id = await createTask(app, {
      coverageReuploadHeadSha: HEAD,
      coverageReuploadCount: 2,
      coverageReuploadAt: new Date(nowMs - 60 * 60_000),
    });
    // The budget is spent, but the head's CI is still running: the status may
    // still be pending because the upload job has not finished, so this is
    // not yet a provider-side stall and no human is needed.
    mockFetchRunsForHeadChecked.mockResolvedValue({ ok: true, runs: [workflowRun("in_progress")] });

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    const row = getTask(app, id);
    expect(row.needsHumanReason).toBeNull();
    expect(row.mergeError).not.toContain("Codecov-side stall");
    await app.close();
  });

  it("starts a fresh budget on a new head", async () => {
    const app = await buildApp();
    // The budget was spent on an OLD head; the new head is a new CI run with
    // a new status to settle.
    const id = await createTask(app, {
      coverageReuploadHeadSha: "sha-older-head",
      coverageReuploadCount: 2,
      coverageReuploadAt: new Date(nowMs - 60 * 60_000),
    });

    await reconcileTasks(app);

    expect(mockRerunJob).toHaveBeenCalledTimes(1);
    const row = getTask(app, id);
    expect(row.coverageReuploadHeadSha).toBe(HEAD);
    expect(row.coverageReuploadCount).toBe(1);
    expect(row.needsHumanReason).toBeNull();
    await app.close();
  });

  it("does not re-run the upload for a green head with no pending status", async () => {
    const app = await buildApp();
    await createTask(app);
    mockFetchCheckRunsForHead.mockResolvedValue([greenActionsCheck()]);

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps the hold message when GitHub refuses every candidate job", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    mockRerunJob.mockResolvedValue("refused");

    await reconcileTasks(app);

    expect(mockRerunJob).toHaveBeenCalledTimes(1);
    const row = getTask(app, id);
    // A refusal is not a crash: the attempt is spent and the human is told.
    expect(row.coverageReuploadCount).toBe(1);
    expect(row.needsHumanReason).toBeNull();
    expect(row.mergeError).toContain("refused");
    await app.close();
  });

  it("does not spend the budget when GitHub cannot be reached, so two blips never park the task", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    mockRerunJob.mockRejectedValue(new Error("secondary rate limit"));

    await reconcileTasks(app);
    nowMs += 21 * 60_000;
    await reconcileTasks(app);
    nowMs += 21 * 60_000;
    await reconcileTasks(app);

    // Asked on every spaced tick, never charged.
    expect(mockRerunJob).toHaveBeenCalledTimes(3);
    const row = getTask(app, id);
    expect(row.coverageReuploadCount).toBe(0);
    expect(row.needsHumanReason).toBeNull();
    expect(row.mergeError).toContain("No attempt was spent");

    // And once GitHub answers, the re-run still happens.
    mockRerunJob.mockResolvedValue("accepted");
    nowMs += 21 * 60_000;
    await reconcileTasks(app);
    expect(getTask(app, id).coverageReuploadCount).toBe(1);
    await app.close();
  });

  it("keeps the 20-minute spacing after an ask that never landed", async () => {
    const app = await buildApp();
    await createTask(app);
    mockRerunJob.mockRejectedValue(new Error("502"));

    await reconcileTasks(app);
    nowMs += 5 * 60_000;
    await reconcileTasks(app);

    expect(mockRerunJob).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("treats an unreadable job listing as unavailable, not as 'no coverage job'", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    mockGetJobs.mockResolvedValue({ ok: false, jobs: [] });

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    const row = getTask(app, id);
    expect(row.coverageReuploadCount).toBe(0);
    expect(row.mergeError).toContain("could not reach GitHub");
    expect(row.mergeError).not.toContain("nothing for Mullion to re-run");
    await app.close();
  });

  it("names a missing Actions-write token instead of blaming GitHub or Codecov", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    mockRerunJob.mockResolvedValue("unauthorized");

    await reconcileTasks(app);

    const row = getTask(app, id);
    expect(row.coverageReuploadCount).toBe(0);
    expect(row.needsHumanReason).toBeNull();
    expect(row.mergeError).toContain("lacks Actions write");
    await app.close();
  });

  it("keeps the red-check message and re-runs nothing while a non-required check is red", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    mockFetchCheckRunsForHead.mockResolvedValue([
      greenActionsCheck(),
      pendingCodecovCheck(),
      {
        name: "codecov/project",
        conclusion: "failure",
        status: "completed",
        app: "codecov",
        startedAt: minutesAgo(45),
        url: "https://app.codecov.io/gh/o/r/commit/abc",
        detail: "66.66% of diff hit",
      },
    ]);

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    expect(getTask(app, id).mergeError).toContain("a non-required check is red");
    await app.close();
  });
});
