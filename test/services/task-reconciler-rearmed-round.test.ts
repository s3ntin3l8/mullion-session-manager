// #2752 — a re-armed inconclusive review is numbered distinctly in the stored
// `review_findings`. The reconciler's own test file is at its size ceiling, so
// the ingest → re-arm → ingest check lives here with a small harness: the
// Hermes poll is the only edge faked.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const { mockHermesUsable, mockDispatchTaskReview, mockPollTaskReview, mockStopHermesRun } =
  vi.hoisted(() => ({
    mockHermesUsable: vi.fn().mockReturnValue(true),
    mockDispatchTaskReview: vi.fn(),
    mockPollTaskReview: vi.fn(),
    mockStopHermesRun: vi.fn(),
  }));
vi.mock("../../src/services/hermes-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hermesTaskReviewerUsable: mockHermesUsable,
}));
vi.mock("../../src/services/hermes-task-review.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchTaskReview: mockDispatchTaskReview,
  pollTaskReview: mockPollTaskReview,
  stopHermesRunQuietly: mockStopHermesRun,
}));

const { mockResolveRepoRef, mockResolveGitHubToken, mockGetPullRequestByNumber, mockFetchRuns } =
  vi.hoisted(() => ({
    mockResolveRepoRef: vi.fn(),
    mockResolveGitHubToken: vi.fn(),
    mockGetPullRequestByNumber: vi.fn(),
    mockFetchRuns: vi.fn(),
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
  // The PR review post is the network edge this test must not reach.
  createPullRequestReview: vi.fn().mockResolvedValue({ id: 1 }),
}));
vi.mock("../../src/services/github.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRunsForHead: mockFetchRuns,
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
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { projects, tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-rearmed-round-${process.pid}.db`);

describe("re-armed review round heading (#2752)", () => {
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
    mockPollTaskReview.mockReset();
    mockResolveRepoRef.mockReset().mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockReset().mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockReset().mockResolvedValue({
      number: 9,
      htmlUrl: "https://x/pull/9",
      nodeId: "n",
      draft: true,
      headSha: "sha1",
    });
    mockFetchRuns.mockReset().mockResolvedValue([]);
  });

  it("stores two different headings for an inconclusive review and its re-armed retry", async () => {
    const app = await buildApp();
    mockPollTaskReview.mockResolvedValue({ status: "error", terminal: true, gone: false });
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-rearm", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;
    app.db
      .update(projects)
      .set({ defaultReviewAgent: "hermes" })
      .where(eq(projects.id, projectId))
      .run();
    const make = (overrides: Partial<typeof tasks.$inferInsert>) =>
      app.db
        .insert(tasks)
        .values({
          projectId,
          title: "hermes reviewed",
          body: "some spec",
          status: "reviewing",
          reviewingAt: new Date(),
          prNumber: 9,
          worktreePath: "/tmp",
          agentCommand: "codex",
          reviewRunId: "run_1",
          reviewRunDispatchedAt: new Date(),
          reviewRunHeadSha: "sha1",
          ...overrides,
        })
        .returning()
        .get().id;
    const first = make({});
    const retry = make({
      reviewRunId: "run_2",
      lastReviewVerdict: "inconclusive",
      inconclusiveReviewRearmCount: 1,
      reviewFindings: "## Round 1\n\nfirst attempt",
    });

    await reconcileTasks(app);

    const get = (id: number) => app.db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(get(first)?.reviewFindings).toMatch(/^## Round 1\n\n/);
    const stored = get(retry)?.reviewFindings ?? "";
    expect(stored).toContain("## Round 1\n\nfirst attempt");
    expect(stored).toContain("## Round 1 (retry 2)");
  });
});
