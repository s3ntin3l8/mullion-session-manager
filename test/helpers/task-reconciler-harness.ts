/**
 * Shared mock factories, lifecycle hooks, and fixtures for task-reconciler tests.
 *
 * Import order constraint: `reconcilerMocks` is a plain module-level object
 * (not `vi.hoisted`), which works because this file has no runtime `src/`
 * imports (only `import type` and `./pr-review-defaults.js`). Suites must
 * import this harness before any `src/` module, and this file must not gain
 * runtime `src/` imports at module top level.
 */
import { vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { buildApp } from "../../src/app.js";
import { repoRefMocks } from "./pr-review-defaults.js";

export type TestApp = Awaited<ReturnType<typeof buildApp>>;

// Switch for fetchRunsForHeadChecked: true makes the Actions-runs lookup
// report ok:false (GitHub did not answer), the one state the real function
// returns that a mock fetchRunsForHead cannot express.
export const runsLookup = { failed: false };

export const reconcilerMocks = {
  mockNotifyTaskNeedsAttention: vi.fn(),
  mockHermesUsable: vi.fn().mockReturnValue(false),
  mockDispatchTaskReview: vi.fn(),
  mockPollTaskReview: vi.fn(),
  mockStopHermesRun: vi.fn(),
  mockOpenDraftPRForTask: vi.fn(),
  mockPromoteTaskToPR: vi.fn(),
  mockReseedTaskIfSessionExited: vi.fn(),
  mockResolveHostGitStatus: vi.fn(),
  mockCommitHostWipChanges: vi.fn(),
  mockResolveRepoRef: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockResolveReviewerToken: vi.fn(),
  mockResolveMullionReviewLogins: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockMergePullRequest: vi.fn(),
  mockUpdatePullRequestBranch: vi.fn(),
  mockDeleteRemoteBranch: vi.fn(),
  mockUpdatePullRequestTitle: vi.fn(),
  mockFetchRunsForHead: vi.fn(),
  mockFetchCheckRunsForHead: vi.fn().mockResolvedValue([]),
  mockCreatePullRequestReview: vi.fn().mockResolvedValue({
    id: 1,
    htmlUrl: "https://github.com/o/r/pull/9#pullrequestreview-1",
  }),
  mockGetPullRequestReviewDecision: vi.fn(),
  mockFindReleasePullRequest: vi.fn(),
  mockGetDefaultBranch: vi.fn(),
  mockInvalidateReleaseCache: vi.fn(),
  mockDetectReleaseWorkflow: vi.fn(),
  mockDetectReleasePleaseConfig: vi.fn(),
  mockResumeTaskWorktree: vi.fn(),
  mockRemoveWorktree: vi.fn(),
  mockFetchPullRequestReviewThreads: vi.fn(),
  mockResolveReviewThread: vi.fn(),
};

type ImportOriginal = () => Promise<Record<string, unknown>>;

export async function mockPushDeliveryFactory(importOriginal: ImportOriginal) {
  return {
    ...(await importOriginal()),
    notifyTaskNeedsAttention: reconcilerMocks.mockNotifyTaskNeedsAttention,
  };
}

export async function mockHermesIntegrationFactory(importOriginal: ImportOriginal) {
  return {
    ...(await importOriginal()),
    hermesTaskReviewerUsable: reconcilerMocks.mockHermesUsable,
  };
}

export async function mockHermesTaskReviewFactory(importOriginal: ImportOriginal) {
  return {
    ...(await importOriginal()),
    dispatchTaskReview: reconcilerMocks.mockDispatchTaskReview,
    pollTaskReview: reconcilerMocks.mockPollTaskReview,
    stopHermesRunQuietly: reconcilerMocks.mockStopHermesRun,
  };
}

export function mockNodePtyFactory() {
  return {
    spawn: vi.fn(() => ({
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    })),
  };
}

export async function mockChildProcessFactory(importOriginal: ImportOriginal) {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        // Issue #1140 — terminate()'s stopScope() issues a list-units
        // ownership-check spawn FIRST, which (like isMasterAliveBatch)
        // deliberately waits on 'close', not 'exit' — the stdout-delivery
        // race their own doc comments describe. A mock that only emits
        // 'exit' hangs that listing call for the whole test timeout. See
        // test/helpers/mock-spawn.ts for the full reasoning.
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
}

// Pass-through implementations captured when each mocked module is first
// imported, so beforeEach/afterEach can restore them after a test overrides
// one with .mockResolvedValue() or .mockImplementation().
const passThroughImpls: {
  promoteTaskToPR?: (...args: unknown[]) => unknown;
  reseedTaskIfSessionExited?: (...args: unknown[]) => unknown;
  resolveRepoRef?: (...args: unknown[]) => unknown;
  resolveGitHubToken?: (...args: unknown[]) => unknown;
  getPullRequestByNumber?: (...args: unknown[]) => unknown;
  fetchRunsForHead?: (...args: unknown[]) => unknown;
  detectReleasePleaseConfig?: (...args: unknown[]) => unknown;
} = {};

export function restorePassThroughMocks(): void {
  if (passThroughImpls.promoteTaskToPR) {
    reconcilerMocks.mockPromoteTaskToPR.mockImplementation(passThroughImpls.promoteTaskToPR);
  }
  if (passThroughImpls.reseedTaskIfSessionExited) {
    reconcilerMocks.mockReseedTaskIfSessionExited.mockImplementation(
      passThroughImpls.reseedTaskIfSessionExited,
    );
  }
  if (passThroughImpls.resolveRepoRef) {
    reconcilerMocks.mockResolveRepoRef.mockImplementation(passThroughImpls.resolveRepoRef);
  }
  if (passThroughImpls.resolveGitHubToken) {
    reconcilerMocks.mockResolveGitHubToken.mockImplementation(passThroughImpls.resolveGitHubToken);
  }
  if (passThroughImpls.getPullRequestByNumber) {
    reconcilerMocks.mockGetPullRequestByNumber.mockImplementation(
      passThroughImpls.getPullRequestByNumber,
    );
  }
  if (passThroughImpls.fetchRunsForHead) {
    reconcilerMocks.mockFetchRunsForHead.mockImplementation(passThroughImpls.fetchRunsForHead);
  }
  if (passThroughImpls.detectReleasePleaseConfig) {
    reconcilerMocks.mockDetectReleasePleaseConfig.mockImplementation(
      passThroughImpls.detectReleasePleaseConfig,
    );
  }
  reconcilerMocks.mockFetchCheckRunsForHead.mockReset().mockResolvedValue([]);
  reconcilerMocks.mockCreatePullRequestReview.mockReset().mockResolvedValue({
    id: 1,
    htmlUrl: "https://github.com/o/r/pull/9#pullrequestreview-1",
  });
}

export async function mockTaskPromoteFactory(importOriginal: ImportOriginal) {
  const actual = await importOriginal();
  passThroughImpls.promoteTaskToPR = actual.promoteTaskToPR as (...args: unknown[]) => unknown;
  reconcilerMocks.mockPromoteTaskToPR.mockImplementation(passThroughImpls.promoteTaskToPR);
  return {
    ...actual,
    openDraftPRForTask: reconcilerMocks.mockOpenDraftPRForTask,
    promoteTaskToPR: reconcilerMocks.mockPromoteTaskToPR,
  };
}

export async function mockTaskReseedFactory(importOriginal: ImportOriginal) {
  const actual = await importOriginal();
  passThroughImpls.reseedTaskIfSessionExited = actual.reseedTaskIfSessionExited as (
    ...args: unknown[]
  ) => unknown;
  reconcilerMocks.mockReseedTaskIfSessionExited.mockImplementation(
    passThroughImpls.reseedTaskIfSessionExited,
  );
  return {
    ...actual,
    reseedTaskIfSessionExited: reconcilerMocks.mockReseedTaskIfSessionExited,
  };
}

export async function mockHostGitFactory(importOriginal: ImportOriginal) {
  const actual = await importOriginal();
  passThroughImpls.resolveRepoRef = actual.resolveRepoRef as (...args: unknown[]) => unknown;
  reconcilerMocks.mockResolveRepoRef.mockImplementation(passThroughImpls.resolveRepoRef);
  return {
    ...actual,
    resolveHostGitStatus: reconcilerMocks.mockResolveHostGitStatus,
    ...repoRefMocks(reconcilerMocks.mockResolveRepoRef),
    commitHostWipChanges: reconcilerMocks.mockCommitHostWipChanges,
  };
}

export async function mockGitWorktreeFactory(importOriginal: ImportOriginal) {
  const actual = await importOriginal();
  return {
    ...actual,
    resumeTaskWorktree: reconcilerMocks.mockResumeTaskWorktree,
    removeWorktree: reconcilerMocks.mockRemoveWorktree,
  };
}

export async function mockGithubIntegrationFactory(importOriginal: ImportOriginal) {
  const actual = await importOriginal();
  passThroughImpls.resolveGitHubToken = actual.resolveGitHubToken as (
    ...args: unknown[]
  ) => unknown;
  reconcilerMocks.mockResolveGitHubToken.mockImplementation(passThroughImpls.resolveGitHubToken);
  return {
    ...actual,
    resolveGitHubToken: reconcilerMocks.mockResolveGitHubToken,
    resolveReviewerToken: reconcilerMocks.mockResolveReviewerToken,
    resolveMullionReviewLogins: reconcilerMocks.mockResolveMullionReviewLogins,
  };
}

export async function mockGithubWriteFactory(importOriginal: ImportOriginal) {
  const actual = await importOriginal();
  passThroughImpls.getPullRequestByNumber = actual.getPullRequestByNumber as (
    ...args: unknown[]
  ) => unknown;
  reconcilerMocks.mockGetPullRequestByNumber.mockImplementation(
    passThroughImpls.getPullRequestByNumber,
  );
  return {
    ...actual,
    getPullRequestByNumber: reconcilerMocks.mockGetPullRequestByNumber,
    mergePullRequest: reconcilerMocks.mockMergePullRequest,
    updatePullRequestBranch: reconcilerMocks.mockUpdatePullRequestBranch,
    deleteRemoteBranch: reconcilerMocks.mockDeleteRemoteBranch,
    updatePullRequestTitle: reconcilerMocks.mockUpdatePullRequestTitle,
    createPullRequestReview: reconcilerMocks.mockCreatePullRequestReview,
    getPullRequestReviewDecision: reconcilerMocks.mockGetPullRequestReviewDecision,
    fetchPullRequestReviewThreads: reconcilerMocks.mockFetchPullRequestReviewThreads,
    resolveReviewThread: reconcilerMocks.mockResolveReviewThread,
    findReleasePullRequest: reconcilerMocks.mockFindReleasePullRequest,
    invalidateReleaseCache: reconcilerMocks.mockInvalidateReleaseCache,
    detectReleaseWorkflow: reconcilerMocks.mockDetectReleaseWorkflow,
  };
}

export async function mockGithubFactory(importOriginal: ImportOriginal) {
  const actual = await importOriginal();
  passThroughImpls.fetchRunsForHead = actual.fetchRunsForHead as (...args: unknown[]) => unknown;
  passThroughImpls.detectReleasePleaseConfig = actual.detectReleasePleaseConfig as (
    ...args: unknown[]
  ) => unknown;
  reconcilerMocks.mockFetchRunsForHead.mockImplementation(passThroughImpls.fetchRunsForHead);
  reconcilerMocks.mockDetectReleasePleaseConfig.mockImplementation(
    passThroughImpls.detectReleasePleaseConfig,
  );
  return {
    ...actual,
    fetchRunsForHead: reconcilerMocks.mockFetchRunsForHead,
    fetchRunsForHeadChecked: async (...args: unknown[]) => {
      if (runsLookup.failed) return { ok: false, runs: [] };
      return { ok: true, runs: await reconcilerMocks.mockFetchRunsForHead(...args) };
    },
    fetchCheckRunsForHead: reconcilerMocks.mockFetchCheckRunsForHead,
    getDefaultBranch: reconcilerMocks.mockGetDefaultBranch,
    detectReleasePleaseConfig: reconcilerMocks.mockDetectReleasePleaseConfig,
  };
}

let cachedTaskReviewFindingsPath:
  ((sessionsDir: string, taskId: number, round: number) => string) | null = null;

/**
 * Registers beforeAll/afterAll/beforeEach/afterEach for a task-reconciler
 * test suite: isolated SQLite DB, CODEX_HOME/HOME scratch dirs, per-test
 * tasks+sessions table reset, and mock defaults/resets.
 */
export function setupReconcilerTestLifecycle(suiteSlug: string): void {
  const tmpDb = path.join(os.tmpdir(), `${suiteSlug}-${process.pid}.db`);
  let codexHome = "";
  let fakeHome = "";
  let dbTablesReady = false;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-reconciler-codex-home-"));
    process.env.CODEX_HOME = codexHome;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-reconciler-fake-home-"));
    process.env.HOME = fakeHome;
  });

  afterAll(async () => {
    const { closeDb } = await import("../../src/db/client.js");
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_BUDGET_MINUTES;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (!cachedTaskReviewFindingsPath) {
      const { taskReviewFindingsPath } = await import("../../src/services/task-prompt.js");
      cachedTaskReviewFindingsPath = taskReviewFindingsPath;
    }
    runsLookup.failed = false;
    restorePassThroughMocks();
    reconcilerMocks.mockOpenDraftPRForTask
      .mockReset()
      .mockResolvedValue({ ok: false, reason: "no-token" });
    const { getDb } = await import("../../src/db/client.js");
    const { tasks, sessions } = await import("../../src/db/schema.js");
    const db = getDb();
    if (!dbTablesReady) {
      try {
        db.delete(tasks).run();
        // sessions.taskId has no FK, so stale session rows would survive the delete above.
        db.delete(sessions).run();
        dbTablesReady = true;
      } catch (err) {
        // First beforeEach runs before buildApp() migrates tmpDb; any other error is real.
        if (!(err instanceof Error) || !err.message.includes("no such table")) {
          throw err;
        }
      }
    } else {
      db.delete(tasks).run();
      db.delete(sessions).run();
    }
    reconcilerMocks.mockResolveHostGitStatus.mockReset();
    reconcilerMocks.mockCommitHostWipChanges
      .mockReset()
      .mockResolvedValue({ ok: true, value: { committed: false } });
    reconcilerMocks.mockResolveRepoRef.mockClear();
    reconcilerMocks.mockResolveGitHubToken.mockClear();
    reconcilerMocks.mockGetPullRequestByNumber.mockClear();
    reconcilerMocks.mockPromoteTaskToPR.mockClear();
    reconcilerMocks.mockReseedTaskIfSessionExited.mockClear();
    reconcilerMocks.mockMergePullRequest.mockReset();
    reconcilerMocks.mockUpdatePullRequestBranch.mockReset();
    reconcilerMocks.mockDeleteRemoteBranch.mockReset();
    reconcilerMocks.mockUpdatePullRequestTitle.mockReset().mockResolvedValue(undefined);
    reconcilerMocks.mockFindReleasePullRequest.mockReset();
    reconcilerMocks.mockGetDefaultBranch.mockReset();
    reconcilerMocks.mockInvalidateReleaseCache.mockReset();
    reconcilerMocks.mockDetectReleaseWorkflow.mockReset();
    reconcilerMocks.mockFetchRunsForHead.mockClear();
    reconcilerMocks.mockFetchCheckRunsForHead.mockClear();
    reconcilerMocks.mockCreatePullRequestReview.mockClear();
    reconcilerMocks.mockGetPullRequestReviewDecision.mockReset().mockResolvedValue(null);
    reconcilerMocks.mockResolveReviewerToken.mockReset().mockResolvedValue(null);
    reconcilerMocks.mockResolveMullionReviewLogins
      .mockReset()
      .mockImplementation(async (_app, _repo, primaryViewerLogin: string | null) =>
        primaryViewerLogin !== null ? new Set([primaryViewerLogin]) : new Set(),
      );
    reconcilerMocks.mockResolveReviewThread.mockReset().mockResolvedValue(undefined);
    reconcilerMocks.mockResumeTaskWorktree.mockReset().mockResolvedValue(null);
    reconcilerMocks.mockRemoveWorktree.mockReset().mockResolvedValue(true);
    reconcilerMocks.mockFetchPullRequestReviewThreads
      .mockReset()
      .mockResolvedValue({ viewerLogin: null, threads: [], truncated: false });
    reconcilerMocks.mockHermesUsable.mockReset().mockReturnValue(false);
    reconcilerMocks.mockDispatchTaskReview.mockReset();
    reconcilerMocks.mockPollTaskReview.mockReset();
    reconcilerMocks.mockStopHermesRun.mockReset();
    reconcilerMocks.mockNotifyTaskNeedsAttention.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
}

/**
 * The SessionBackend members these fakes never exercise, as inert mocks.
 * SessionBackend has grown members over time, and a fake that is missing
 * one no longer IS a SessionBackend — so the doubles carry the whole
 * interface, and the members a test cares about are set on top.
 */
export function inertBackendMembers() {
  return {
    listSessionProcesses: vi.fn().mockResolvedValue([]),
    uploadFile: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
    removeWorktree: vi.fn().mockResolvedValue(false),
    syncWorktree: vi.fn().mockResolvedValue(false),
    listTaskWorktreeDirs: vi.fn().mockResolvedValue([]),
    deleteBranch: vi.fn().mockResolvedValue({ deleted: false, reason: "not-a-repo" }),
    checkoutBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    createBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    rebaseBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    removeListedWorktree: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
    pruneWorktreeMetadata: vi.fn().mockResolvedValue({ pruned: false }),
    readTaskReviewFindings: vi.fn().mockResolvedValue(null),
    deleteTaskReviewFindings: vi.fn().mockResolvedValue(undefined),
    resolveSessionsDir: vi.fn().mockResolvedValue("/remote/sessions-dir"),
    readTaskCommitTitle: vi.fn().mockResolvedValue(null),
    readTaskRereviewRequest: vi.fn().mockResolvedValue(null),
    readTaskCiUnfixable: vi.fn().mockResolvedValue(null),
  };
}

export function fakeInfo(overrides: Partial<Record<string, unknown>> = {}) {
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
    lastTurnEndedAt: null,
    // Issue #1735 — the reconciler's worker->review gate reads
    // `workFinishedAt` (the last turn end that meant "the agent's work is
    // done"), not `lastTurnEndedAt` (when a turn ended at all). Derived
    // from the same override so the existing fixtures keep their meaning
    // — "the turn finished → the gate opens" — while a test that is
    // specifically about the work-finished signal can override it
    // independently.
    outstandingBackgroundTasks: [],
    ...overrides,
    workFinishedAt:
      "workFinishedAt" in overrides
        ? (overrides.workFinishedAt as number | null)
        : ((overrides.lastTurnEndedAt as number | null) ?? null),
  };
}

export async function createSessionAndTask(
  app: TestApp,
  status: "claimed" | "in_progress",
  claimedAt: Date = new Date(),
) {
  const { tasks } = await import("../../src/db/schema.js");
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
  });
  const session = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId: project.json().id, command: "bash" },
  });
  const sessionId = session.json().id as number;
  const [row] = app.db
    .insert(tasks)
    .values({
      projectId: project.json().id,
      title: "t",
      status,
      sessionId,
      claimedAt,
      startedAt: status === "in_progress" ? claimedAt : null,
    })
    .returning()
    .all();
  return { taskId: row.id, sessionId };
}

export async function getTask(app: TestApp, taskId: number) {
  const { tasks } = await import("../../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  return row;
}

export async function createSessionAndTaskWithReviewAgent(
  app: TestApp,
  status: "claimed" | "in_progress",
  reviewAgent: string,
) {
  const { tasks } = await import("../../src/db/schema.js");
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name: "p-review", cwd: "/tmp" },
  });
  await app.inject({
    method: "PATCH",
    url: `/api/projects/${project.json().id}`,
    payload: { defaultReviewAgent: reviewAgent },
  });
  const session = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId: project.json().id, command: "bash" },
  });
  const sessionId = session.json().id as number;
  const [row] = app.db
    .insert(tasks)
    .values({
      projectId: project.json().id,
      title: "reviewed task",
      body: "some spec",
      status,
      sessionId,
      claimedAt: new Date(),
      startedAt: status === "in_progress" ? new Date() : null,
      worktreePath: "/tmp",
    })
    .returning()
    .all();
  return { taskId: row.id, sessionId };
}

const HARNESS_BASE_SHA = "0000000111122223333444455556666777788889";

export async function createSessionAndTaskWithBase(
  app: TestApp,
  status: "claimed" | "in_progress",
  claimedAt: Date = new Date(),
) {
  const { tasks } = await import("../../src/db/schema.js");
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      allowDuplicate: true,
      createDir: true,
      name: `p-gate-${Math.random()}`,
      cwd: "/tmp",
    },
  });
  const session = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId: project.json().id, command: "bash" },
  });
  const sessionId = session.json().id as number;
  const [row] = app.db
    .insert(tasks)
    .values({
      projectId: project.json().id,
      title: "t",
      status,
      sessionId,
      claimedAt,
      startedAt: status === "in_progress" ? claimedAt : null,
      worktreePath: "/tmp/mullion-task-worktree",
      branchName: "mullion/task-999",
      baseSha: HARNESS_BASE_SHA,
    })
    .returning()
    .all();
  return { taskId: row.id, sessionId };
}

export function gitStatus(hash: string | null, isClean: boolean, files: unknown[] = []) {
  return {
    ok: true as const,
    value: {
      isRepo: true,
      status: { branch: "mullion/task-999", hash, ahead: 0, behind: 0, files, isClean },
    },
  };
}

export function mockFinishedSessionIds(app: TestApp, ...ids: number[]) {
  const finished = new Set(ids.map(String));
  vi.spyOn(app.pty, "get").mockImplementation(
    (id: string) =>
      ({
        toInfo: () =>
          finished.has(String(id)) ? fakeInfo({ lastTurnEndedAt: Date.now() }) : fakeInfo(),
      }) as never,
  );
}

export async function claimIntoReviewing(app: TestApp, reviewAgent: string) {
  const { tasks } = await import("../../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
  const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
    app,
    "in_progress",
    reviewAgent,
  );
  app.db.update(tasks).set({ agentCommand: "codex" }).where(eq(tasks.id, taskId)).run();
  mockFinishedSessionIds(app, workerSessionId);
  await reconcileTasks(app);
  const row = await getTask(app, taskId);
  const reviewSessionId = row.reviewSessionId as number;
  mockFinishedSessionIds(app, reviewSessionId);
  return { taskId, workerSessionId, reviewSessionId };
}

export function writeFindings(app: TestApp, taskId: number, round: number, content: string) {
  if (!cachedTaskReviewFindingsPath) {
    throw new Error("writeFindings called before setupReconcilerTestLifecycle beforeEach");
  }
  const findingsPath = cachedTaskReviewFindingsPath(
    path.dirname(app.pty.hookSocketPath),
    taskId,
    round,
  );
  fs.writeFileSync(findingsPath, content);
}

export async function createDoneTaskWithPendingMerge(app: TestApp, prNumber = 9) {
  const { tasks } = await import("../../src/db/schema.js");
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      allowDuplicate: true,
      createDir: true,
      name: `p-merge-${Math.random()}`,
      cwd: "/tmp",
    },
  });
  const [row] = app.db
    .insert(tasks)
    .values({
      projectId: project.json().id,
      title: "merge-pending",
      status: "done",
      claimedAt: new Date(),
      completedAt: new Date(),
      prNumber,
      prUrl: `https://github.com/o/r/pull/${prNumber}`,
      mergeRequestedAt: new Date(),
    })
    .returning()
    .all();
  return { taskId: row.id, projectId: project.json().id };
}

export async function createAutoApproveCandidate(
  app: TestApp,
  overrides: Partial<{
    title: string;
    prTitle: string | null;
    lastReviewVerdict: string | null;
    reviewSessionId: number | null;
    reviewFindingsIngestedSessionId: number | null;
    reviewRunId: string | null;
    reviewRunDispatchedAt: Date | null;
    reviewRunHeadSha: string | null;
    reviewRunIngestedId: string | null;
    prNumber: number | null;
    autoApprove: boolean;
    worktreePath: string | null;
    branchName: string | null;
    rebaseAttempts: number;
    agentCommand: string | null;
    reviewAgent: string | null;
    autoReturnRounds: number;
    sessionId: number | null;
    lastPrReviewCommentAt: Date | null;
  }> = {},
) {
  const { tasks } = await import("../../src/db/schema.js");
  const { autoApprove = true, ...taskOverrides } = overrides;
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      allowDuplicate: true,
      createDir: true,
      name: `p-auto-approve-${Math.random()}`,
      cwd: "/tmp",
    },
  });
  const projectId = project.json().id;
  await app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    payload: { autoApprove },
  });
  const session = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { projectId, command: "bash" },
  });
  const reviewSessionId = session.json().id as number;
  const [row] = app.db
    .insert(tasks)
    .values({
      projectId,
      title: "auto-approve candidate",
      status: "reviewing",
      claimedAt: new Date(),
      reviewingAt: new Date(),
      prNumber: 9,
      reviewSessionId,
      reviewFindingsIngestedSessionId: reviewSessionId,
      lastReviewVerdict: "clean",
      ...taskOverrides,
    })
    .returning()
    .all();
  return { taskId: row.id, projectId, reviewSessionId };
}

export function mockPr(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 9,
    htmlUrl: "https://github.com/o/r/pull/9",
    nodeId: "PR_node9",
    draft: false,
    headSha: "sha-head",
    headRef: "mullion/task-x",
    baseRef: "main",
    title: "feat: do the thing",
    state: "open",
    merged: false,
    mergeable: true,
    mergeableState: "clean",
    ...overrides,
  };
}

export function ciRun(conclusion: "success" | "failure") {
  return [
    {
      name: "CI",
      status: "completed" as const,
      conclusion,
      htmlUrl: "https://x/1",
      headSha: "sha-head",
    },
  ];
}
