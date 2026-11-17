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

// A real head is a 40-char lowercase hex SHA; the unfixable-declaration read validates that.
const HEAD_SHA = "a".repeat(40);

const {
  mockResolveRepoRef,
  mockResolveRepoRefResult,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockRerunFailedJobs,
  mockCreatePullRequestReview,
  mockFetchRunsForHeadChecked,
  mockFetchCheckRunsForHead,
  ciUnfixableRead,
} = vi.hoisted(() => ({
  mockResolveRepoRef: vi.fn(),
  mockResolveRepoRefResult: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockRerunFailedJobs: vi.fn(),
  mockCreatePullRequestReview: vi.fn(),
  mockFetchRunsForHeadChecked: vi.fn(),
  mockFetchCheckRunsForHead: vi.fn(),
  // When set, replaces the backend's declaration read (to simulate a host error).
  ciUnfixableRead: { impl: undefined as undefined | ((...a: unknown[]) => Promise<unknown>) },
}));

vi.mock("../../src/services/session-backend.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const resolveBackend = actual.resolveBackend as (a: unknown, h: string) => object;
  return {
    ...actual,
    resolveBackend: (app: unknown, hostId: string) => {
      const real = resolveBackend(app, hostId);
      return ciUnfixableRead.impl
        ? Object.create(real, { readTaskCiUnfixable: { value: ciUnfixableRead.impl } })
        : real;
    },
  };
});

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
const { taskCiUnfixablePath } = await import("../../src/services/task-prompt.js");
const { HostUnreachableError } = await import("../../src/services/remote-host-errors.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-ci-hold-${process.pid}.db`);

function mockPr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 9,
    htmlUrl: "https://github.com/o/r/pull/9",
    nodeId: "PR_node9",
    draft: false,
    headSha: HEAD_SHA,
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

/** A check run's `details_url`: it names the workflow run that owns the check. */
function runUrl(runId: number, job = 1) {
  return `https://github.com/o/r/actions/runs/${runId}/job/${job}`;
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
      headSha: HEAD_SHA,
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
    ciUnfixableRead.impl = undefined;
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
      .mockResolvedValue([
        { name: "test-frontend / test-merge", conclusion: "failure", url: runUrl(4242) },
      ]);
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
    expect(row.ciReturnHeadSha).toBe(HEAD_SHA);
    expect(row.ciRerunCount).toBe(0);
    expect(mockRerunFailedJobs).not.toHaveBeenCalled();

    await app.close();
  });

  it("re-runs the failed jobs instead of returning the worker again", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA, autoReturnRounds: 3 });

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
      ciReturnHeadSha: HEAD_SHA,
      lastReviewedHeadSha: "sha-reviewed-earlier",
    });
    mockRerunFailedJobs.mockResolvedValue(false);

    await reconcileTasks(app);

    const row = getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.needsHumanReason).toBe("ci-still-red");
    expect(row.autoReturnCapAnnouncedAt).not.toBeNull();
    expect(row.autoReturnRounds).toBe(0);
    expect(row.lastReviewedHeadSha).toBe(HEAD_SHA);
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
    const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA, ciRerunCount: 2 });

    await reconcileTasks(app);

    expect(mockRerunFailedJobs).not.toHaveBeenCalled();
    const row = getTask(app, taskId);
    expect(row.needsHumanReason).toBe("ci-still-red");
    expect(row.status).toBe("reviewing");

    await app.close();
  });

  it("parks straight away when the red check is not an Actions run (nothing to rerun)", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
    mockFetchRunsForHeadChecked.mockResolvedValue({ ok: true, runs: workflowRun("success") });
    mockFetchCheckRunsForHead.mockResolvedValue([{ name: "codecov/patch", conclusion: "failure" }]);

    await reconcileTasks(app);

    expect(mockRerunFailedJobs).not.toHaveBeenCalled();
    expect(getTask(app, taskId).needsHumanReason).toBe("ci-still-red");

    await app.close();
  });

  it("records the spend when a later run's rerun throws after an earlier one was accepted", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
    mockFetchCheckRunsForHead.mockResolvedValue([
      { name: "test-merge", conclusion: "failure", url: runUrl(4242) },
      { name: "Analyze", conclusion: "failure", url: runUrl(4243) },
    ]);
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

  it("re-runs the run that owns the red check, not a newer green run of the same workflow name", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
    // The workflow-run list keeps only the latest run per name, so it holds just
    // the green run (id 5000) and the red run 4242 is NOT in it. The red check
    // still points at 4242. Deriving ids from the run list would find nothing here.
    mockFetchRunsForHeadChecked.mockResolvedValue({
      ok: true,
      runs: [{ ...workflowRun("success", 5000)[0] }],
    });
    // GitHub reports the PR `unstable` (a check is red) although the aggregate of
    // the listed runs is green: that is how the gate reaches the check runs.
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));

    await reconcileTasks(app);

    expect(mockRerunFailedJobs).toHaveBeenCalledTimes(1);
    expect(mockRerunFailedJobs).toHaveBeenCalledWith("tok", "o", "r", 4242);
    expect(getTask(app, taskId).autoReturnCapAnnouncedAt).toBeNull();

    await app.close();
  });

  it("re-runs a run once when several red checks belong to it", async () => {
    const app = await buildApp();
    await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
    mockFetchCheckRunsForHead.mockResolvedValue([
      { name: "test-node / shard (1)", conclusion: "failure", url: runUrl(4242, 1) },
      { name: "test-node / shard (2)", conclusion: "failure", url: runUrl(4242, 2) },
    ]);

    await reconcileTasks(app);

    expect(mockRerunFailedJobs).toHaveBeenCalledTimes(1);
    expect(mockRerunFailedJobs).toHaveBeenCalledWith("tok", "o", "r", 4242);

    await app.close();
  });

  it("holds without parking or returning when the rerun request itself fails", async () => {
    const app = await buildApp();
    const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
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
      ciReturnHeadSha: HEAD_SHA,
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
    const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
    const current = {
      headSha: HEAD_SHA,
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
    expect(row.ciReturnHeadSha).toBe(HEAD_SHA);
    expect(row.ciRerunCount).toBe(0);

    await app.close();
  });
  describe("a worker that declares the red check unfixable from this PR", () => {
    const declare = (app: Awaited<ReturnType<typeof buildApp>>, taskId: number, text: string) =>
      fs.writeFileSync(taskCiUnfixablePath(app.pty.sessionsDir, taskId, HEAD_SHA), text);

    it("parks as ci-unfixable at once: no rerun, the reason sanitised, the checks named", async () => {
      const app = await buildApp();
      const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
      declare(
        app,
        taskId,
        "dependency-audit fails on @octocat's advisory GHSA-x with no patched release.\n\nBearer abc.def-ghi token <b>x</b>",
      );

      await reconcileTasks(app);

      expect(mockRerunFailedJobs).not.toHaveBeenCalled();
      const row = getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.needsHumanReason).toBe("ci-unfixable");
      expect(row.autoReturnCapAnnouncedAt).not.toBeNull();
      expect(row.lastReviewedHeadSha).toBe(HEAD_SHA);
      expect(row.autoReturnRounds).toBe(0);
      // The note names the check and carries the reason, flattened and neutralised.
      expect(row.ciHoldNote).toContain("test-frontend / test-merge — dependency-audit fails on");
      expect(row.ciHoldNote).not.toContain("\n");
      expect(row.ciHoldNote).not.toContain("@octocat");
      expect(row.ciHoldNote).not.toContain("abc.def-ghi");
      expect(row.ciHoldNote).not.toContain("<b>");
      expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
      const body = mockCreatePullRequestReview.mock.calls[0][4].body as string;
      expect(body).toContain("(test-frontend / test-merge)");
      expect(body).toContain("no change to this PR can fix it");
      expect(body).toContain("None of them is a required check.");
      expect(body).not.toContain("lost runner");

      await app.close();
    });

    it("says a required check is involved when GitHub reports the PR blocked", async () => {
      const app = await buildApp();
      const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
      declare(app, taskId, "upstream outage");

      await reconcileTasks(app);

      const body = mockCreatePullRequestReview.mock.calls[0][4].body as string;
      expect(body).toContain("At least one of them is a required check.");

      await app.close();
    });

    it("ignores a declaration written for an older head and re-runs as before", async () => {
      const app = await buildApp();
      const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
      fs.writeFileSync(
        taskCiUnfixablePath(app.pty.sessionsDir, taskId, "b".repeat(40)),
        "was about the previous head",
      );

      await reconcileTasks(app);

      expect(mockRerunFailedJobs).toHaveBeenCalledTimes(1);
      expect(getTask(app, taskId).needsHumanReason).toBeNull();

      await app.close();
    });

    it("holds the tick, neither rerunning nor parking, while the host holding the file is unreachable", async () => {
      const app = await buildApp();
      const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
      ciUnfixableRead.impl = async () => {
        throw new HostUnreachableError("host-1", new Error("down"));
      };

      await reconcileTasks(app);

      expect(mockRerunFailedJobs).not.toHaveBeenCalled();
      expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
      const row = getTask(app, taskId);
      expect(row.needsHumanReason).toBeNull();
      expect(row.autoReturnCapAnnouncedAt).toBeNull();

      await app.close();
    });

    it("treats a read error that will not heal (an old peer build) as no declaration", async () => {
      const app = await buildApp();
      const taskId = await createCandidate(app, { ciReturnHeadSha: HEAD_SHA });
      ciUnfixableRead.impl = async () => {
        throw new Error("404 no such route");
      };

      await reconcileTasks(app);

      expect(mockRerunFailedJobs).toHaveBeenCalledTimes(1);
      expect(getTask(app, taskId).needsHumanReason).toBeNull();

      await app.close();
    });

    it("does not re-announce a task that is already parked", async () => {
      const app = await buildApp();
      const taskId = await createCandidate(app, {
        ciReturnHeadSha: HEAD_SHA,
        autoReturnCapAnnouncedAt: new Date(),
        needsHumanReason: "ci-unfixable",
        lastReviewedHeadSha: HEAD_SHA,
      });
      declare(app, taskId, "still unfixable");

      await reconcileTasks(app);

      expect(mockCreatePullRequestReview).not.toHaveBeenCalled();

      await app.close();
    });
  });
});
