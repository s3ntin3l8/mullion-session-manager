// #2750 — a merge that only a human can unblock is flagged with
// `tasks.needsHumanReason` (`rebase-exhausted` / `blocked-threads`), and the
// flag goes away with its cause. Small harness on purpose: the reconciler's
// own test file is at its file-size ceiling.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockResolveMullionReviewLogins,
  mockGetPullRequestByNumber,
  mockMergePullRequest,
  mockFetchPullRequestReviewThreads,
  mockGetPullRequestReviewDecision,
} = vi.hoisted(() => ({
  mockResolveRepoRef: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockResolveMullionReviewLogins: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockMergePullRequest: vi.fn(),
  mockFetchPullRequestReviewThreads: vi.fn(),
  mockGetPullRequestReviewDecision: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRepoRef: mockResolveRepoRef,
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
  resolveMullionReviewLogins: mockResolveMullionReviewLogins,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mockGetPullRequestByNumber,
  mergePullRequest: mockMergePullRequest,
  fetchPullRequestReviewThreads: mockFetchPullRequestReviewThreads,
  getPullRequestReviewDecision: mockGetPullRequestReviewDecision,
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
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { markTaskMerged } = await import("../../src/services/task-merged.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-merge-human-${process.pid}.db`);

function mockPr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 9,
    state: "open",
    title: "chore: something",
    baseRef: "main",
    headRef: "mullion/task-x",
    headSha: "sha-head",
    mergeable: true,
    mergeableState: "clean",
    merged: false,
    mergedAt: null,
    ...overrides,
  };
}

function thread(id: string, author: string, isResolved: boolean) {
  return {
    id,
    isResolved,
    comments: [{ author, createdAt: "2026-08-20T10:00:00Z", path: "a.ts", line: 1, body: "x" }],
  };
}

describe("#2750 — merges that need a human", () => {
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
    mockResolveRepoRef.mockReset().mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockReset().mockResolvedValue("tok");
    mockResolveMullionReviewLogins.mockReset().mockResolvedValue(new Set(["mullion-bot"]));
    mockGetPullRequestByNumber.mockReset();
    mockMergePullRequest.mockReset().mockResolvedValue(undefined);
    mockFetchPullRequestReviewThreads.mockReset();
    mockGetPullRequestReviewDecision.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      getDb().delete(tasks).run();
    } catch {
      // No DB yet (the very first beforeEach runs before any buildApp()).
    }
  });

  /** A "done" task with a PR and a pending merge. */
  async function createTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    overrides: Partial<typeof tasks.$inferInsert> = {},
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: `p-${Math.random()}`, cwd: "/tmp" },
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
        title: "merge-pending",
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
    return row.id;
  }

  const getTask = (app: Awaited<ReturnType<typeof buildApp>>, id: number) =>
    app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  it("flags rebase-exhausted when the rebase budget is spent and the PR still conflicts", async () => {
    const app = await buildApp();
    const id = await createTask(app, { rebaseAttempts: 2 });
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

    await reconcileTasks(app);

    const row = getTask(app, id);
    expect(row.mergeError).toContain("gave up after 2 attempt(s)");
    expect(row.needsHumanReason).toBe("rebase-exhausted");
    await app.close();
  });

  it("does not flag a conflict while the rebase budget is not spent", async () => {
    const app = await buildApp();
    // No agent command: the rebase cannot spawn, so only an error is recorded.
    const id = await createTask(app, { rebaseAttempts: 0, agentCommand: null });
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

    await reconcileTasks(app);

    expect(getTask(app, id).needsHumanReason).toBeNull();
    await app.close();
  });

  it("clears rebase-exhausted when the error changes to a different cause", async () => {
    const app = await buildApp();
    const id = await createTask(app, {
      rebaseAttempts: 2,
      mergeError: "Conflicts with main — auto-rebase gave up after 2 attempt(s)",
      needsHumanReason: "rebase-exhausted",
    });
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
    mockFetchPullRequestReviewThreads.mockResolvedValue({
      viewerLogin: "mullion-bot",
      threads: [],
      truncated: false,
    });

    await reconcileTasks(app);

    const row = getTask(app, id);
    expect(row.mergeError).not.toContain("gave up");
    expect(row.needsHumanReason).toBeNull();
    await app.close();
  });

  it("flags blocked-threads when a thread Mullion did not open blocks the merge", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
    mockFetchPullRequestReviewThreads.mockResolvedValue({
      viewerLogin: "mullion-bot",
      threads: [thread("codeql", "github-advanced-security", false)],
      truncated: false,
    });

    await reconcileTasks(app);

    const row = getTask(app, id);
    expect(row.mergeError).toBe("Blocked on 1 unresolved review conversation");
    expect(row.needsHumanReason).toBe("blocked-threads");
    await app.close();
  });

  it("does not flag blocked-threads for Mullion's own unresolved thread", async () => {
    const app = await buildApp();
    const id = await createTask(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
    mockFetchPullRequestReviewThreads.mockResolvedValue({
      viewerLogin: "mullion-bot",
      threads: [thread("own", "mullion-bot", false)],
      truncated: false,
    });

    await reconcileTasks(app);

    const row = getTask(app, id);
    expect(row.mergeError).toBe("Blocked on 1 unresolved review conversation");
    expect(row.needsHumanReason).toBeNull();
    await app.close();
  });

  it("keeps a review-loop reason that is already parked on the task", async () => {
    const app = await buildApp();
    const id = await createTask(app, {
      needsHumanReason: "cap",
      autoReturnCapAnnouncedAt: new Date(),
    });
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
    mockFetchPullRequestReviewThreads.mockResolvedValue({
      viewerLogin: "mullion-bot",
      threads: [thread("codeql", "github-advanced-security", false)],
      truncated: false,
    });

    await reconcileTasks(app);

    expect(getTask(app, id).needsHumanReason).toBe("cap");
    await app.close();
  });

  it("clears blocked-threads once the threads are resolved", async () => {
    const app = await buildApp();
    const id = await createTask(app, {
      mergeError: "Blocked on 1 unresolved review conversation",
      needsHumanReason: "blocked-threads",
    });
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
    mockFetchPullRequestReviewThreads.mockResolvedValue({
      viewerLogin: "mullion-bot",
      threads: [thread("codeql", "github-advanced-security", true)],
      truncated: false,
    });

    await reconcileTasks(app);

    const row = getTask(app, id);
    expect(row.mergeError).not.toMatch(/unresolved review conversation/);
    expect(row.needsHumanReason).toBeNull();
    await app.close();
  });

  it("clears a merge reason when the task merges", async () => {
    const app = await buildApp();
    const id = await createTask(app, { needsHumanReason: "blocked-threads" });
    const task = getTask(app, id);
    const project = app.db.select().from(projects).where(eq(projects.id, task.projectId)).get()!;

    expect(markTaskMerged(app, task, project)).toBe(true);

    expect(getTask(app, id).needsHumanReason).toBeNull();
    await app.close();
  });
});
