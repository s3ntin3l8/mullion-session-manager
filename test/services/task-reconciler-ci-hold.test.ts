// A red check on a head the worker was ALREADY returned for (task-ci-return-hold.ts).
//
// Tasks 1031536, 1031838 and 1031834 looped on this: GitHub lost an Actions job
// (an abandoned shard, a run with no jobs), the check stayed red on the same
// head, and the red-CI return re-seeded the worker with an identical prompt on
// every sweep tick — the worker had nothing to fix and pushed nothing. The
// reconciler's own test file covers a red check returning the worker; this file
// covers what happens the SECOND time on an unchanged head. (That file is at its
// size ceiling, so a new file is the only place these tests can live.)

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const {
  mockResolveRepoRef,
  mockResolveRepoRefResult,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockRerunFailedJobs,
  mockCreatePullRequestReview,
  mockFetchRunsForHeadChecked,
  mockFetchCheckRunsForHead,
} = vi.hoisted(() => ({
  mockResolveRepoRef: vi.fn(),
  mockResolveRepoRefResult: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockRerunFailedJobs: vi.fn(),
  mockCreatePullRequestReview: vi.fn(),
  mockFetchRunsForHeadChecked: vi.fn(),
  mockFetchCheckRunsForHead: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRepoRef: mockResolveRepoRef,
  // The comment post resolves the repo through the Result variant.
  resolveRepoRefResult: mockResolveRepoRefResult,
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mockGetPullRequestByNumber,
  rerunFailedJobs: mockRerunFailedJobs,
  createPullRequestReview: mockCreatePullRequestReview,
}));
vi.mock("../../src/services/github.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRunsForHeadChecked: mockFetchRunsForHeadChecked,
  fetchCheckRunsForHead: mockFetchCheckRunsForHead,
}));

// A session is a real pty in production; here it only has to exist so the
// reconciler can join a task to it.
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
// test/global-setup.ts blocks exactly that — issue #2003).
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
const { holdRedCiWithoutProgress, resetCiRerunSettleForTests } =
  await import("../../src/services/task-ci-return-hold.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-ci-hold-${process.pid}.db`);

function mockPr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 9,
    htmlUrl: "https://github.com/o/r/pull/9",
    nodeId: "PR_node9",
    draft: false,
    headSha: "sha-head",
    headRef: "mullion/task-x",
    baseRef: "main",
    title: "feat: do the thing",
    state: "open",
    merged: false,
    mergedAt: null,
    mergeable: true,
    mergeableState: "clean",
    ...overrides,
  };
}

/** The Workflow Run layer: the coarse "is anything red" pre-filter, and the run id a rerun targets. */
function workflowRun(conclusion: "success" | "failure", id = 4242) {
  return [
    {
      id,
      name: "CI/CD",
      status: "completed" as const,
      conclusion,
      htmlUrl: "https://x/1",
      headSha: "sha-head",
    },
  ];
}

describe("red CI on a head the worker was already returned for", () => {
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
    resetCiRerunSettleForTests();
    mockResolveRepoRef.mockReset().mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveRepoRefResult
      .mockReset()
      .mockResolvedValue({ ok: true, value: { owner: "o", repo: "r" } });
    mockResolveGitHubToken.mockReset().mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockReset().mockResolvedValue(mockPr());
    mockRerunFailedJobs.mockReset().mockResolvedValue(true);
    mockCreatePullRequestReview
      .mockReset()
      .mockResolvedValue({ id: 1, htmlUrl: "https://github.com/o/r/pull/9#pullrequestreview-1" });
    mockFetchRunsForHeadChecked
      .mockReset()
      .mockResolvedValue({ ok: true, runs: workflowRun("failure") });
    mockFetchCheckRunsForHead
      .mockReset()
      .mockResolvedValue([{ name: "test-frontend / test-merge", conclusion: "failure" }]);
  });

  afterEach(() => {
    // A leftover `reviewing` task would be swept by the NEXT test's reconcile.
    try {
      getDb().delete(tasks).run();
    } catch {
      // No DB yet (the very first beforeEach runs before any buildApp()).
    }
  });

  /** An auto-approve project with a reviewing task whose worker session still exists. */
  async function createCandidate(
    app: Awaited<ReturnType<typeof buildApp>>,
    overrides: Partial<typeof tasks.$inferInsert> = {},
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: `p-ci-hold-${Math.random()}`,
        cwd: "/tmp",
      },
    });
    const projectId = project.json().id as number;
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { autoApprove: true },
    });
    const sessionIds: number[] = [];
    for (let i = 0; i < 2; i++) {
      const session = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      sessionIds.push(session.json().id as number);
    }
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "red ci candidate",
        status: "reviewing",
        claimedAt: new Date(),
        reviewingAt: new Date(),
        prNumber: 9,
        worktreePath: "/tmp",
        agentCommand: "claude",
        sessionId: sessionIds[0],
        reviewSessionId: sessionIds[1],
        reviewFindingsIngestedSessionId: sessionIds[1],
        lastReviewVerdict: "clean",
        ...overrides,
      })
      .returning()
      .all();
    return row.id;
  }

  const getTask = (app: Awaited<ReturnType<typeof buildApp>>, id: number) =>
    app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  it("records the head it returned the worker for", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app);

    await reconcileTasks(app);

    const row = getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.lastAutoReturnReason).toBe("ci");
    expect(row.ciReturnHeadSha).toBe("sha-head");
    expect(row.ciRerunCount).toBe(0);
    expect(mockRerunFailedJobs).not.toHaveBeenCalled();

    await app.close();
  });

  it("re-runs the failed jobs instead of returning the worker again", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: "sha-head", autoReturnRounds: 3 });

    await reconcileTasks(app);

    expect(mockRerunFailedJobs).toHaveBeenCalledWith("tok", "o", "r", 4242);
    // Re-running jobs needs `actions: write`, which only the dispatch token scope
    // carries; a scope-blind mock would hide a token that always 403s.
    expect(mockResolveGitHubToken).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "o", repo: "r" },
      "dispatch",
    );
    const row = getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.autoReturnRounds).toBe(3);
    expect(row.ciRerunCount).toBe(1);
    expect(row.autoReturnCapAnnouncedAt).toBeNull();
    expect(mockCreatePullRequestReview).not.toHaveBeenCalled();

    await app.close();
  });

  it("parks the task for a human when GitHub refuses the rerun, with one comment", async () => {
    const app = await buildApp();
    // The reviewed head is behind the PR head (an approval carried through an
    // earlier CI fix): the park must not leave it there, or the human-push
    // re-arm would undo the park on the next sweep.
    const taskId = await createCandidate(app, {
      ciReturnHeadSha: "sha-head",
      lastReviewedHeadSha: "sha-reviewed-earlier",
    });
    mockRerunFailedJobs.mockResolvedValue(false);

    await reconcileTasks(app);

    const row = getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.needsHumanReason).toBe("no-progress");
    expect(row.autoReturnCapAnnouncedAt).not.toBeNull();
    expect(row.autoReturnRounds).toBe(0);
    expect(row.lastReviewedHeadSha).toBe("sha-head");
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
    expect(mockCreatePullRequestReview).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      9,
      expect.objectContaining({ body: expect.stringContaining("(test-frontend / test-merge)") }),
    );

    await app.close();
  });

  it("parks without a rerun once the per-head rerun budget is spent", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: "sha-head", ciRerunCount: 2 });

    await reconcileTasks(app);

    expect(mockRerunFailedJobs).not.toHaveBeenCalled();
    const row = getTask(app, taskId);
    expect(row.needsHumanReason).toBe("no-progress");
    expect(row.status).toBe("reviewing");

    await app.close();
  });

  it("parks straight away when the red check is not an Actions run (nothing to rerun)", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: "sha-head" });
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
    mockFetchRunsForHeadChecked.mockResolvedValue({ ok: true, runs: workflowRun("success") });
    mockFetchCheckRunsForHead.mockResolvedValue([{ name: "codecov/patch", conclusion: "failure" }]);

    await reconcileTasks(app);

    expect(mockRerunFailedJobs).not.toHaveBeenCalled();
    expect(getTask(app, taskId).needsHumanReason).toBe("no-progress");

    await app.close();
  });

  it("records the spend when a later run's rerun throws after an earlier one was accepted", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: "sha-head" });
    mockFetchRunsForHeadChecked.mockResolvedValue({
      ok: true,
      runs: [
        { ...workflowRun("failure", 4242)[0], name: "CI/CD" },
        { ...workflowRun("failure", 4243)[0], name: "CodeQL" },
      ],
    });
    mockRerunFailedJobs.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("boom"));

    await reconcileTasks(app);

    expect(mockRerunFailedJobs).toHaveBeenCalledTimes(2);
    const row = getTask(app, taskId);
    // The accepted rerun is counted (and settles), so the next tick does not
    // re-request one that is already in flight.
    expect(row.ciRerunCount).toBe(1);
    expect(row.status).toBe("reviewing");
    expect(row.autoReturnCapAnnouncedAt).toBeNull();

    await app.close();
  });

  it("holds without parking or returning when the rerun request itself fails", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: "sha-head" });
    mockRerunFailedJobs.mockRejectedValue(new Error("rate limited"));

    await reconcileTasks(app);

    const row = getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.autoReturnCapAnnouncedAt).toBeNull();
    expect(row.ciRerunCount).toBe(0);
    expect(mockCreatePullRequestReview).not.toHaveBeenCalled();

    await app.close();
  });

  it("does nothing more for a task that is already parked", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, {
      ciReturnHeadSha: "sha-head",
      autoReturnCapAnnouncedAt: new Date(),
    });

    await reconcileTasks(app);

    expect(mockRerunFailedJobs).not.toHaveBeenCalled();
    expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
    expect(getTask(app, taskId).status).toBe("reviewing");

    await app.close();
  });

  it("does not rerun again inside the settle window after a rerun was requested", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: "sha-head" });
    const current = {
      headSha: "sha-head",
      repoRef: { owner: "o", repo: "r" },
      failedRunIds: [4242],
    };
    const redChecks = [{ name: "test-frontend / test-merge" }];
    const project = app.db
      .select()
      .from(projects)
      .where(eq(projects.id, getTask(app, taskId).projectId))
      .get()!;

    await holdRedCiWithoutProgress(app, getTask(app, taskId), project, current, redChecks);
    expect(mockRerunFailedJobs).toHaveBeenCalledTimes(1);
    // The next sweep still sees the not-yet-replaced red check; the settle
    // window keeps it from burning the next attempt on a rerun that is running.
    await holdRedCiWithoutProgress(app, getTask(app, taskId), project, current, redChecks);

    expect(mockRerunFailedJobs).toHaveBeenCalledTimes(1);
    const row = getTask(app, taskId);
    expect(row.ciRerunCount).toBe(1);
    expect(row.autoReturnCapAnnouncedAt).toBeNull();

    await app.close();
  });

  it("still returns the worker when the head moved since the last return (a real fix that is still red)", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, {
      ciReturnHeadSha: "sha-older-head",
      autoReturnRounds: 5,
    });

    await reconcileTasks(app);

    expect(mockRerunFailedJobs).not.toHaveBeenCalled();
    const row = getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.autoReturnRounds).toBe(6);
    expect(row.ciReturnHeadSha).toBe("sha-head");
    expect(row.ciRerunCount).toBe(0);

    await app.close();
  });
});
