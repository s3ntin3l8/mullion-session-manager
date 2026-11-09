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
  mockParse,
} = vi.hoisted(() => ({
  mockReadFindings: vi.fn(),
  mockParse: vi.fn(),
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
// Counts findings parses while delegating to the real parser.
vi.mock("../../src/services/task-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const parse = actual.parseReviewFindings as (text: string) => unknown;
  return {
    ...actual,
    parseReviewFindings: (text: string) => {
      mockParse(text);
      return parse(text);
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
const { ingestLateFindings } = await import("../../src/services/task-late-findings.js");
const { pruneLateFindingsCaches, lastLateReadKey } =
  await import("../../src/services/task-late-findings-cache.js");
const { taskReviewFindingsPath } = await import("../../src/services/task-prompt.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-late-findings-${process.pid}.db`);

// Fixed: the read-dedupe key includes the turn end, so a clock-derived value
// would make whether two reads share a key depend on the millisecond.
const TURN_ENDED_AT = Date.now();

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
    lastTurnEndedAt: TURN_ENDED_AT,
    workFinishedAt: TURN_ENDED_AT,
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
    mockParse.mockReset();
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

  it("leaves the verdict inconclusive for an unstructured late file and posts nothing", async () => {
    const { app, task } = await setup();
    writeFindings(app, task.id, "Looks fine to me, no blocking issues.");

    await reconcileTasks(app);
    await reconcileTasks(app);

    const row = getTask(app, task.id);
    expect(row.lastReviewVerdict).toBe("inconclusive");
    expect(row.autoReturnRounds).toBe(task.autoReturnRounds);
    expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
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

  // The `ignoredUnstructured` early return: `lastLateReadKey` already stops a
  // re-read within one turn, so the content hash only matters when the same
  // freeform text is written again in a NEW turn (a moved `lastTurnEndedAt`).
  it("does not re-parse the same freeform text rewritten in a new turn, but parses a changed one", async () => {
    const info = { lastTurnEndedAt: Date.now() };
    const { app, task } = await setup({ info });
    // Unique text: earlier tests leave their tasks in the shared DB and the pty spy answers for every session, so their files would otherwise add to the parse count.
    const FREEFORM = "Reads fine overall; nothing blocking in this one.";
    const parsesOf = (text: string) => mockParse.mock.calls.filter((c) => c[0] === text).length;

    writeFindings(app, task.id, FREEFORM);
    await reconcileTasks(app);
    expect(readsFor(task.id)).toBe(1);
    expect(parsesOf(FREEFORM)).toBe(1);

    // A new turn: the reviewer rewrites the very same text.
    info.lastTurnEndedAt += 1_000;
    writeFindings(app, task.id, FREEFORM);
    await reconcileTasks(app);
    expect(readsFor(task.id)).toBe(2); // read again (new turn)...
    expect(parsesOf(FREEFORM)).toBe(1); // ...but not re-parsed
    expect(getTask(app, task.id).lastReviewVerdict).toBe("inconclusive");
    expect(mockCreatePullRequestReview).not.toHaveBeenCalled();

    // Different freeform text is looked at afresh.
    const OTHER = "Actually, still no blocking issues.";
    info.lastTurnEndedAt += 1_000;
    writeFindings(app, task.id, OTHER);
    await reconcileTasks(app);
    expect(parsesOf(OTHER)).toBe(1);
    expect(getTask(app, task.id).lastReviewVerdict).toBe("inconclusive");
    await app.close();
  });

  // Unreachable through `reconcileTasks` (it passes the task's own review
  // session), so the guard is pinned on `ingestLateFindings` directly.
  it("ignores a session that is not the task's current review session", async () => {
    const { app, task } = await setup();
    const other = app.db.select().from(sessions).where(eq(sessions.id, task.sessionId!)).get()!;
    expect(other.id).not.toBe(task.reviewSessionId);
    const readTaskReviewFindings = vi.fn().mockResolvedValue(APPROVED);
    const ingest = vi.fn();
    await ingestLateFindings(app, {
      task,
      session: other,
      info: finishedInfo() as never,
      backend: { readTaskReviewFindings } as never,
      ingest,
    });
    expect(readTaskReviewFindings).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });
  it("retries the same file on the next tick when ingest threw", async () => {
    const { app, task } = await setup();
    const session = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, task.reviewSessionId!))
      .get()!;
    const readTaskReviewFindings = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ verdict: "approved", summary: "ok" }));
    const ingest = vi
      .fn()
      .mockRejectedValueOnce(new Error("post failed"))
      .mockResolvedValue(undefined);
    const info = finishedInfo() as never;
    const run = () =>
      ingestLateFindings(app, {
        task,
        session,
        info,
        backend: { readTaskReviewFindings } as never,
        ingest,
      });
    await run(); // the throw is contained
    await run();
    expect(ingest).toHaveBeenCalledTimes(2);
    await run(); // recorded after the success: no third read
    expect(ingest).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("contains a persistently throwing ingest: bounded attempts, other tasks unaffected", async () => {
    const { app, task: a } = await setup({ task: { prNumber: 9 } });
    const projectB = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "p-late-b", cwd: "/tmp" },
      })
    ).json().id as number;
    const reviewB = (
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: projectB, command: "bash" },
      })
    ).json().id as number;
    const b = app.db
      .insert(tasks)
      .values({
        ...a,
        id: undefined,
        title: "task B",
        projectId: projectB,
        sessionId: a.sessionId,
        reviewSessionId: reviewB,
        reviewFindingsIngestedSessionId: reviewB,
        prNumber: 10,
      })
      .returning()
      .get();
    writeFindings(app, a.id, APPROVED);
    writeFindings(app, b.id, JSON.stringify({ verdict: "approved", summary: "B OK." }));
    // Resolving task A's repo ref throws on every attempt; B's works.
    mockResolveRepoRef.mockImplementation(async (_app: unknown, project: { name: string }) => {
      if (project.name === "p-late") throw new Error("persistent failure");
      return { owner: "o", repo: "r" };
    });
    const errors = vi.spyOn(app.log, "error");

    for (let i = 0; i < 6; i++) await expect(reconcileTasks(app)).resolves.not.toThrow();

    expect(getTask(app, b.id).lastReviewVerdict).toBe("approved");
    expect(getTask(app, b.id).reviewFindings).toContain("B OK.");
    expect(getTask(app, a.id).lastReviewVerdict).toBe("inconclusive");
    // Bounded: the file is read MAX attempts times, not once per tick.
    expect(readsFor(a.id)).toBe(3);
    const aErrors = errors.mock.calls.filter((c) => (c[0] as { taskId?: number })?.taskId === a.id);
    expect(aErrors.length).toBeLessThanOrEqual(2);
    await app.close();
  });

  it("the sweep prunes a task's read caches when it leaves reviewing", async () => {
    const { app, task } = await setup({ sessionStatus: "exited" });
    await reconcileTasks(app);
    expect(lastLateReadKey.has(task.id)).toBe(true);
    app.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id)).run();
    await reconcileTasks(app);
    expect(lastLateReadKey.has(task.id)).toBe(false);
    await app.close();
  });

  it("prunes the read caches once the task is no longer latched inconclusive", async () => {
    const { app, task } = await setup();
    const session = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, task.reviewSessionId!))
      .get()!;
    const readTaskReviewFindings = vi.fn().mockResolvedValue(null);
    const info = finishedInfo() as never;
    const run = () =>
      ingestLateFindings(app, {
        task,
        session,
        info,
        backend: { readTaskReviewFindings } as never,
        ingest: vi.fn(),
      });
    await run();
    await run();
    expect(readTaskReviewFindings).toHaveBeenCalledTimes(1);
    pruneLateFindingsCaches(new Set([task.id]));
    await run();
    expect(readTaskReviewFindings).toHaveBeenCalledTimes(1);
    pruneLateFindingsCaches(new Set());
    await run();
    expect(readTaskReviewFindings).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
