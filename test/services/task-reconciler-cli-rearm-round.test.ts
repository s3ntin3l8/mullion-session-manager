// #2752/#2776 — a CLI reviewer's inconclusive ingest, the grace sweep's re-arm and the
// next ingest store distinct `## Round` headings. Its own file: the reconciler's
// test file is at its size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { repoRefMocks } from "../helpers/pr-review-defaults.js";

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockCreatePullRequestReview,
} = vi.hoisted(() => ({
  mockResolveRepoRef: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockCreatePullRequestReview: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...repoRefMocks(mockResolveRepoRef),
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
  resolveReviewerToken: vi.fn().mockResolvedValue(null),
  resolveMullionReviewLogins: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mockGetPullRequestByNumber,
  createPullRequestReview: mockCreatePullRequestReview,
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
const { reannounceInconclusiveReviewsAfterGrace } =
  await import("../../src/services/task-late-findings.js");
const { taskReviewFindingsPath } = await import("../../src/services/task-prompt.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-cli-rearm-round-${process.pid}.db`);

function finishedInfo() {
  return {
    activity: "idle",
    attention: false,
    attentionKind: null,
    permissionState: "idle",
    planState: "idle",
    gateState: "idle",
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    elicitationState: "idle",
    elicitationServer: null,
    questionState: "idle",
    questionHeader: null,
    errorState: "idle",
    errorDetail: null,
    endedReason: null,
    exitCode: null,
    compactState: "idle",
    subagentCount: 0,
    lastTurnEndedAt: Date.now(),
    workFinishedAt: Date.now(),
    outstandingBackgroundTasks: [],
  };
}

describe("CLI reviewer re-armed round heading", () => {
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
    mockCreatePullRequestReview.mockReset();
    mockCreatePullRequestReview.mockResolvedValue({ id: 1, htmlUrl: "https://x/pr/9#r1" });
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      nodeId: "PR_node9",
      draft: false,
      headSha: "sha-head",
    });
  });

  it("stores distinct headings across inconclusive ingest, sweep re-arm and the next ingest", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-cli-rearm", cwd: "/tmp" },
    });
    const mk = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId: project.json().id, command: "bash" },
        })
      ).json().id as number;
    const workerId = await mk();
    const firstReviewer = await mk();
    const secondReviewer = await mk();
    const task = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "cli reviewer, re-armed",
        status: "reviewing",
        sessionId: workerId,
        reviewSessionId: firstReviewer,
        worktreePath: "/tmp",
        agentCommand: "claude",
        prNumber: 9,
        claimedAt: new Date(),
      })
      .returning()
      .get();
    vi.spyOn(app.pty, "get").mockImplementation(() => ({ toInfo: () => finishedInfo() }) as never);
    const get = () => app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    const headings = () =>
      (get().reviewFindings ?? "").split("\n").filter((l) => l.startsWith("## Round "));

    app.db
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - 3 * 60 * 60_000) })
      .where(eq(sessions.id, firstReviewer))
      .run();
    // 1. The reviewer exits without a findings file: inconclusive ingest.
    await reconcileTasks(app);
    expect(get().lastReviewVerdict).toBe("inconclusive");
    expect(headings()).toEqual(["## Round 1"]);

    // 2. The grace window passes and the sweep re-arms.
    app.db
      .update(tasks)
      .set({ lastReviewVerdictAt: new Date(Date.now() - 2 * 60 * 60_000) })
      .where(eq(tasks.id, task.id))
      .run();
    await reannounceInconclusiveReviewsAfterGrace(app);
    expect(get().inconclusiveReviewRearmCount).toBe(1);
    expect(get().reviewSessionId).toBeNull();

    // 3. A fresh reviewer answers: the second ingest gets a distinct heading.
    app.db
      .update(tasks)
      .set({ reviewSessionId: secondReviewer })
      .where(eq(tasks.id, task.id))
      .run();
    fs.writeFileSync(
      taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), task.id, 0),
      JSON.stringify({ verdict: "approved", summary: "Second attempt." }),
    );
    await reconcileTasks(app);
    expect(get().lastReviewVerdict).toBe("approved");
    expect(headings()).toEqual(["## Round 1", "## Round 1 (retry 2)"]);
    await app.close();
  });
});
