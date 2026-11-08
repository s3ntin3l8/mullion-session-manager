// A review ingested as `inconclusive` can still be answered later (a human
// re-prompts the reviewer after its quota recovers): the reconciler re-reads
// the findings file while that verdict stays latched. Its own file: the
// reconciler's test file is at its file-size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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
  mockReadFindings,
} = vi.hoisted(() => ({
  mockReadFindings: vi.fn(),
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
// Counts findings reads while delegating to the real backend.
vi.mock("../../src/services/session-backend.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const resolve = actual.resolveBackend as (...a: unknown[]) => Record<string, unknown>;
  return {
    ...actual,
    resolveBackend: (...args: unknown[]) => {
      const backend = resolve(...args);
      const read = (backend.readTaskReviewFindings as (...a: unknown[]) => unknown).bind(backend);
      return new Proxy(backend, {
        get: (t, k, r) =>
          k === "readTaskReviewFindings"
            ? (...a: unknown[]) => {
                mockReadFindings(...a);
                return read(...a);
              }
            : Reflect.get(t, k, r),
      });
    },
  };
});
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
const { taskReviewFindingsPath } = await import("../../src/services/task-prompt.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-late-findings-${process.pid}.db`);

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

describe("late review findings after an inconclusive ingest", () => {
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

  const openApps: Array<{ close: () => Promise<unknown> }> = [];
  afterEach(async () => {
    // A failed assertion must not leave the app (and its hook socket) open.
    for (const a of openApps.splice(0)) await a.close().catch(() => {});
  });

  beforeEach(() => {
    mockReadFindings.mockReset();
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

  async function setup(
    opts: {
      task?: Partial<typeof tasks.$inferInsert>;
      info?: Record<string, unknown>;
      sessionStatus?: "exited";
      turnEndedOffsetMs?: number; // lastTurnEndedAt relative to the verdict
    } = {},
  ) {
    const app = await buildApp();
    openApps.push(app);
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-late", cwd: "/tmp" },
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
    const reviewId = await mk();
    const verdictAt = new Date(Date.now() - 5 * 60_000);
    if (opts.sessionStatus) {
      app.db
        .update(sessions)
        .set({ status: opts.sessionStatus })
        .where(eq(sessions.id, reviewId))
        .run();
    }
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "inconclusive review, reviewer later answers",
        status: "reviewing",
        sessionId: workerId,
        reviewSessionId: reviewId,
        reviewFindingsIngestedSessionId: reviewId,
        lastReviewVerdict: "inconclusive",
        lastReviewVerdictAt: verdictAt,
        reviewFindings: "## Round 1\n\nReview agent ended without writing a findings file",
        worktreePath: "/tmp",
        agentCommand: "claude",
        prNumber: 9,
        claimedAt: new Date(),
        ...opts.task,
      })
      .returning()
      .all();
    vi.spyOn(app.pty, "get").mockImplementation(
      () =>
        ({
          toInfo: () => ({
            ...finishedInfo(),
            ...(opts.turnEndedOffsetMs !== undefined
              ? { lastTurnEndedAt: verdictAt.getTime() + opts.turnEndedOffsetMs }
              : {}),
            ...opts.info,
          }),
        }) as never,
    );
    return { app, task };
  }

  function writeFindings(app: Awaited<ReturnType<typeof buildApp>>, taskId: number, body: string) {
    fs.writeFileSync(taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), taskId, 0), body);
  }

  const getTask = (app: Awaited<ReturnType<typeof buildApp>>, id: number) =>
    app.db.select().from(tasks).where(eq(tasks.id, id)).all()[0];

  it("ingests a valid late file once and posts one PR review; a second tick adds nothing", async () => {
    const { app, task } = await setup();
    writeFindings(app, task.id, JSON.stringify({ verdict: "approved", summary: "Late OK." }));

    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.lastReviewVerdict).toBe("approved");
    expect(row.reviewFindings).toContain("Late OK.");
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);

    await reconcileTasks(app);
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
    expect(getTask(app, task.id).lastReviewVerdict).toBe("approved");
    await app.close();
  });

  it("ingests a freeform late file once, without spending an auto-return round", async () => {
    const { app, task } = await setup();
    writeFindings(app, task.id, "Looks fine to me, no blocking issues.");

    await reconcileTasks(app);
    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.lastReviewVerdict).toBe("changes-requested");
    expect(row.autoReturnRounds).toBe(task.autoReturnRounds);
    expect(row.reviewFindings).toContain("late verdict");
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("leaves the task unchanged when no file exists", async () => {
    const { app, task } = await setup();

    await reconcileTasks(app);

    expect(getTask(app, task.id).lastReviewVerdict).toBe("inconclusive");
    expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not apply once the review handle was cleared by a re-arm", async () => {
    const { app, task } = await setup();
    app.db
      .update(tasks)
      .set({ reviewSessionId: null, reviewFindingsIngestedSessionId: null })
      .where(eq(tasks.id, task.id))
      .run();
    writeFindings(app, task.id, JSON.stringify({ verdict: "approved", summary: "Late OK." }));

    await reconcileTasks(app);

    expect(getTask(app, task.id).lastReviewVerdict).toBe("inconclusive");
    expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
    await app.close();
  });

  // Tasks from earlier tests stay latched in the shared DB, so count per task.
  const readsFor = (taskId: number) =>
    mockReadFindings.mock.calls.filter((c) => c[0] === taskId).length;

  const APPROVED = JSON.stringify({ verdict: "approved", summary: "Late OK." });

  async function expectUntouched(opts: Parameters<typeof setup>[0]) {
    const { app, task } = await setup(opts);
    writeFindings(app, task.id, APPROVED);
    await reconcileTasks(app);
    const row = getTask(app, task.id);
    expect(row.lastReviewVerdict).toBe("inconclusive");
    expect(row.reviewFindings).toBe(task.reviewFindings);
    expect(readsFor(task.id)).toBe(0);
    await app.close();
  }

  it("skips a Hermes run (reviewRunId set)", async () => {
    await expectUntouched({ task: { reviewRunId: "run-1" } });
  });

  it("does not read while the reviewer is mid-turn", async () => {
    await expectUntouched({ info: { activity: "working", lastTurnEndedAt: null } });
  });

  it("does not read after a turn that ended well before the verdict", async () => {
    await expectUntouched({ turnEndedOffsetMs: -60_000 });
  });

  it("does not read after a turn that ended just outside the skew tolerance", async () => {
    await expectUntouched({ turnEndedOffsetMs: -6_000 });
  });

  it("still reads a turn end 3 s before the verdict (clock skew)", async () => {
    const { app, task } = await setup({ turnEndedOffsetMs: -3_000 });
    writeFindings(app, task.id, APPROVED);
    await reconcileTasks(app);
    expect(getTask(app, task.id).lastReviewVerdict).toBe("approved");
    await app.close();
  });

  it("reads an exited reviewer with no file once across two ticks", async () => {
    const { app, task } = await setup({ sessionStatus: "exited" });
    await reconcileTasks(app);
    await reconcileTasks(app);
    expect(readsFor(task.id)).toBe(1);
    expect(getTask(app, task.id).lastReviewVerdict).toBe("inconclusive");
    await app.close();
  });
});
