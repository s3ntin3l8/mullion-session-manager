// #2971 — a non-Actions status (codecov's `codecov/patch`) that stays
// `pending` on a head whose Actions checks are all green, on a PR GitHub
// reports as `blocked`.
//
// #2904 wired this recovery into the merge sweep's `unstable` arm, because
// that is where a NON-REQUIRED pending check holds the PR. A repository whose
// branch protection REQUIRES the provider's status never reaches that arm:
// the PR reads `mergeable_state: "blocked"` instead, and the `blocked` arm
// handled the review requirements without reading the PR's check runs at all —
// so the same stall held such a task indefinitely, with no re-upload, no
// `ci-status-stalled` flag and no message naming the stuck status.
//
// These tests drive the real reconciler (`reconcileTasks`) with a faked
// GitHub client, in the shape of `task-coverage-reupload.test.ts`.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockGetPullRequestReviewDecision,
  mockFetchPullRequestReviewThreads,
  mockRerunJob,
  mockFetchRunsForHeadChecked,
  mockFetchCheckRunsForHead,
  mockGetJobs,
} = vi.hoisted(() => ({
  mockResolveRepoRef: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockGetPullRequestReviewDecision: vi.fn(),
  mockFetchPullRequestReviewThreads: vi.fn(),
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
  getPullRequestReviewDecision: mockGetPullRequestReviewDecision,
  fetchPullRequestReviewThreads: mockFetchPullRequestReviewThreads,
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

const tmpDb = path.join(os.tmpdir(), `task-coverage-reupload-blocked-${process.pid}.db`);

// The clock the whole file runs on: the stall window, the spacing window and
// the reconciler's own merge backoff are all measured against it, so it is
// mocked rather than slept through.
const REAL_NOW = Date.now();
let nowMs = REAL_NOW;

const HEAD = "sha-head";

/** A PR GitHub reports as `blocked` — a required check is not satisfied. */
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
    mergeableState: "blocked",
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

/**
 * An Actions check run that was CANCELLED — a superseded in-flight run.
 *
 * This repo cancels its own superseded runs (`cancel-in-progress` in
 * `.github/workflows/ci-cd.yml` and `visual.yml`), so a cancelled check on a
 * head is an ordinary state.
 */
function cancelledActionsCheck(name = "test-node / test-merge", runId = 4242) {
  return {
    name,
    conclusion: "cancelled",
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
function workflowRun(
  status: "completed" | "in_progress" = "completed",
  conclusion: string | null = status === "completed" ? "success" : null,
) {
  return {
    id: 4242,
    name: "CI/CD",
    status,
    conclusion,
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

describe("#2971 — a stuck non-Actions status on a blocked PR", () => {
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
    // No review requirement on this repo: the blocked PR's cause is a check,
    // which is the case this file is about.
    mockGetPullRequestReviewDecision.mockReset().mockResolvedValue(null);
    mockFetchPullRequestReviewThreads.mockReset().mockResolvedValue({
      viewerLogin: null,
      threads: [],
      truncated: false,
    });
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

  /** A "done" task whose merge is requested and whose PR is `blocked`. */
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
        name: `p-coverage-blocked-${Math.random()}`,
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
        title: "coverage pending on a blocked PR",
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

  it("re-runs the coverage upload once for a stuck pending status on a blocked PR", async () => {
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
    // The message names the stuck status instead of the generic "required
    // checks" one.
    expect(row.mergeError).toContain("codecov/patch");
    expect(row.mergeError).not.toBe("Required checks are red or still pending");
    // Neutral noun: on a `blocked` PR the status may be the REQUIRED one
    // holding the PR, so it must not be called "non-required" the way the
    // `unstable` arm's message calls it.
    expect(row.mergeError).toContain('the check "codecov/patch"');
    expect(row.mergeError).not.toContain("non-required check");
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

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    const row = getTask(app, id);
    expect(row.coverageReuploadCount).toBe(0);
    // The blocked arm's own message stands: the PR is blocked on a check
    // that is still running.
    expect(row.mergeError).toBe("Required checks are red or still pending");
    await app.close();
  });

  it("does not re-run the upload when an Actions check on the head was cancelled", async () => {
    const app = await buildApp();
    try {
      const id = await createTask(app);
      // The head's own Actions check was CANCELLED — a superseded in-flight
      // run, which this repo produces itself. GitHub's merge gate does not
      // accept a cancelled check (a required check must be successful, skipped
      // or neutral), so the head is NOT green, and a pending provider status
      // next to it says nothing about the provider.
      mockFetchCheckRunsForHead.mockResolvedValue([cancelledActionsCheck(), pendingCodecovCheck()]);
      mockFetchRunsForHeadChecked.mockResolvedValue({
        ok: true,
        runs: [workflowRun("completed", "cancelled")],
      });

      await reconcileTasks(app);

      // The cancelled check is the blocker, and re-uploading the coverage
      // cannot unblock it: nothing is re-run and no budget is spent.
      expect(mockRerunJob).not.toHaveBeenCalled();
      const row = getTask(app, id);
      expect(row.coverageReuploadCount).toBe(0);
      expect(row.coverageReuploadHeadSha).toBeNull();
      // Not a provider stall: nobody is flagged for it.
      expect(row.needsHumanReason).toBeNull();
      // The blocked arm's own message stands, and it names no stuck status.
      expect(row.mergeError).toBe("Required checks are red or still pending");
      expect(row.mergeError).not.toContain("codecov/patch");
    } finally {
      // Closed even when an assertion fails: a leaked app keeps the hooks
      // socket bound, and the NEXT test cannot even build one.
      await app.close();
    }
  });

  it("does not re-run the upload while the head's workflow run is still going", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    // Every check run says green, but the run itself has not completed: the
    // status can still be pending because the upload job is running.
    mockFetchRunsForHeadChecked.mockResolvedValue({ ok: true, runs: [workflowRun("in_progress")] });

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    const row = getTask(app, id);
    expect(row.coverageReuploadCount).toBe(0);
    expect(row.mergeError).toBe("Required checks are red or still pending");
    await app.close();
  });

  it("keeps the generic message and re-runs nothing when a check on the head is red", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    // A red check needs a fix, not a coverage re-upload — the same skip the
    // `unstable` arm makes. The status is stuck too, but the PR is held by
    // something a re-run of the upload cannot fix.
    mockFetchCheckRunsForHead.mockResolvedValue([
      {
        name: "test-node / test-merge",
        conclusion: "failure",
        status: "completed",
        app: "github-actions",
        startedAt: minutesAgo(45),
        url: runUrl(4242),
      },
      pendingCodecovCheck(),
    ]);

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    const row = getTask(app, id);
    expect(row.coverageReuploadCount).toBe(0);
    // The blocked arm's own message stands: the PR is blocked on a red check.
    expect(row.mergeError).toBe("Required checks are red or still pending");
    await app.close();
  });

  it("keeps the blocked arm's own review message instead of a coverage stall", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    // The PR is blocked on a required approving review — that is what is
    // holding it, so the coverage stall must not take the message over.
    mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    const row = getTask(app, id);
    expect(row.mergeError).toContain("Waiting on a required approving review");
    expect(row.needsHumanReason).toBeNull();
    await app.close();
  });

  it("keeps the generic checks message when no status is stuck", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    mockFetchCheckRunsForHead.mockResolvedValue([greenActionsCheck()]);

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    const row = getTask(app, id);
    expect(row.coverageReuploadCount).toBe(0);
    expect(row.mergeError).toBe("Required checks are red or still pending");
    await app.close();
  });

  it("does not claim a coverage stall when the review decision could not be read", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    // "Couldn't ask" is not "asked, and there is no review requirement": the
    // PR may be blocked on a required approval, and a message naming a stuck
    // status would hide that. The next tick reads the decision again.
    mockGetPullRequestReviewDecision.mockRejectedValue(new Error("GraphQL error"));

    await reconcileTasks(app);

    expect(mockRerunJob).not.toHaveBeenCalled();
    const row = getTask(app, id);
    expect(row.coverageReuploadCount).toBe(0);
    expect(row.mergeError).toBe("Required checks are red or still pending");
    await app.close();
  });
});
