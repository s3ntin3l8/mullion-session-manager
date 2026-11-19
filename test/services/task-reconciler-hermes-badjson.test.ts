// A Hermes reply that is not valid JSON ends the round inconclusive; the
// re-armed round gets a fresh session and a correction line. Only the Hermes
// HTTP client is faked.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { repoRefMocks } from "../helpers/pr-review-defaults.js";

const { mockHermesUsable, mockPostRun, mockGetRun, mockStopHermesRun, mockCreatePrReview } =
  vi.hoisted(() => ({
    mockHermesUsable: vi.fn().mockReturnValue(true),
    mockPostRun: vi.fn(),
    mockGetRun: vi.fn(),
    mockStopHermesRun: vi.fn(),
    mockCreatePrReview: vi.fn(),
  }));
vi.mock("../../src/services/hermes-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hermesTaskReviewerUsable: mockHermesUsable,
}));
vi.mock("../../src/services/hermes-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHermesConfig: () => ({ root: "http://hermes.test" }),
  checkHealth: vi.fn().mockResolvedValue(undefined),
  postRun: mockPostRun,
  getRun: mockGetRun,
}));
vi.mock("../../src/services/hermes-task-review.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
  ...repoRefMocks(mockResolveRepoRef),
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mockGetPullRequestByNumber,
  // The PR review post is the network edge this test must not reach.
  createPullRequestReview: mockCreatePrReview,
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

const tmpDb = path.join(os.tmpdir(), `task-reconciler-hermes-badjson-${process.pid}.db`);

const BAD_REPLY =
  '{"verdict":"approved","notes":["probe against a batch answering branches: {"1": null} ok"],"findings":[]}';
const GOOD_REPLY = JSON.stringify({ verdict: "approved", summary: "fine", findings: [] });

describe("Hermes unparseable reply re-arm", () => {
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
    mockGetRun.mockReset();
    mockPostRun.mockReset();
    mockCreatePrReview.mockReset().mockResolvedValue({ id: 1 });
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

  async function setup(name: string) {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name, cwd: "/tmp" },
    });
    const projectId = project.json().id as number;
    app.db
      .update(projects)
      .set({ defaultReviewAgent: "hermes" })
      .where(eq(projects.id, projectId))
      .run();
    const id = app.db
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
      })
      .returning()
      .get().id;
    const age = () =>
      app.db
        .update(tasks)
        .set({ lastReviewVerdictAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(tasks.id, id))
        .run();
    const get = () => app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
    return { app, id, get, age };
  }

  it("re-arms with a fresh session and a correction line, then ingests a valid reply", async () => {
    const { app, id, get, age } = await setup("p-badjson");
    mockGetRun.mockResolvedValue({ runId: "run_1", status: "completed", output: BAD_REPLY });
    mockPostRun.mockResolvedValue({ runId: "run_2", replayed: false });

    await reconcileTasks(app); // poll -> inconclusive
    expect(get().lastReviewVerdict).toBe("inconclusive");
    expect(get().reviewFindings).toContain("not the findings JSON");

    age(); // past the re-arm grace window
    for (let i = 0; i < 10 && mockPostRun.mock.calls.length === 0; i++) {
      // The CI wait is measured from `reviewingAt`; let it lapse.
      app.db
        .update(tasks)
        .set({ reviewingAt: new Date(Date.now() - 3 * 60 * 60 * 1000) })
        .where(eq(tasks.id, id))
        .run();
      await reconcileTasks(app); // re-arm, then dispatch
    }
    expect(mockPostRun).toHaveBeenCalledTimes(1);
    const body = mockPostRun.mock.calls[0][1] as { sessionId: string; input: string };
    expect(body.sessionId).toMatch(/^mullion-task-\d+-r\d+-x1$/);
    expect(body.input).toContain("your previous reply was not valid JSON");
    expect(body.input).toMatch(/Expected|Unexpected|delimiter/);

    mockGetRun.mockResolvedValue({ runId: "run_2", status: "completed", output: GOOD_REPLY });
    await reconcileTasks(app);
    expect(get().lastReviewVerdict).toBe("approved");
    await app.close();
  });

  it("adds no correction line when the previous round timed out", async () => {
    const { app, id, get, age } = await setup("p-timeout");
    app.db
      .update(tasks)
      .set({ reviewRunDispatchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(tasks.id, id))
      .run();
    mockGetRun.mockResolvedValue({ runId: "run_1", status: "running", output: "" });
    mockPostRun.mockResolvedValue({ runId: "run_2", replayed: false });

    await reconcileTasks(app);
    expect(get().lastReviewVerdict).toBe("inconclusive");
    age(); // past the re-arm grace window
    for (let i = 0; i < 10 && mockPostRun.mock.calls.length === 0; i++) {
      app.db
        .update(tasks)
        .set({ reviewingAt: new Date(Date.now() - 3 * 60 * 60 * 1000) })
        .where(eq(tasks.id, id))
        .run();
      await reconcileTasks(app);
    }
    expect(mockPostRun).toHaveBeenCalledTimes(1);
    const body = mockPostRun.mock.calls[0][1] as { sessionId: string; input: string };
    expect(body.sessionId).toMatch(/-x1$/);
    expect(body.input).not.toContain("not valid JSON");
    await app.close();
  });
});
