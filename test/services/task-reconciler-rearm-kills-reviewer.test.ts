// #2804 — re-arming a capped task after a human push unlinks the parked round's
// review session (`reviewSessionId: null`); that reviewer is an idle TUI that stays
// alive until something ends it, so the re-arm must end it too, but only once its
// own compare-and-set won. Its own file: the reconciler's test file is at its
// file-size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PR_REVIEW_DEFAULTS, repoRefMocks } from "../helpers/pr-review-defaults.js";

const { mockResolveRepoRef, mockResolveGitHubToken, mockGetPullRequestByNumber } = vi.hoisted(
  () => ({
    mockResolveRepoRef: vi.fn(),
    mockResolveGitHubToken: vi.fn(),
    mockGetPullRequestByNumber: vi.fn(),
  }),
);

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
const { setRepoPRsStatus, invalidatePRsCache } = await import("../../src/services/github.js");
const { DEFAULT_MAX_AUTO_RETURN_ROUNDS } =
  await import("../../src/services/task-auto-return-rounds.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-rearm-kills-reviewer-${process.pid}.db`);

function prStatus(headSha: string) {
  return {
    prs: [
      {
        number: 9,
        title: "test pr",
        htmlUrl: "https://github.com/o/r/pull/9",
        author: "dev",
        ...PR_REVIEW_DEFAULTS,
        headSha,
        headBranch: "feature",
        baseBranch: "main",
        ciStatus: null,
        actionsRuns: [],
      },
    ],
    prSummary: { total: 1, pass: 0, fail: 0, pending: 0, unknown: 1 },
  };
}

describe("capped-task re-arm ends the parked review session (#2804)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  beforeEach(() => {
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
  });

  afterEach(() => {
    invalidatePRsCache("o", "r");
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  async function setupCapped() {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: `p-rearm-${Math.random()}`,
        cwd: "/tmp",
      },
    });
    const projectId = created.json().id as number;
    const addSession = () =>
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: "/tmp", status: "active" })
        .returning()
        .get();
    const worker = addSession();
    const review = addSession();
    const task = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "capped and announced, awaiting a human",
        status: "reviewing",
        sessionId: worker.id,
        reviewSessionId: review.id,
        reviewFindingsIngestedSessionId: review.id,
        autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
        autoReturnCapAnnouncedAt: new Date(Date.now() - 60_000),
        lastReviewedHeadSha: "sha-old",
        reviewSpawnClaimedAt: new Date(),
        worktreePath: "/tmp",
        agentCommand: "claude",
        prNumber: 9,
        claimedAt: new Date(),
      })
      .returning()
      .get();
    const terminate = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
    const status = (id: number) =>
      app.db.select().from(sessions).where(eq(sessions.id, id)).get()!.status;
    return { app, task, worker, review, terminate, status };
  }

  it("ends the review session it unlinks, and leaves the worker alone", async () => {
    const { app, task, worker, review, terminate, status } = await setupCapped();
    setRepoPRsStatus("o", "r", prStatus("sha-new"));

    await reconcileTasks(app);

    const row = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(row.reviewSessionId).toBeNull();
    // killSession is fire-and-forget in the reconciler: wait for it to settle.
    await vi.waitFor(() => expect(status(review.id)).toBe("killed"));
    expect(terminate).toHaveBeenCalledWith(String(review.id));
    expect(status(worker.id)).toBe("active");
    await app.close();
  });

  it("leaves the review session alone while the PR head has not moved", async () => {
    const { app, task, review, terminate, status } = await setupCapped();
    setRepoPRsStatus("o", "r", prStatus("sha-old"));

    await reconcileTasks(app);

    const row = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(row.reviewSessionId).toBe(review.id);
    expect(terminate).not.toHaveBeenCalled();
    expect(status(review.id)).toBe("active");
    await app.close();
  });
});
