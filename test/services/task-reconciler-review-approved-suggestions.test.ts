import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { PR_REVIEW_DEFAULTS } from "../helpers/pr-review-defaults.js";
import { seedHostResponse } from "../helpers/hosts.js";
import {
  reconcilerMocks,
  mockPushDeliveryFactory,
  mockHermesIntegrationFactory,
  mockHermesTaskReviewFactory,
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  mockTaskReseedFactory,
  mockHostGitFactory,
  mockGitWorktreeFactory,
  mockGithubIntegrationFactory,
  mockGithubWriteFactory,
  mockGithubFactory,
  setupReconcilerTestLifecycle,
  restorePassThroughMocks,
  fakeInfo,
  getTask,
  createSessionAndTaskWithReviewAgent,
  mockFinishedSessionIds,
  claimIntoReviewing,
  writeFindings,
} from "../helpers/task-reconciler-harness.js";

vi.mock("../../src/services/push-delivery.js", (io) => mockPushDeliveryFactory(io));
vi.mock("../../src/services/hermes-integration.js", (io) => mockHermesIntegrationFactory(io));
vi.mock("../../src/services/hermes-task-review.js", (io) => mockHermesTaskReviewFactory(io));
vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", (io) => mockTaskPromoteFactory(io));
vi.mock("../../src/services/task-reseed.js", (io) => mockTaskReseedFactory(io));
vi.mock("../../src/services/host-git.js", (io) => mockHostGitFactory(io));
vi.mock("../../src/services/git-worktree.js", (io) => mockGitWorktreeFactory(io));
vi.mock("../../src/services/github-integration.js", (io) => mockGithubIntegrationFactory(io));
vi.mock("../../src/services/github-write.js", (io) => mockGithubWriteFactory(io));
vi.mock("../../src/services/github.js", (io) => mockGithubFactory(io));

const { buildApp } = await import("../../src/app.js");
const { reconcileTasks, DEFAULT_MAX_AUTO_RETURN_ROUNDS } =
  await import("../../src/services/task-reconciler.js");
const { tasks, sessions, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { taskReviewFindingsPath, taskRereviewRequestPath } =
  await import("../../src/services/task-prompt.js");
const { setRepoPRsStatus, invalidatePRsCache } = await import("../../src/services/github.js");

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockCreatePullRequestReview,
} = reconcilerMocks;

describe("reconcileTasks — approved-with-suggestions", () => {
  setupReconcilerTestLifecycle("task-reconciler-review-approved-suggestions");
  describe("approved-with-suggestions", () => {
    const SUGGESTIONS_JSON = JSON.stringify({
      verdict: "approved",
      summary: "Looks good, two nits.",
      findings: [{ path: "a.ts", line: 3, severity: "suggestion", body: "rename x to count" }],
    });

    it("returns the task to the worker without spending a round, carrying the approval", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, SUGGESTIONS_JSON);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.lastAutoReturnReason).toBe("suggestions");
      expect(row.lastReviewVerdict).toBe("approved-with-suggestions");
      expect(row.approvalCarriedAt).not.toBeNull();
      expect(row.reviewSessionId).toBe(reviewSessionId);
      expect(row.reviewFindings).toContain("rename x to count");
      expect(row.sessionId).not.toBe(workerSessionId);

      await app.close();
    });

    it("skips the re-review when the worker returns: same review session, approval kept", async () => {
      const app = await buildApp();
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, SUGGESTIONS_JSON);
      await reconcileTasks(app);
      const returned = await getTask(app, taskId);
      // The re-spawned worker finishes its turn.
      mockFinishedSessionIds(app, returned.sessionId as number);

      await reconcileTasks(app);
      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      // No new review agent: the pointer neither changed nor was nulled and
      // respawned the ingested marker still matches it — which is what
      // the auto-approve gate reads.
      expect(row.reviewSessionId).toBe(reviewSessionId);
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.lastReviewVerdict).toBe("approved-with-suggestions");
      expect(row.approvalCarriedAt).not.toBeNull();
      expect(row.autoReturnRounds).toBe(0);

      await app.close();
    });

    it("re-reviews when the worker asks for it by writing the re-review request file", async () => {
      const app = await buildApp();
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, SUGGESTIONS_JSON);
      await reconcileTasks(app);
      const returned = await getTask(app, taskId);
      fs.writeFileSync(
        taskRereviewRequestPath(
          path.dirname(app.pty.hookSocketPath),
          taskId,
          Math.floor(returned.lastReviewVerdictAt!.getTime() / 1000),
        ),
        "the fix grew into a refactor",
      );
      mockFinishedSessionIds(app, returned.sessionId as number);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.approvalCarriedAt).toBeNull();
      // Asking for a review spends a round, so the hatch can't loop forever.
      expect(row.autoReturnRounds).toBe(1);
      // A genuinely new review: the old pointer was dropped and a fresh
      // review session spawned in its place.
      expect(row.reviewSessionId).not.toBe(reviewSessionId);
      expect(row.reviewFindingsIngestedSessionId).not.toBe(row.reviewSessionId);

      await app.close();
    });

    it("still returns the suggestions on a task that has used every round it had", async () => {
      const app = await buildApp();
      const { taskId } = await claimIntoReviewing(app, "codex");
      app.db
        .update(tasks)
        .set({ autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS })
        .where(eq(tasks.id, taskId))
        .run();
      writeFindings(app, taskId, DEFAULT_MAX_AUTO_RETURN_ROUNDS, SUGGESTIONS_JSON);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(DEFAULT_MAX_AUTO_RETURN_ROUNDS);
      // Not parked as "needs a human": the task is moving.
      expect(row.autoReturnCapAnnouncedAt).toBeNull();

      await app.close();
    });

    it("does not return an all-suggestions review whose worker can't take a seeded prompt", async () => {
      const app = await buildApp();
      const { taskId } = await claimIntoReviewing(app, "codex");
      app.db.update(tasks).set({ agentCommand: "bash" }).where(eq(tasks.id, taskId)).run();
      writeFindings(app, taskId, 0, SUGGESTIONS_JSON);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.lastReviewVerdict).toBe("approved-with-suggestions");
      expect(row.approvalCarriedAt).toBeNull();

      await app.close();
    });

    // The read goes through the backend, which for a remote host can fail.
    // A host that is only unreachable may hold a request the worker wrote,
    // so wait; any other failure (an old peer, a 5xx) can't heal, so carry.
    async function returnedWithFinishedWorker(
      app: Awaited<ReturnType<typeof buildApp>>,
      readRequest: (taskId: number, key: number) => Promise<string | null>,
    ) {
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, SUGGESTIONS_JSON);
      await reconcileTasks(app);
      const returned = await getTask(app, taskId);
      mockFinishedSessionIds(app, returned.sessionId as number);
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const spy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "readTaskRereviewRequest") return readRequest;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });
      return { taskId, reviewSessionId, spy };
    }

    it("waits a tick, without leaving in_progress, when the host is unreachable for the re-review request", async () => {
      const { HostUnreachableError } = await import("../../src/services/remote-host-client.js");
      const app = await buildApp();
      const { taskId, spy } = await returnedWithFinishedWorker(app, () =>
        Promise.reject(new HostUnreachableError("h", "down")),
      );

      await reconcileTasks(app);

      expect((await getTask(app, taskId)).status).toBe("in_progress");

      spy.mockRestore();
      await app.close();
    });

    it("one task's unreachable host does not stall the other tasks on that host", async () => {
      const { HostUnreachableError } = await import("../../src/services/remote-host-client.js");
      const app = await buildApp();
      const first = await returnedWithFinishedWorker(app, (taskId) =>
        taskId === first.taskId
          ? Promise.reject(new HostUnreachableError("h", "down"))
          : Promise.resolve(null),
      );
      // A second task whose worker has just finished, on the same host.
      const { taskId: otherId, sessionId: otherWorker } = await createSessionAndTaskWithReviewAgent(
        app,
        "in_progress",
        "codex",
      );
      app.db.update(tasks).set({ agentCommand: "codex" }).where(eq(tasks.id, otherId)).run();
      const firstRow = await getTask(app, first.taskId);
      mockFinishedSessionIds(app, firstRow.sessionId as number, otherWorker);

      await reconcileTasks(app);

      expect((await getTask(app, first.taskId)).status).toBe("in_progress");
      expect((await getTask(app, otherId)).status).toBe("reviewing");

      first.spy.mockRestore();
      await app.close();
    });

    it("carries the approval when the re-review request can't be read for any other reason", async () => {
      const app = await buildApp();
      const { taskId, reviewSessionId, spy } = await returnedWithFinishedWorker(app, () =>
        Promise.reject(new Error("HTTP 404 from an old peer")),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBe(reviewSessionId);
      expect(row.approvalCarriedAt).not.toBeNull();

      spy.mockRestore();
      await app.close();
    });

    it("a re-review after an approval ignores dispositions for the earlier optional suggestions", async () => {
      const app = await buildApp();
      const { taskId } = await claimIntoReviewing(app, "codex");
      app.db
        .update(tasks)
        .set({ lastReviewVerdict: "approved-with-suggestions" })
        .where(eq(tasks.id, taskId))
        .run();
      writeFindings(
        app,
        taskId,
        0,
        JSON.stringify({
          verdict: "approved",
          summary: "Grew, but fine.",
          previous: [{ ref: "a.ts:3", status: "still-open", evidence: "nit not applied" }],
        }),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.lastReviewVerdict).toBe("approved");
      expect(row.status).toBe("reviewing");

      await app.close();
    });

    it("a human Reject clears the carried approval so the next finish is reviewed", async () => {
      const app = await buildApp();
      const { taskId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, SUGGESTIONS_JSON);
      await reconcileTasks(app);
      // Back in reviewing with the approval carried…
      const returned = await getTask(app, taskId);
      mockFinishedSessionIds(app, returned.sessionId as number);
      await reconcileTasks(app);
      expect((await getTask(app, taskId)).approvalCarriedAt).not.toBeNull();

      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/reject`,
        payload: { feedback: "not good enough" },
      });

      expect(res.statusCode).toBe(200);
      expect((await getTask(app, taskId)).approvalCarriedAt).toBeNull();

      await app.close();
    });
  });

  // Issue #1357 — a task that sat in "reviewing" long enough for its
  // ORIGINAL claimedAt to already be past the budget deadline (real
  // incident: task 410657, review round revived by #1346's own rearm
  // sweep hours after the original claim) used to have its freshly
  // auto-returned worker session immediately killed by the SAME
  // reconcileTasks() tick's own budget-exceeded check
  // (reconcileTasks runs processReviewingTasks, which calls
  // before its own claimed/in_progress budget-check pass
  // further down — both in one call, confirmed by reading
  // reconcileTasks's own body). autoReturnTask must reset claimedAt so
  // this doesn't happen.
  it("does not get budget-killed by the same tick's own budget check after an auto-return (issue #1357)", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    try {
      const app = await buildApp();
      const { taskId, workerSessionId } = await claimIntoReviewing(app, "codex");
      // Simulate a task that has sat in "reviewing" long enough for its
      // original claimedAt to already be outside the (tightened) budget
      // window by the time a real verdict finally lands — exactly what
      // #1346's rearm sweep produces on a task that stalled for a while.
      const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      app.db.update(tasks).set({ claimedAt: longAgo }).where(eq(tasks.id, taskId)).run();
      writeFindings(
        app,
        taskId,
        0,
        JSON.stringify({
          verdict: "changes-requested",
          summary: "One thing to fix.",
          findings: [{ path: "a.ts", line: 1, body: "fix this" }],
        }),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      // Before the fix: this task would be "failed" with
      // failureReason containing "budget exceeded" — the freshly
      // re-seeded worker session killed within the same tick, before it
      // ever got a turn.
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.failureReason).toBeNull();
      expect(row.sessionId).not.toBe(workerSessionId);
      expect(row.claimedAt).not.toBeNull();
      expect(row.claimedAt!.getTime()).toBeGreaterThan(longAgo.getTime());

      await app.close();
    } finally {
      process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    }
  });

  it("does not re-ingest (or re-comment) an already-processed review session's output on a later tick", async () => {
    const app = await buildApp();
    const { taskId } = await claimIntoReviewing(app, "codex");

    await reconcileTasks(app);
    const afterFirst = await getTask(app, taskId);

    await reconcileTasks(app);
    const afterSecond = await getTask(app, taskId);

    expect(afterSecond.reviewFindings).toBe(afterFirst.reviewFindings);
    expect(afterSecond.status).toBe(afterFirst.status);

    await app.close();
  });

  // #756 — the round cap is no longer hardcoded to 1; the DEFAULT cap
  // (`DEFAULT_MAX_AUTO_RETURN_ROUNDS`, currently 2) is what this task has
  // already spent, not a literal "1". A separate test below (using a
  // project-level override) proves the cap is genuinely configurable, not
  // just a renamed constant.
  it("does not auto-return once the round cap is reached — findings are still captured", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-bounded", cwd: "/tmp" },
    });
    const workerSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const reviewSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "already at the round cap",
        status: "reviewing",
        sessionId: workerSession.json().id,
        reviewSessionId: reviewSession.json().id,
        autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
        worktreePath: "/tmp",
        agentCommand: "claude",
        claimedAt: new Date(),
      })
      .returning()
      .all();
    mockFinishedSessionIds(app, reviewSession.json().id);
    writeFindings(
      app,
      task.id,
      DEFAULT_MAX_AUTO_RETURN_ROUNDS,
      "A third-round finding, arriving after the cap.",
    );

    await reconcileTasks(app);

    const row = await getTask(app, task.id);
    expect(row.status).toBe("reviewing");
    expect(row.autoReturnRounds).toBe(DEFAULT_MAX_AUTO_RETURN_ROUNDS);
    expect(row.reviewFindings).toContain("arriving after the cap");
    expect(row.sessionId).toBe(workerSession.json().id);
    // Issue #1038 — the ground-truth "the machine actually stopped"
    // signal, set in the same durable write as the findings above.
    expect(row.autoReturnCapAnnouncedAt).not.toBeNull();

    await app.close();
  });

  // Issue #1038 — the mirror image of the test above: a round that is
  // NOT at the cap must never set the announcement, or the board would
  // claim "needs a human" on a task that's still genuinely mid-cycle.
  it("does not set the cap-announced marker on a round below the cap", async () => {
    const app = await buildApp();
    const { taskId } = await claimIntoReviewing(app, "codex");
    writeFindings(app, taskId, 0, "Fix the null check on line 42.");

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.autoReturnRounds).toBe(1);
    expect(row.autoReturnCapAnnouncedAt).toBeNull();

    await app.close();
  });

  // Issue #1039 — the ingest write also records the PR head SHA a
  // round's findings are actually about, read from the existing
  // github-pr-poller.ts cache. This is reannounceCappedTasksAfterHumanPush's
  // only source of a comparison baseline; a regression here would silently
  // break the whole re-arm-after-a-human-push feature without failing any
  // of that feature's own dedicated tests (which seed the baseline
  // directly rather than going through this ingest path).
  it("records the PR's cached head SHA on the ingest write", async () => {
    const app = await buildApp();
    const { taskId } = await claimIntoReviewing(app, "codex");
    app.db.update(tasks).set({ prNumber: 9 }).where(eq(tasks.id, taskId)).run();
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    setRepoPRsStatus("o", "r", {
      prs: [
        {
          number: 9,
          title: "test pr",
          htmlUrl: "https://github.com/o/r/pull/9",
          author: "dev",
          ...PR_REVIEW_DEFAULTS,
          headSha: "sha-ingested",
          headBranch: "feature",
          baseBranch: "main",
          ciStatus: null,
          actionsRuns: [],
        },
      ],
      prSummary: { total: 1, pass: 0, fail: 0, pending: 0, unknown: 1 },
    });
    writeFindings(app, taskId, 0, "Fix the null check on line 42.");

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.lastReviewedHeadSha).toBe("sha-ingested");

    restorePassThroughMocks();
    invalidatePRsCache("o", "r");
    await app.close();
  });

  // Hermes review, PR #1040 — a capped task's FINAL review can come back
  // clean or inconclusive, not just changes-requested. Nothing
  // auto-returns a non-"changes-requested" verdict either way, so this
  // task is just as genuinely parked as one whose last round wanted
  // (and was denied) another — gating the announcement on
  // `wantsAutoReturn && capReached` left this case unannounced forever,
  // and the board kept claiming "review in flight" on a task nothing
  // further would ever touch. No cap-reached comment posts here (that
  // text specifically means "you wanted another round and couldn't have
  // one," which isn't true for a clean verdict) — only the DB marker.
  it("sets the cap-announced marker on a capped task's clean final verdict, with no cap-reached comment posted", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-bounded-clean", cwd: "/tmp" },
    });
    const workerSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const reviewSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "already at the round cap, final review is clean",
        status: "reviewing",
        sessionId: workerSession.json().id,
        reviewSessionId: reviewSession.json().id,
        autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
        worktreePath: "/tmp",
        agentCommand: "claude",
        prNumber: 9,
        claimedAt: new Date(),
      })
      .returning()
      .all();
    mockFinishedSessionIds(app, reviewSession.json().id);
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      nodeId: "PR_node9",
      draft: false,
      headSha: "sha-head",
    });
    writeFindings(
      app,
      task.id,
      DEFAULT_MAX_AUTO_RETURN_ROUNDS,
      JSON.stringify({ verdict: "clean", summary: "All good." }),
    );

    await reconcileTasks(app);

    const row = await getTask(app, task.id);
    expect(row.status).toBe("reviewing");
    expect(row.autoReturnRounds).toBe(DEFAULT_MAX_AUTO_RETURN_ROUNDS);
    expect(row.lastReviewVerdict).toBe("approved");
    expect(row.autoReturnCapAnnouncedAt).not.toBeNull();
    // The normal clean-verdict review comment still posts (proving
    // postReviewFindingsComment actually ran here, not just skipped for
    // lack of a token/PR) — but its body must not carry the "round cap"
    // wording, which specifically claims another round was wanted and
    // denied.
    expect(mockCreatePullRequestReview).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      9,
      expect.objectContaining({ body: expect.not.stringContaining("round cap") }),
    );

    await app.close();
  });

  // Task 258971's investigation: the round-cap note must survive into
  // `reviewSummary`, not just `body` — `postReviewFindingsComment` posts
  // `reviewSummary` (not `body`) whenever there are inline anchors to
  // attach, which is exactly the case for a real changes-requested verdict
  // with structured findings (PR #136 had 8 of them across four rounds,
  // and the note was silently missing from all four). The test above this
  // one only asserts DB state; this one asserts the actual GitHub call.
  it("includes the round-cap note in the review body even when findings are posted as inline anchors", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-bounded-anchored", cwd: "/tmp" },
    });
    const workerSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const reviewSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "already at the round cap, with anchored findings",
        status: "reviewing",
        sessionId: workerSession.json().id,
        reviewSessionId: reviewSession.json().id,
        autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
        worktreePath: "/tmp",
        agentCommand: "claude",
        prNumber: 9,
        claimedAt: new Date(),
      })
      .returning()
      .all();
    mockFinishedSessionIds(app, reviewSession.json().id);
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      nodeId: "PR_node9",
      draft: false,
      headSha: "sha-head",
    });
    writeFindings(
      app,
      task.id,
      DEFAULT_MAX_AUTO_RETURN_ROUNDS,
      JSON.stringify({
        verdict: "changes-requested",
        summary: "Still failing lint.",
        findings: [{ path: "cmd/branchdam/main.go", line: 42, body: "unchecked error return" }],
      }),
    );

    await reconcileTasks(app);

    expect(mockCreatePullRequestReview).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      9,
      expect.objectContaining({
        body: expect.stringContaining(`round cap (${DEFAULT_MAX_AUTO_RETURN_ROUNDS})`),
        comments: [
          expect.objectContaining({
            path: "cmd/branchdam/main.go",
            line: 42,
            body: expect.stringContaining("unchecked error return"),
          }),
        ],
      }),
    );

    await app.close();
  });

  // The PR review body ("reviewSummary") must not repeat a finding's
  // path:line as prose when that SAME finding is also posted as GitHub's
  // own anchored inline comment — autonomous-pr-review §5 the whole
  // point of the "review-body" render mode. `tasks.reviewFindings` (the
  // task detail drawer's own record, asserted via `row.reviewFindings`
  // below) intentionally keeps the bullet form — nothing there is
  // anchored to anything.
  it("renders the PR review body with a per-section anchor count, not repeated path:line prose", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "p-review-body-anchors",
        cwd: "/tmp",
      },
    });
    const workerSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const reviewSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "a real changes-requested review with a blocker finding",
        status: "reviewing",
        sessionId: workerSession.json().id,
        reviewSessionId: reviewSession.json().id,
        worktreePath: "/tmp",
        agentCommand: "claude",
        prNumber: 9,
        claimedAt: new Date(),
      })
      .returning()
      .all();
    mockFinishedSessionIds(app, reviewSession.json().id);
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      nodeId: "PR_node9",
      draft: false,
      headSha: "sha-head",
    });
    writeFindings(
      app,
      task.id,
      0,
      JSON.stringify({
        verdict: "changes-requested",
        summary: "One blocker.",
        findings: [
          {
            path: "cmd/branchdam/main.go",
            line: 42,
            severity: "blocker",
            body: "unchecked error return",
          },
        ],
        verified: ["make lint && make typecheck"],
      }),
    );

    await reconcileTasks(app);

    expect(mockCreatePullRequestReview).toHaveBeenCalledWith(
      "tok",
      "o",
      "r",
      9,
      expect.objectContaining({
        body: expect.stringContaining("### Critical\n- 1 finding(s) anchored inline below"),
        comments: [
          expect.objectContaining({
            path: "cmd/branchdam/main.go",
            line: 42,
            body: expect.stringContaining("unchecked error return"),
          }),
        ],
      }),
    );
    const lastCall = mockCreatePullRequestReview.mock.calls.at(-1) as [
      string,
      string,
      string,
      number,
      { body: string },
    ];
    expect(lastCall[4].body).not.toContain("cmd/branchdam/main.go:42");

    // tasks.reviewFindings (the drawer's own record) keeps the bullet
    // form — it never anchors to anything, so there is nothing to avoid
    // repeating.
    const row = await getTask(app, task.id);
    expect(row.reviewFindings).toContain("cmd/branchdam/main.go:42");

    await app.close();
  });

  // #756's whole point: a project with the default cap gets a SECOND
  // automatic round, where the pre-#756 behavior would have stalled in
  // "reviewing" after the first.
  it("auto-returns for a second round under the default cap", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-second-round", cwd: "/tmp" },
    });
    const workerSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const reviewSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "spending its second round",
        status: "reviewing",
        sessionId: workerSession.json().id,
        reviewSessionId: reviewSession.json().id,
        autoReturnRounds: 1,
        worktreePath: "/tmp",
        agentCommand: "claude",
        claimedAt: new Date(),
      })
      .returning()
      .all();
    mockFinishedSessionIds(app, reviewSession.json().id);
    writeFindings(app, task.id, 1, "A second finding, still under the cap.");

    await reconcileTasks(app);

    const row = await getTask(app, task.id);
    expect(row.status).toBe("in_progress");
    expect(row.autoReturnRounds).toBe(2);
    expect(row.lastAutoReturnReason).toBe("review");
    expect(row.reviewFindings).toContain("still under the cap");

    await app.close();
  });

  // A per-project override must actually be read, not just the default —
  // a cap of 1 makes THIS task's first round the last one it's allowed.
  it("honors a per-project maxAutoReturnRounds override lower than the default", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-low-cap", cwd: "/tmp" },
    });
    const projectId = project.json().id;
    app.db.update(projects).set({ maxAutoReturnRounds: 1 }).where(eq(projects.id, projectId)).run();
    const workerSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const reviewSession = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "capped at one round by project override",
        status: "reviewing",
        sessionId: workerSession.json().id,
        reviewSessionId: reviewSession.json().id,
        autoReturnRounds: 1,
        worktreePath: "/tmp",
        agentCommand: "claude",
        claimedAt: new Date(),
      })
      .returning()
      .all();
    mockFinishedSessionIds(app, reviewSession.json().id);
    writeFindings(app, task.id, 1, "Blocked by this project's own lower cap.");

    await reconcileTasks(app);

    const row = await getTask(app, task.id);
    expect(row.status).toBe("reviewing");
    expect(row.autoReturnRounds).toBe(1);
    expect(row.reviewFindings).toContain("Blocked by this project's own lower cap");

    await app.close();
  });

  it("does not auto-return while Task Master is disabled, even with non-empty findings", async () => {
    const app = await buildApp();
    try {
      const { taskId, workerSessionId } = await claimIntoReviewing(app, "codex");
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { enabled: "off" } },
      });
      writeFindings(app, taskId, 0, "Findings nobody will act on automatically.");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toContain("Findings nobody will act on automatically");
      expect(row.sessionId).toBe(workerSessionId);
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { enabled: "inherit" } },
      });
      await app.close();
    }
  });

  it("runs even on a tick with zero claimed/in_progress tasks", async () => {
    const app = await buildApp();
    const { taskId } = await claimIntoReviewing(app, "codex");
    writeFindings(app, taskId, 0, "Should still be picked up.");
    // No other claimed/in_progress task exists at this point — the
    // claimed/in_progress loop's own `rows.length === 0` early return
    // must not skip this task's processing.

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.reviewFindings).toContain("Should still be picked up");

    await app.close();
  });

  it("removes the round's findings file from disk once its content is durably ingested", async () => {
    const app = await buildApp();
    const { taskId } = await claimIntoReviewing(app, "codex");
    const findingsPath = taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), taskId, 0);
    writeFindings(app, taskId, 0, "This file should be gone after ingestion.");
    expect(fs.existsSync(findingsPath)).toBe(true);

    await reconcileTasks(app);

    expect(fs.existsSync(findingsPath)).toBe(false);

    await app.close();
  });

  // #760 — this loop used to skip every remote-hosted task outright
  // (Hermes review, PR #576, finding #1: the findings file lives in
  // THIS process's own local sessionsDir reading local-only for a
  // remote-hosted review would falsely conclude "no findings"). #760
  // replaced that with SessionBackend.readTaskReviewFindings, which
  // reads from whichever host actually ran the review — so a remote
  // host is no longer skipped outright; it's only skipped when
  // genuinely unreachable, same as every other host-aware sweep in this
  // file (e.g. the merge sweep's own liveStatus failure handling). This
  // test's host (`http://127.0.0.1:1`) is unreachable by construction,
  // so it's caught by liveStatus's own pre-existing catch below, before
  // readTaskReviewFindings is ever called — never ingested as
  // inconclusive, never silently dropped either.
  it("skips (does not ingest as inconclusive) a remote-hosted task whose host is unreachable", async () => {
    const app = await buildApp();
    const host = await seedHostResponse(app, {
      name: "Remote",
      baseUrl: "http://127.0.0.1:1",
      token: "t",
    });
    const hostId = host.json().id as string;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, name: "p-remote-review", cwd: "/remote/project", hostId },
    });
    const projectId = project.json().id;
    const [workerSession] = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", status: "active" })
      .returning()
      .all();
    const [reviewSession] = app.db
      .insert(sessions)
      .values({ projectId, command: "codex", status: "active" })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "remote review",
        status: "reviewing",
        sessionId: workerSession.id,
        reviewSessionId: reviewSession.id,
        worktreePath: "/remote/project",
        agentCommand: "codex",
        claimedAt: new Date(),
      })
      .returning()
      .all();
    const warnSpy = vi.spyOn(app.log, "warn");

    await reconcileTasks(app);

    const row = await getTask(app, task.id);
    expect(row.status).toBe("reviewing");
    expect(row.reviewFindings).toBeNull();
    expect(row.reviewFindingsIngestedSessionId).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ hostId }),
      expect.stringContaining("host unreachable, skipping its review sessions"),
    );

    await app.close();
  });

  // #760 — the actual point of this feature: a REACHABLE remote host's
  // review findings are now read (via SessionBackend.readTaskReviewFindings)
  // and ingested exactly like a local task's, instead of being skipped
  // outright.
  it("ingests a reachable remote-hosted task's review findings via the resolved backend", async () => {
    const app = await buildApp();
    const host = await seedHostResponse(app, {
      name: "Remote",
      baseUrl: "http://127.0.0.1:1",
      token: "t",
    });
    const hostId = host.json().id as string;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        name: "p-remote-review-ok",
        cwd: "/remote/project",
        hostId,
      },
    });
    const projectId = project.json().id;
    const [workerSession] = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", status: "active" })
      .returning()
      .all();
    const [reviewSession] = app.db
      .insert(sessions)
      .values({ projectId, command: "codex", status: "active" })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "remote review, reachable",
        status: "reviewing",
        sessionId: workerSession.id,
        reviewSessionId: reviewSession.id,
        worktreePath: "/remote/project",
        agentCommand: "codex",
        claimedAt: new Date(),
      })
      .returning()
      .all();

    const sessionBackendModule = await import("../../src/services/session-backend.js");
    const realResolveBackend = sessionBackendModule.resolveBackend;
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const resolveBackendSpy = vi
      .spyOn(sessionBackendModule, "resolveBackend")
      .mockImplementation((appArg, hId) => {
        const real = realResolveBackend(appArg, hId);
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "liveStatus") {
              return async () => ({
                [String(reviewSession.id)]: fakeInfo({
                  lastTurnEndedAt: Date.now(),
                }),
              });
            }
            if (prop === "readTaskReviewFindings") {
              return async () =>
                JSON.stringify({
                  verdict: "clean",
                  summary: "Looks good from the remote agent.",
                });
            }
            if (prop === "deleteTaskReviewFindings") return deleteMock;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });

    await reconcileTasks(app);

    const row = await getTask(app, task.id);
    expect(row.reviewFindingsIngestedSessionId).toBe(reviewSession.id);
    expect(row.reviewFindings).toContain("Looks good from the remote agent.");
    expect(row.lastReviewVerdict).toBe("approved");
    expect(deleteMock).toHaveBeenCalledWith(task.id, 0);

    resolveBackendSpy.mockRestore();
    await app.close();
  });

  // #760 — the safety requirement, stated precisely in the issue: a read
  // FAILURE (host unreachable mid-read, a peer 5xx, a version-skew 404 —
  // anything readTaskReviewFindings throws) must never collapse into "the
  // file is absent." This exercises that distinction directly against a
  // backend whose liveStatus succeeds (so the row isn't skipped at the
  // host level) but whose read throws.
  it("does not ingest as inconclusive when readTaskReviewFindings itself throws (host unreachable mid-read, a peer 5xx, or version skew)", async () => {
    const app = await buildApp();
    const host = await seedHostResponse(app, {
      name: "Remote",
      baseUrl: "http://127.0.0.1:1",
      token: "t",
    });
    const hostId = host.json().id as string;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        name: "p-remote-review-readfail",
        cwd: "/remote/project",
        hostId,
      },
    });
    const projectId = project.json().id;
    const [workerSession] = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", status: "active" })
      .returning()
      .all();
    const [reviewSession] = app.db
      .insert(sessions)
      .values({ projectId, command: "codex", status: "active" })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "remote review, read fails",
        status: "reviewing",
        sessionId: workerSession.id,
        reviewSessionId: reviewSession.id,
        worktreePath: "/remote/project",
        agentCommand: "codex",
        claimedAt: new Date(),
      })
      .returning()
      .all();

    const sessionBackendModule = await import("../../src/services/session-backend.js");
    const realResolveBackend = sessionBackendModule.resolveBackend;
    const resolveBackendSpy = vi
      .spyOn(sessionBackendModule, "resolveBackend")
      .mockImplementation((appArg, hId) => {
        const real = realResolveBackend(appArg, hId);
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "liveStatus") {
              return async () => ({
                [String(reviewSession.id)]: fakeInfo({
                  lastTurnEndedAt: Date.now(),
                }),
              });
            }
            if (prop === "readTaskReviewFindings") {
              return async () => {
                throw new Error("HTTP 404 — this peer build has no such route");
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
    const warnSpy = vi.spyOn(app.log, "warn");

    await reconcileTasks(app);

    const row = await getTask(app, task.id);
    expect(row.status).toBe("reviewing");
    expect(row.reviewFindings).toBeNull();
    expect(row.reviewFindingsIngestedSessionId).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, round: 0 }),
      expect.stringContaining("failed to read review findings file"),
    );

    resolveBackendSpy.mockRestore();
    await app.close();
  });

  // Fresh-review follow-up on #760's own merge: a remote read that
  // SUCCEEDS but genuinely finds nothing (returns `null`, not a throw) —
  // e.g. because the remote host's `sessionsDir` doesn't match the one the
  // seed prompt was built from (`#778`, the documented, still-open gap) —
  // must still go through the exact same grace-window/inconclusive path a
  // local task's missing file does, not something worse or silently
  // different for remote hosts.
  it("ingests a reachable remote-hosted task as inconclusive once the grace window elapses with a genuinely absent (not thrown) findings read", async () => {
    const app = await buildApp();
    const host = await seedHostResponse(app, {
      name: "Remote",
      baseUrl: "http://127.0.0.1:1",
      token: "t",
    });
    const hostId = host.json().id as string;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        name: "p-remote-review-absent",
        cwd: "/remote/project",
        hostId,
      },
    });
    const projectId = project.json().id;
    const [workerSession] = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", status: "active" })
      .returning()
      .all();
    const [reviewSession] = app.db
      .insert(sessions)
      .values({
        projectId,
        command: "codex",
        status: "active",
        createdAt: new Date(Date.now() - 31 * 60_000),
      })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "remote review, genuinely absent",
        status: "reviewing",
        sessionId: workerSession.id,
        reviewSessionId: reviewSession.id,
        worktreePath: "/remote/project",
        agentCommand: "codex",
        claimedAt: new Date(),
      })
      .returning()
      .all();

    const sessionBackendModule = await import("../../src/services/session-backend.js");
    const realResolveBackend = sessionBackendModule.resolveBackend;
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const resolveBackendSpy = vi
      .spyOn(sessionBackendModule, "resolveBackend")
      .mockImplementation((appArg, hId) => {
        const real = realResolveBackend(appArg, hId);
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "liveStatus") {
              return async () => ({
                [String(reviewSession.id)]: fakeInfo({
                  lastTurnEndedAt: Date.now(),
                }),
              });
            }
            if (prop === "readTaskReviewFindings") return async () => null;
            if (prop === "deleteTaskReviewFindings") return deleteMock;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });

    await reconcileTasks(app);

    const row = await getTask(app, task.id);
    expect(row.status).toBe("reviewing");
    expect(row.reviewFindings).toContain("inconclusive");
    expect(row.reviewFindingsIngestedSessionId).toBe(reviewSession.id);

    resolveBackendSpy.mockRestore();
    await app.close();
  });
});
