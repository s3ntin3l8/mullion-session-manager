// A conflicting PR (mergeableState "dirty") gets no review: the dispatch passes
// hand it to the auto-rebase flow, and once that gives up (or is off) back to
// its worker (#3339).
import { describe, it, expect, vi, beforeEach } from "vitest";
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
  getTask,
  mockPr,
  ciRun,
} from "../helpers/task-reconciler-harness.js";

const { mockAttemptAutoRebase } = vi.hoisted(() => ({ mockAttemptAutoRebase: vi.fn() }));

vi.mock("../../src/services/task-auto-rebase.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  attemptAutoRebase: mockAttemptAutoRebase,
}));
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
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { MAX_REBASE_ATTEMPTS } = await import("../../src/services/task-auto-rebase.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockFetchRunsForHead,
  mockReseedTaskIfSessionExited,
  mockHermesUsable,
  mockDispatchTaskReview,
} = reconcilerMocks;

type App = Awaited<ReturnType<typeof buildApp>>;

const DIRTY = { mergeable: false, mergeableState: "dirty" };
const UNKNOWN = { mergeable: null, mergeableState: "unknown" };

async function createReviewingTask(
  app: App,
  agent: "codex" | "hermes",
  opts: { autoApprove?: boolean; task?: Partial<typeof tasks.$inferInsert> } = {},
): Promise<number> {
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name: `p-${agent}`, cwd: "/tmp" },
  });
  const projectId = project.json().id as number;
  app.db
    .update(projects)
    .set({ defaultReviewAgent: agent, autoApprove: opts.autoApprove ?? true })
    .where(eq(projects.id, projectId))
    .run();
  const [row] = app.db
    .insert(tasks)
    .values({
      projectId,
      title: "conflicting",
      body: "some spec",
      status: "reviewing",
      reviewingAt: new Date(),
      prNumber: 9,
      worktreePath: "/tmp",
      agentCommand: "codex",
      autoReturnRounds: 3,
      ...opts.task,
    })
    .returning()
    .all();
  return row.id;
}

describe.each([
  {
    agent: "codex" as const,
    dispatched: async (app: App, taskId: number) =>
      (await getTask(app, taskId)).reviewSessionId !== null,
  },
  {
    agent: "hermes" as const,
    dispatched: async () => mockDispatchTaskReview.mock.calls.length > 0,
  },
])("reconcileTasks — conflicting PR before review dispatch ($agent)", ({ agent, dispatched }) => {
  setupReconcilerTestLifecycle(`task-reconciler-review-conflict-${agent}`);

  beforeEach(() => {
    mockAttemptAutoRebase.mockReset().mockResolvedValue("spawned");
    mockHermesUsable.mockReset().mockReturnValue(true);
    mockDispatchTaskReview.mockReset().mockResolvedValue({
      runId: "run_1",
      status: "queued",
      replayed: false,
      idempotencyKey: "k",
      sessionId: "s",
    });
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
    mockGetPullRequestByNumber.mockResolvedValue(mockPr());
    mockReseedTaskIfSessionExited.mockReset().mockResolvedValue(true);
  });

  it("dispatches as before when the PR is mergeable", async () => {
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent);

    await reconcileTasks(app);

    expect(await dispatched(app, taskId)).toBe(true);
    expect(mockAttemptAutoRebase).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not dispatch a review for a dirty PR; it hands the task to auto-rebase", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(DIRTY));
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent);

    await reconcileTasks(app);

    expect(await dispatched(app, taskId)).toBe(false);
    expect(mockAttemptAutoRebase).toHaveBeenCalledTimes(1);
    expect(mockAttemptAutoRebase.mock.calls[0][3]).toBe("main");
    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.reviewSpawnClaimedAt).toBeNull();
    expect(mockReseedTaskIfSessionExited).not.toHaveBeenCalled();
    await app.close();
  });

  it("dirty past the CI wait deadline still gets no review", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(DIRTY));
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, {
      task: { reviewingAt: new Date(Date.now() - 60 * 60_000) },
    });

    await reconcileTasks(app);

    expect(await dispatched(app, taskId)).toBe(false);
    expect(mockAttemptAutoRebase).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("leaves a task whose rebase worker is still running alone", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(DIRTY));
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, {
      task: { rebaseStartedAt: new Date(), rebaseAttempts: 1 },
    });

    await reconcileTasks(app);

    expect(await dispatched(app, taskId)).toBe(false);
    expect(mockAttemptAutoRebase).not.toHaveBeenCalled();
    expect(mockReseedTaskIfSessionExited).not.toHaveBeenCalled();
    await app.close();
  });

  it("sends the task back to its worker once auto-rebase has given up, spending no round", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(DIRTY));
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, {
      task: { rebaseAttempts: MAX_REBASE_ATTEMPTS, inconclusiveReviewRearmCount: 1 },
    });

    await reconcileTasks(app);

    expect(await dispatched(app, taskId)).toBe(false);
    expect(mockAttemptAutoRebase).not.toHaveBeenCalled();
    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.lastAutoReturnReason).toBe("conflict");
    expect(row.autoReturnRounds).toBe(3);
    expect(row.inconclusiveReviewRearmCount).toBe(1);
    expect(row.approvalCarriedAt).toBeNull();
    expect(mockReseedTaskIfSessionExited).toHaveBeenCalledTimes(1);
    const prompt = mockReseedTaskIfSessionExited.mock.calls[0][3] as string;
    expect(prompt).toContain("conflicts with main");
    expect(prompt).toContain("git merge");
    expect(prompt).toContain("origin/main");
    await app.close();
  });

  it("sends the task back to its worker when auto-rebase declines before reaching the cap", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(DIRTY));
    mockAttemptAutoRebase.mockResolvedValue("declined");
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, { task: { rebaseAttempts: 0 } });

    await reconcileTasks(app);

    expect(await dispatched(app, taskId)).toBe(false);
    expect(mockAttemptAutoRebase).toHaveBeenCalledTimes(1);
    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.lastAutoReturnReason).toBe("conflict");
    expect(row.autoReturnRounds).toBe(3);
    const prompt = mockReseedTaskIfSessionExited.mock.calls[0][3] as string;
    expect(prompt).toContain("git merge");
    expect(prompt).toContain("origin/main");
    await app.close();
  });

  it("leaves the task reviewing while a rebase is waiting", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(DIRTY));
    mockAttemptAutoRebase.mockResolvedValue("waiting");
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, { task: { rebaseAttempts: 0 } });

    await reconcileTasks(app);

    expect(await dispatched(app, taskId)).toBe(false);
    expect(mockReseedTaskIfSessionExited).not.toHaveBeenCalled();
    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.lastAutoReturnReason).toBeNull();
    await app.close();
  });

  it("parks a task whose blocking session cannot be stopped, once", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(DIRTY));
    mockAttemptAutoRebase.mockResolvedValue("blocked");
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, { task: { rebaseAttempts: 0 } });

    await reconcileTasks(app);
    await reconcileTasks(app);

    expect(mockAttemptAutoRebase).toHaveBeenCalledTimes(1);
    expect(mockReseedTaskIfSessionExited).not.toHaveBeenCalled();
    expect(await dispatched(app, taskId)).toBe(false);
    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.needsHumanReason).toBe("rebase-exhausted");
    await app.close();
  });

  it("parks the task after one failed return instead of retrying every tick", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(DIRTY));
    mockAttemptAutoRebase.mockResolvedValue("declined");
    mockReseedTaskIfSessionExited.mockResolvedValue(false);
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, { task: { rebaseAttempts: 0 } });

    await reconcileTasks(app);
    await reconcileTasks(app);

    expect(mockReseedTaskIfSessionExited).toHaveBeenCalledTimes(1);
    expect(mockAttemptAutoRebase).toHaveBeenCalledTimes(1);
    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.needsHumanReason).toBe("rebase-exhausted");
    await app.close();
  });

  it("sends the task back directly when the project has auto-rebase off", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(DIRTY));
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, { autoApprove: false });

    await reconcileTasks(app);

    expect(mockAttemptAutoRebase).not.toHaveBeenCalled();
    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.autoReturnRounds).toBe(3);
    expect(mockReseedTaskIfSessionExited.mock.calls[0][3]).toContain("Automatic rebase is off");
    await app.close();
  });

  it("parks a task for a human when its worker was already sent back for a conflict", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(DIRTY));
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, {
      task: { rebaseAttempts: MAX_REBASE_ATTEMPTS, lastAutoReturnReason: "conflict" },
    });

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.needsHumanReason).toBe("rebase-exhausted");
    expect(row.mergeError).toContain("already sent back once");
    expect(mockReseedTaskIfSessionExited).not.toHaveBeenCalled();
    expect(await dispatched(app, taskId)).toBe(false);
    await app.close();
  });

  it("waits while GitHub is still computing mergeability, even with CI finished", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(UNKNOWN));
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent);

    await reconcileTasks(app);

    expect(await dispatched(app, taskId)).toBe(false);
    expect(mockAttemptAutoRebase).not.toHaveBeenCalled();
    expect((await getTask(app, taskId)).status).toBe("reviewing");
    await app.close();
  });

  it("dispatches as before once an unknown mergeable state outlasts the wait deadline", async () => {
    mockGetPullRequestByNumber.mockResolvedValue(mockPr(UNKNOWN));
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, {
      task: { reviewingAt: new Date(Date.now() - 16 * 60_000) },
    });

    await reconcileTasks(app);

    expect(await dispatched(app, taskId)).toBe(true);
    expect(mockAttemptAutoRebase).not.toHaveBeenCalled();
    await app.close();
  });

  it("clears the conflict note the rebase flow left once the PR is mergeable again", async () => {
    const app = await buildApp();
    const taskId = await createReviewingTask(app, agent, {
      task: { mergeError: "Conflicts with main — an auto-rebase attempt is in progress" },
    });

    await reconcileTasks(app);

    expect(await dispatched(app, taskId)).toBe(true);
    expect((await getTask(app, taskId)).mergeError).toBeNull();
    await app.close();
  });
});
