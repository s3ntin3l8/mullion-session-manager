import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { spawn as childProcessSpawn } from "node:child_process";
import type * as TaskReseedModule from "../../src/services/task-reseed.js";
import type * as TaskPromoteModule from "../../src/services/task-promote.js";
import type * as GitHubIntegrationModule from "../../src/services/github-integration.js";
import type * as GitHubWriteModule from "../../src/services/github-write.js";
import type * as GitHubModule from "../../src/services/github.js";

// Same fakes as session-reconciler.test.ts / test/routes/sessions.test.ts —
// session creation still spawns real OS processes (systemd-run, dtach) via
// PtyManager, faked so this file exercises reconcileTasks against a real
// app + DB without needing a real systemd --user session in CI.
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
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

// Hermes review, PR #574 (finding #2) — maybeOpenDraftPR's wiring into both
// "-> reviewing" transitions was previously untested: every existing
// reviewing-transition test here ran the REAL openDraftPRForTask, which
// silently no-ops on "no-token"/"remote-not-supported" in this file's test
// DB and never proved the reconciler actually calls it or persists its
// result. Mocked (importOriginal-preserved) so those existing tests keep
// their prior no-op behavior, while new tests below assert the call
// directly.
const mockOpenDraftPRForTask = vi.fn();
// Auto-approve sweep tests below call the REAL approveTask (task-approve.ts),
// which calls the real promoteTaskToPR — a real git push + GitHub PR flow
// this file's tasks have no real worktree/repo for. Pass-through by default
// (wired via importActual below, same posture as mockResolveRepoRef etc.),
// only overridden with `.mockResolvedValueOnce` in the auto-approve describe
// block itself.
const mockPromoteTaskToPR = vi.fn();
vi.mock("../../src/services/task-promote.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    openDraftPRForTask: mockOpenDraftPRForTask,
    promoteTaskToPR: mockPromoteTaskToPR,
  };
});

// Hermes review, PR #580 — the review-feedback auto-return's rollback of a
// spent `autoReturnRounds` when the re-seed fails needs a controllable failure;
// engineering a REAL terminate/spawn failure through this file's full
// integration setup (real createSessionRecord, mocked node-pty/
// child_process that always "succeed") isn't practical. Pass-through by
// default (calls the real implementation, same behavior every other test
// here already relies on) — only overridden with `.mockResolvedValueOnce`
// in the one test that needs to simulate a failed re-seed.
const actualReseedModule = await vi.importActual<typeof TaskReseedModule>(
  "../../src/services/task-reseed.js",
);
const mockReseedTaskIfSessionExited = vi.fn(actualReseedModule.reseedTaskIfSessionExited);
vi.mock("../../src/services/task-reseed.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reseedTaskIfSessionExited: mockReseedTaskIfSessionExited,
  };
});

// #722 — checkReviewingGate (task-reconciler.ts) reads real git status via
// host-git.ts's resolveHostGitStatus, which on the local path shells out to
// `git status` — impossible to exercise for real in this file, since the
// node:child_process mock above replaces every spawn with an
// immediately-exiting fake. Mocked the same importOriginal-preserving way as
// task-promote.js/task-reseed.js above so the new tests below can drive the
// gate directly; every existing test's tasks have no baseSha set, so
// checkReviewingGate's own first fail-open check short-circuits before ever
// calling this mock, leaving their behavior unaffected regardless of its
// default return value.
//
// `vi.hoisted()`, not a plain top-level `const` (matching
// event-store.test.ts/github-pr-poller.test.ts's own precedent, and
// test/helpers/mock-pty.ts's doc comment on exactly this failure mode) —
// the task-reseed.js mock above's `importOriginal()` transitively imports
// session-backend.js -> git-worktree.js during file evaluation, which
// triggers THIS mock's own factory before a plain `const` below it would
// have run yet, throwing "Cannot access before initialization".
// `vi.hoisted()` for every mock fn declared in this file (not plain
// top-level `const`s) — matching event-store.test.ts/github-pr-poller.test.ts's
// own precedent, and test/helpers/mock-pty.ts's doc comment on exactly this
// failure mode: several of these modules transitively import each other
// during file evaluation (host-git.js -> ... -> github-integration.js ->
// github-app.ts -> github.js, etc.), which can trigger a LATER mock
// factory's closure before an EARLIER plain `const` it references has run —
// "Cannot access before initialization". Hoisting every mock fn to the very
// top of the module sidesteps the ordering question entirely.
const {
  mockResolveHostGitStatus,
  mockCommitWipChanges,
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockResolveReviewerToken,
  mockResolveMullionReviewLogins,
  mockGetPullRequestByNumber,
  mockMergePullRequest,
  mockUpdatePullRequestBranch,
  mockDeleteRemoteBranch,
  mockFetchRunsForHead,
  mockFetchRequiredStatusContexts,
  mockFetchCheckRunsForHead,
  mockCreatePullRequestReview,
  mockGetPullRequestReviewDecision,
  mockResumeTaskWorktree,
  mockRemoveWorktree,
  mockFetchPullRequestReviewThreads,
  mockResolveReviewThread,
  mockFindReleasePullRequest,
  mockGetDefaultBranch,
  mockInvalidateReleaseCache,
  mockDetectReleaseWorkflow,
} = vi.hoisted(() => ({
  mockResolveHostGitStatus: vi.fn(),
  mockCommitWipChanges: vi.fn(),
  mockResolveRepoRef: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  // #737 — no pass-through default (unlike mockResolveGitHubToken below):
  // the real implementation mints a live installation token. Defaults to
  // `null` every beforeEach (see below) — "no reviewer App configured" —
  // so every pre-existing test in this file (none of which know about
  // #737) never attempts the re-assert path. Only the dedicated #737
  // tests override this.
  mockResolveReviewerToken: vi.fn(),
  // D0 fix — no pass-through default (the real implementation's own
  // internal call to resolveReviewerToken bypasses this file's mock
  // entirely, since it's an intra-module reference — see
  // resolveMullionReviewLogins's own dedicated tests in
  // github-integration.test.ts for that). Every pre-existing test in this
  // file gets a beforeEach default that reproduces the OLD single-identity
  // filter exactly (just wraps `viewerLogin` in a Set); only the dedicated
  // D0 test below overrides it to include a second, reviewer-App identity.
  mockResolveMullionReviewLogins: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockMergePullRequest: vi.fn(),
  mockUpdatePullRequestBranch: vi.fn(),
  mockDeleteRemoteBranch: vi.fn(),
  mockFetchRunsForHead: vi.fn(),
  mockFetchRequiredStatusContexts: vi.fn(),
  mockFetchCheckRunsForHead: vi.fn(),
  mockCreatePullRequestReview: vi.fn(),
  // #737 — no pass-through default, same reasoning as
  // mockFetchPullRequestReviewThreads below: the real implementation hits
  // GitHub's GraphQL endpoint. Defaults to `null` every beforeEach ("no
  // review requirement configured on this repo") so every pre-existing
  // "blocked" test keeps seeing the original generic message.
  mockGetPullRequestReviewDecision: vi.fn(),
  // #744 — autorelease sweep (processReleaseRequests, via release-merge.ts's
  // resolveReleaseMerge). No pass-through default, same reasoning as
  // mockMergePullRequest etc. above: no pre-existing test's task ever sets
  // releaseRequestedAt, so these are never reached outside the dedicated
  // describe block below.
  mockFindReleasePullRequest: vi.fn(),
  mockGetDefaultBranch: vi.fn(),
  mockInvalidateReleaseCache: vi.fn(),
  mockDetectReleaseWorkflow: vi.fn(),
  // #758 — no pass-through default (unlike commitWipChanges's `{ committed:
  // false }` no-op default): resumeTaskWorktree/removeWorktree would shell
  // out to real git against this file's fake "/tmp" project cwds, which
  // isn't a real repo. Reset to a safe fail-closed default every beforeEach
  // (see below) and only overridden inside the dedicated auto-rebase block.
  mockResumeTaskWorktree: vi.fn(),
  mockRemoveWorktree: vi.fn(),
  // #757 — no pass-through default (unlike mockFetchRunsForHead above): the
  // real implementation hits GitHub's GraphQL endpoint over the network,
  // which this test file has no business doing. Defaults to an empty
  // result every beforeEach (see below) so every pre-existing test — none
  // of which know about #757 — sees no new PR comments, ever. Only the
  // dedicated describe block below overrides it.
  mockFetchPullRequestReviewThreads: vi.fn(),
  // D1 — no pass-through default, same reasoning as
  // mockFetchPullRequestReviewThreads above: the real implementation is a
  // live GraphQL mutation. Reset to a no-op resolved default every
  // beforeEach so no pre-existing test (none of which know about D1)
  // notices it being called at all; only the dedicated D1/D3 tests assert
  // on it.
  mockResolveReviewThread: vi.fn(),
}));
vi.mock("../../src/services/host-git.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveHostGitStatus: mockResolveHostGitStatus,
    // #738 follow-up — resolveRepoRef is the first call resolveReviewCi
    // makes; pass-through wired in below (once the real modules can be
    // imported), overridden only in the dedicated CI-gating tests.
    resolveRepoRef: mockResolveRepoRef,
  };
});

// Same reasoning — the #722 "no commits ahead of base" failure path's WIP
// salvage commit also shells out to real git, mocked here so tests can
// assert it was (or wasn't) invoked without needing a real worktree.
vi.mock("../../src/services/git-worktree.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    commitWipChanges: mockCommitWipChanges,
    resumeTaskWorktree: mockResumeTaskWorktree,
    removeWorktree: mockRemoveWorktree,
  };
});

// #738 follow-up (CI-gated review spawn) — pass-through by default (calls
// the real implementation, wired in below once the real modules can be
// imported). Safe for every pre-existing test in this file: no project host
// config / GitHub integration exists in this test DB, so the real functions
// naturally resolve to null/[] and processPendingReviewSpawns spawns with no
// CI context — exactly the pre-#738-followup behavior. Only overridden with
// `.mockResolvedValueOnce`/`.mockRejectedValueOnce` in the dedicated
// CI-gating tests below — same posture as mockReseedTaskIfSessionExited.
vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveGitHubToken: mockResolveGitHubToken,
    resolveReviewerToken: mockResolveReviewerToken,
    resolveMullionReviewLogins: mockResolveMullionReviewLogins,
  };
});
vi.mock("../../src/services/github-write.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getPullRequestByNumber: mockGetPullRequestByNumber,
    mergePullRequest: mockMergePullRequest,
    updatePullRequestBranch: mockUpdatePullRequestBranch,
    deleteRemoteBranch: mockDeleteRemoteBranch,
    createPullRequestReview: mockCreatePullRequestReview,
    getPullRequestReviewDecision: mockGetPullRequestReviewDecision,
    fetchPullRequestReviewThreads: mockFetchPullRequestReviewThreads,
    resolveReviewThread: mockResolveReviewThread,
    findReleasePullRequest: mockFindReleasePullRequest,
    invalidateReleaseCache: mockInvalidateReleaseCache,
    detectReleaseWorkflow: mockDetectReleaseWorkflow,
  };
});
vi.mock("../../src/services/github.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchRunsForHead: mockFetchRunsForHead,
    fetchRequiredStatusContexts: mockFetchRequiredStatusContexts,
    fetchCheckRunsForHead: mockFetchCheckRunsForHead,
    getDefaultBranch: mockGetDefaultBranch,
  };
});

const actualHostGitModule = await vi.importActual<Record<string, unknown>>(
  "../../src/services/host-git.js",
);
mockResolveRepoRef.mockImplementation(
  actualHostGitModule.resolveRepoRef as (...args: unknown[]) => unknown,
);
const actualGithubIntegrationModule = await vi.importActual<typeof GitHubIntegrationModule>(
  "../../src/services/github-integration.js",
);
mockResolveGitHubToken.mockImplementation(actualGithubIntegrationModule.resolveGitHubToken);
const actualGithubWriteModule = await vi.importActual<typeof GitHubWriteModule>(
  "../../src/services/github-write.js",
);
mockGetPullRequestByNumber.mockImplementation(actualGithubWriteModule.getPullRequestByNumber);
const actualGithubModule = await vi.importActual<typeof GitHubModule>(
  "../../src/services/github.js",
);
mockFetchRunsForHead.mockImplementation(actualGithubModule.fetchRunsForHead);
// #755 — deliberately NOT a pass-through to the real implementation (unlike
// every other mock above): the real one hits GitHub's branch-protection
// endpoint over the network, which this test file has no business doing.
// Defaults to `null` (fail-closed, "lookup failed") so every pre-existing
// test in this file — none of which know about #755 — sees exactly the
// same "don't return the worker" behavior they always have. Only the
// dedicated #755 tests below override this.
mockFetchRequiredStatusContexts.mockResolvedValue(null);
// Never a real pass-through either — only reached once requiredContexts is
// non-null/non-empty, which no pre-existing test triggers. Defaults to []
// so an accidental reach still can't match anything.
mockFetchCheckRunsForHead.mockResolvedValue([]);
// Only #755's cap-reached test below actually exercises a comment post with
// a real prNumber set — every other existing test in this file avoids that
// path entirely by leaving prNumber null. Defaulted here (not a real
// pass-through, same reasoning as fetchRequiredStatusContexts above) so
// that test doesn't need its own real GitHub write mock.
mockCreatePullRequestReview.mockResolvedValue({
  id: 1,
  htmlUrl: "https://github.com/o/r/pull/9#pullrequestreview-1",
});
const actualTaskPromoteModule = await vi.importActual<typeof TaskPromoteModule>(
  "../../src/services/task-promote.js",
);
mockPromoteTaskToPR.mockImplementation(actualTaskPromoteModule.promoteTaskToPR);

const { buildApp } = await import("../../src/app.js");
const { closeDb, getDb } = await import("../../src/db/client.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { tasks, sessions, projects } = await import("../../src/db/schema.js");
const { and, eq, isNull, isNotNull } = await import("drizzle-orm");
const { taskReviewFindingsPath, taskCommitTitlePath } =
  await import("../../src/services/task-prompt.js");
const { deriveWorktreePath } = await import("../../src/services/git-worktree.js");
const { recordGitHubRateLimit, resetGitHubRateLimitForTests } =
  await import("../../src/services/github-fetch.js");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-test-${process.pid}.db`);

// A minimal, fully-idle SessionInfo — every field defaultDeriveStatusInfo
// would otherwise default, but supplied explicitly so each test only
// overrides the one or two fields it cares about (activity /
// lastTurnEndedAt / outstandingBackgroundTasks), matching the exact
// precedence deriveSessionStatus documents (session-status.ts).
function fakeInfo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    activity: "idle",
    attention: false,
    attentionKind: null,
    permissionState: "idle",
    planState: "idle",
    gateState: "idle",
    promoteState: "idle",
    elicitationState: "idle",
    questionState: "idle",
    errorState: "idle",
    errorDetail: null,
    endedReason: null,
    exitCode: null,
    compactState: "idle",
    subagentCount: 0,
    lastTurnEndedAt: null,
    outstandingBackgroundTasks: [],
    ...overrides,
  };
}

describe("reconcileTasks", () => {
  // The review-agent-spawn tests below spawn real "codex"/"agy" sessions
  // through the real hook-adapter merge (createSessionRecord →
  // launch-plan.ts's applyHookAdapters — node-pty/child_process are
  // mocked, but codex.ts's/agy.ts's own fs writes into the agent's REAL
  // config location are not). CODEX_HOME/HOME must be redirected to
  // scratch dirs for the whole file, or these tests write into the
  // developer/CI-runner's own ~/.codex, ~/.gemini/config, and (as of the
  // forwarder-shim migration) ~/.mullion.
  let codexHome: string;
  let fakeHome: string;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    // Reconciler tests exercise already-claimed tasks (inserted directly,
    // bypassing POST .../claim) — Task Master enabled by default here so
    // the review-agent-spawn tests exercise their happy path; the one test
    // that specifically covers Hermes review PR #480's gate overrides this
    // back off via settings.taskMaster.enabled.
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-reconciler-codex-home-"));
    process.env.CODEX_HOME = codexHome;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-reconciler-fake-home-"));
    process.env.HOME = fakeHome;
  });

  afterAll(() => {
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

  beforeEach(() => {
    // Matches the real openDraftPRForTask's actual no-op outcome in this
    // file's test DB (no GitHub token configured) — existing
    // reviewing-transition tests below rely on the draft-PR attempt being a
    // harmless no-op, same as before this was mocked.
    mockOpenDraftPRForTask.mockReset().mockResolvedValue({ ok: false, reason: "no-token" });
    // A "reviewing" task with no PR is exactly what retryStrandedDraftPRs
    // sweeps on every reconcileTasks() call, and plenty of tests in this
    // file legitimately land a task there (the default mock resolves
    // "no-token", so its own draft-PR attempt never sets prNumber) without
    // ever cleaning it up — this file shares one DB across all its tests.
    // Without this, a stray leftover row from an earlier test gets swept
    // (and calls mockOpenDraftPRForTask) on a LATER, unrelated test's very
    // first reconcileTasks() call, corrupting that test's own call-count
    // assertions. Scoped to exactly the rows the sweep itself selects.
    // Wrapped: the very first beforeEach of the whole file runs before any
    // buildApp() call has migrated the (freshly created) tmpDb, so the
    // table doesn't exist yet — nothing to clean up in that case.
    try {
      getDb()
        .delete(tasks)
        .where(and(eq(tasks.status, "reviewing"), isNull(tasks.prNumber)))
        .run();
      // Same reasoning, for the merge sweep: a "done" task with
      // mergeRequestedAt still set is exactly what processMergeRequests
      // sweeps every tick, and a leftover row from an earlier test would
      // otherwise get re-processed (against stale/reset mocks) on a later,
      // unrelated test's first reconcileTasks() call.
      getDb()
        .delete(tasks)
        .where(and(eq(tasks.status, "done"), isNotNull(tasks.mergeRequestedAt)))
        .run();
      // Same reasoning again, for the autorelease sweep (#744): a "done"
      // task with releaseRequestedAt still set is exactly what
      // processReleaseRequests sweeps every tick.
      getDb()
        .delete(tasks)
        .where(and(eq(tasks.status, "done"), isNotNull(tasks.releaseRequestedAt)))
        .run();
      // Same reasoning again, for the auto-approve sweep: a "reviewing"
      // task with a PR is exactly what processAutoApprovals sweeps every
      // tick on any project with autoApprove on, and a leftover row from an
      // earlier test (one that deliberately didn't get approved, e.g. a CI-
      // not-green test) would otherwise be re-swept — against by-then stale
      // mocks — on a later, unrelated test's first reconcileTasks() call.
      getDb()
        .delete(tasks)
        .where(and(eq(tasks.status, "reviewing"), isNotNull(tasks.prNumber)))
        .run();
    } catch {
      // no such table yet — fine, see above.
    }
    // #722 — every existing test's tasks have no baseSha, so
    // checkReviewingGate never actually calls this; reset only so a leaked
    // .mockResolvedValueOnce from one #722 test can't bleed into the next.
    mockResolveHostGitStatus.mockReset();
    mockCommitWipChanges.mockReset().mockResolvedValue({ committed: false });
    // #738 follow-up — `.mockClear()`, NOT `.mockReset()`: these four keep
    // their pass-through-to-the-real-implementation default (wired once,
    // above, via `.mockImplementation`) across every test; only a leaked
    // `.mockResolvedValueOnce`/`.mockRejectedValueOnce` needs clearing so it
    // can't bleed into the next test the way mockResolveHostGitStatus's own
    // comment describes.
    mockResolveRepoRef.mockClear();
    mockResolveGitHubToken.mockClear();
    mockGetPullRequestByNumber.mockClear();
    mockPromoteTaskToPR.mockClear();
    // Merge-sweep mocks have no pass-through default (unlike the four
    // above) — no pre-existing test's tasks ever set mergeRequestedAt, so
    // processMergeRequests never reaches these calls outside the dedicated
    // describe block below. Reset (not just clear) so a leaked
    // .mockResolvedValueOnce/.mockRejectedValueOnce can't bleed forward.
    mockMergePullRequest.mockReset();
    mockUpdatePullRequestBranch.mockReset();
    mockDeleteRemoteBranch.mockReset();
    // #744 — same reasoning: no pre-existing test's task ever sets
    // releaseRequestedAt, so these are only ever reached inside the
    // dedicated autorelease describe block below.
    mockFindReleasePullRequest.mockReset();
    mockGetDefaultBranch.mockReset();
    mockInvalidateReleaseCache.mockReset();
    mockDetectReleaseWorkflow.mockReset();
    mockFetchRunsForHead.mockClear();
    // #755 — same reasoning as mockFetchRunsForHead above: no pre-existing
    // test's project has autoApprove on with a red CI status, so these are
    // never reached outside the dedicated describe block below, but a
    // leaked call count from one #755 test must not bleed into the next.
    mockFetchRequiredStatusContexts.mockClear();
    mockFetchCheckRunsForHead.mockClear();
    mockCreatePullRequestReview.mockClear();
    // #737 — reset (not just clear) so a leaked .mockResolvedValueOnce from
    // one #737 test can't bleed into the next, then re-establish the
    // fail-safe defaults every pre-existing "blocked" test relies on: no
    // review requirement configured, no reviewer App configured.
    mockGetPullRequestReviewDecision.mockReset().mockResolvedValue(null);
    mockResolveReviewerToken.mockReset().mockResolvedValue(null);
    // D0 fix — default reproduces the pre-fix single-identity filter (just
    // the caller's own viewerLogin) so every pre-existing PR-comment test
    // keeps its original behavior; only the dedicated D0 test overrides
    // this to add a second, reviewer-App identity to the set.
    mockResolveMullionReviewLogins
      .mockReset()
      .mockImplementation(async (_app, _repo, primaryViewerLogin: string | null) =>
        primaryViewerLogin !== null ? new Set([primaryViewerLogin]) : new Set(),
      );
    // D1 — safe no-op default; only the dedicated D1/D3 tests configure a
    // real thread to assert `resolveReviewThread` was (or wasn't) called
    // with a specific id.
    mockResolveReviewThread.mockReset().mockResolvedValue(undefined);
    // #758 — fail-closed defaults (no pre-existing test's task has
    // mergeRequestedAt + a "dirty" mergeableState + autoApprove on, so
    // these are never reached outside the dedicated describe block below).
    mockResumeTaskWorktree.mockReset().mockResolvedValue(null);
    mockRemoveWorktree.mockReset().mockResolvedValue(true);
    // #757 — fail-closed/no-op default: no pre-existing test's task has a
    // PR + autoApprove on with new review comments, so this is never
    // reached outside the dedicated describe block below.
    mockFetchPullRequestReviewThreads
      .mockReset()
      .mockResolvedValue({ viewerLogin: null, threads: [], truncated: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createSessionAndTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    status: "claimed" | "in_progress",
    claimedAt: Date = new Date(),
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p", cwd: "/tmp" },
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

  async function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  async function createSessionAndTaskWithReviewAgent(
    app: Awaited<ReturnType<typeof buildApp>>,
    status: "claimed" | "in_progress",
    reviewAgent: string,
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p-review", cwd: "/tmp" },
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
        // maybeSpawnReviewAgent early-returns without a worktreePath — a
        // real claim always sets one; faked here since this test inserts
        // the task row directly rather than going through POST .../claim.
        worktreePath: "/tmp",
      })
      .returning()
      .all();
    return { taskId: row.id, sessionId };
  }

  it("is a no-op when there are no claimed/in_progress tasks", async () => {
    const app = await buildApp();
    const getSpy = vi.spyOn(app.pty, "get");
    await expect(reconcileTasks(app)).resolves.toBeUndefined();
    expect(getSpy).not.toHaveBeenCalled();
    await app.close();
  });

  // Task-claim queueing (rate-limit-storm fix) — a "claimed" row with a
  // live session should never occur in production anymore (dispatch flips
  // status to "in_progress" INSIDE the same reservation transaction that
  // reserves the slot, before the session is spawned — see
  // task-claim.ts's dispatchClaimedTask). This test constructs that state
  // directly anyway (bypassing enqueueTask/dispatchClaimedTask, same as
  // this file's own createSessionAndTask helper always has) purely as a
  // defensive check: reconcileTasks must leave a "claimed" row alone no
  // matter what its session is doing, regardless of how it got there — the
  // "claimed -> in_progress" and "claimed -> reviewing" promotions this
  // used to test were removed as dead code (dispatchClaimedTask now owns
  // both edges; task-reconciler.ts's own comment where the old "claimed"
  // bucket used to live explains why).
  it("leaves claimed alone regardless of session activity — dispatchClaimedTask, not this pass, owns claimed -> in_progress/reviewing now", async () => {
    const app = await buildApp();
    const working = await createSessionAndTask(app, "claimed");
    const idle = await createSessionAndTask(app, "claimed");
    const finished = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockImplementation((id) => {
      if (id === String(working.sessionId)) {
        return { toInfo: () => fakeInfo({ activity: "working" }) } as never;
      }
      if (id === String(finished.sessionId)) {
        return { toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }) } as never;
      }
      return { toInfo: () => fakeInfo() } as never;
    });

    await reconcileTasks(app);

    for (const { taskId } of [working, idle, finished]) {
      const row = await getTask(app, taskId);
      expect(row.status).toBe("claimed");
      expect(row.startedAt).toBeNull();
    }
    await app.close();
  });

  it("flips in_progress -> reviewing once the session's turn is finished", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    await app.close();
  });

  // #761 — the worker's Conventional Commits title, ingested at the exact
  // same "-> reviewing" transition this describe block already covers.
  describe("Conventional Commits title ingestion at -> reviewing (#761)", () => {
    async function createConventionalTitleTask(
      app: Awaited<ReturnType<typeof buildApp>>,
    ): Promise<{ taskId: number; projectId: number }> {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: `p-cc-title-${Math.random()}`, cwd: "/tmp" },
      });
      const projectId = project.json().id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { conventionalCommitTitles: true },
      });
      const session = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "t",
          status: "in_progress",
          sessionId: session.json().id,
          claimedAt: new Date(),
          startedAt: new Date(),
        })
        .returning()
        .all();
      return { taskId: row.id, projectId };
    }

    function writeCommitTitle(
      app: Awaited<ReturnType<typeof buildApp>>,
      taskId: number,
      raw: string,
    ) {
      fs.writeFileSync(taskCommitTitlePath(path.dirname(app.pty.hookSocketPath), taskId), raw);
    }

    it("ingests a well-formed title into tasks.prTitle", async () => {
      const app = await buildApp();
      const { taskId } = await createConventionalTitleTask(app);
      writeCommitTitle(app, taskId, "feat: add credential storage\n");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.prTitle).toBe("feat: add credential storage");
      await app.close();
    });

    it("falls back to a null prTitle (never blocks the transition) when the file is malformed", async () => {
      const app = await buildApp();
      const { taskId } = await createConventionalTitleTask(app);
      writeCommitTitle(app, taskId, "just some prose, not a Conventional Commits title");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.prTitle).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
        expect.stringContaining("didn't parse as a Conventional Commits title"),
      );
      await app.close();
    });

    it("leaves prTitle null (never blocks the transition) when the project hasn't opted in", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.prTitle).toBeNull();
      await app.close();
    });

    // Fresh-review follow-up: the case `?? task.prTitle` on the write exists
    // for — a later round (e.g. after an auto-return) that doesn't rewrite
    // the title file must keep the EARLIER round's good title, not erase it
    // just because this round's file is absent.
    it("keeps a prior round's title when this round's file is absent", async () => {
      const app = await buildApp();
      const { taskId } = await createConventionalTitleTask(app);
      app.db
        .update(tasks)
        .set({ prTitle: "feat: add credential storage" })
        .where(eq(tasks.id, taskId))
        .run();
      // Deliberately no writeCommitTitle call for this round.
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.prTitle).toBe("feat: add credential storage");
      await app.close();
    });
  });

  // #772 — a reject-and-re-review cycle leaves the PRIOR round's review
  // session attached as `task.reviewSessionId` right up until this same
  // "-> reviewing" transition nulls it. Before this fix, nothing ever
  // terminated that stale session — it was simply orphaned, still "active"
  // in the DB with no task row pointing at it anymore.
  it("kills the prior round's review session when re-entering reviewing (reject-and-re-review)", async () => {
    const app = await buildApp();
    const { taskId, projectId } = await createSessionAndTask(app, "in_progress").then(async (r) => {
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, r.taskId)).all();
      return { ...r, projectId: row.projectId };
    });
    const staleReview = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const staleReviewSessionId = staleReview.json().id as number;
    app.db
      .update(tasks)
      .set({ reviewSessionId: staleReviewSessionId })
      .where(eq(tasks.id, taskId))
      .run();
    vi.spyOn(app.pty, "get").mockImplementation((id) => {
      if (id === String(staleReviewSessionId)) return { toInfo: () => fakeInfo() } as never;
      return { toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }) } as never;
    });

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.reviewSessionId).not.toBe(staleReviewSessionId);
    const { sessions } = await import("../../src/db/schema.js");
    const [staleRow] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, staleReviewSessionId))
      .all();
    expect(staleRow.status).toBe("killed");

    await app.close();
  });

  it("does not block the '-> reviewing' transition when killing the stale review session fails", async () => {
    const app = await buildApp();
    const { taskId, projectId } = await createSessionAndTask(app, "in_progress").then(async (r) => {
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, r.taskId)).all();
      return { ...r, projectId: row.projectId };
    });
    const staleReview = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const staleReviewSessionId = staleReview.json().id as number;
    app.db
      .update(tasks)
      .set({ reviewSessionId: staleReviewSessionId })
      .where(eq(tasks.id, taskId))
      .run();
    vi.spyOn(app.pty, "get").mockImplementation((id) => {
      if (id === String(staleReviewSessionId)) return { toInfo: () => fakeInfo() } as never;
      return { toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }) } as never;
    });
    const sessionsModule = await import("../../src/services/session-lifecycle.js");
    const killSpy = vi
      .spyOn(sessionsModule, "killSession")
      .mockRejectedValueOnce(new Error("boom"));
    const warnSpy = vi.spyOn(app.log, "warn");

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    // Fire-and-forget — flush microtasks before asserting the warn fired.
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, reviewSessionId: staleReviewSessionId }),
      "task reconcile: failed to kill the superseded review session",
    );

    killSpy.mockRestore();
    await app.close();
  });

  it("leaves in_progress alone while the session is still actively working", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ activity: "working" }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    await app.close();
  });

  it("does not finish a task whose Stop hook fired but a background task is still outstanding", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now(), outstandingBackgroundTasks: ["bg-1"] }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    await app.close();
  });

  it("skips a task whose session already exited — that's #282's job, not this pass's", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ endedReason: "crashed" }),
    } as never);
    // Flip the underlying session row itself to "exited" (independent of
    // liveness info) so dbStatus feeds "exited" into deriveSessionStatus —
    // the exact case reconcileTasks must not race #282 on.
    const { sessions } = await import("../../src/db/schema.js");
    const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, task.sessionId!)).run();

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("claimed");
    await app.close();
  });

  it("fails a task once its budget is exceeded and terminates its session", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    try {
      const app = await buildApp();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId, sessionId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ activity: "working" }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("budget exceeded");
      expect(row.completedAt).not.toBeNull();
      expect(terminateSpy).toHaveBeenCalledWith(String(sessionId));
      // #772 — killSession, not a bare backend.terminate: the row itself
      // must flip to "killed".
      const { sessions } = await import("../../src/db/schema.js");
      const [sessionRow] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      expect(sessionRow.status).toBe("killed");

      await app.close();
    } finally {
      process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    }
  });

  // Independent review, PR #480 — proves the settings override actually
  // reaches task-reconciler.ts's deadline computation (task-config.ts's
  // resolver), not just that the pure resolver function returns the right
  // number. The env var stays generous (120) so only the settings override
  // could be responsible for the force-fail here.
  it("fails a task once its budget is exceeded per settings.taskMaster.budgetMinutes, overriding a generous env default", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    const app = await buildApp();
    try {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { budgetMinutes: 1 } },
      });
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId, sessionId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ activity: "working" }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("budget exceeded");
      expect(terminateSpy).toHaveBeenCalledWith(String(sessionId));
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { budgetMinutes: -1 } },
      });
      await app.close();
    }
  });

  it("cleans up the worktree once budget-failed (6.8/#283), but only when one was recorded", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    try {
      const app = await buildApp();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      app.db
        .update(tasks)
        .set({ worktreePath: "/tmp/.mullion-worktrees/mullion-task-1" })
        .where(eq(tasks.id, taskId))
        .run();
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ activity: "working" }),
      } as never);

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const removeWorktreeIfCleanMock = vi.fn().mockResolvedValue({ removed: true });
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "removeWorktreeIfClean") return removeWorktreeIfCleanMock;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(removeWorktreeIfCleanMock).toHaveBeenCalledWith(
        "/tmp/.mullion-worktrees/mullion-task-1",
        "/tmp",
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    } finally {
      process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    }
  });

  it("never fails a task on budget when MULLION_TASK_BUDGET_MINUTES is 0 (unlimited)", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "0";
    try {
      const app = await buildApp();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo(),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("claimed");

      await app.close();
    } finally {
      process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    }
  });

  it("does not advance an untracked session (app.pty has no live handle for it) past idle defaults", async () => {
    // LocalBackend.liveStatus always sets a key for every requested id —
    // `app.pty.get(id)?.toInfo(...) ?? null` — so an untracked session
    // reads as `null`, not an omitted key; `defaultDeriveStatusInfo(null)`
    // then supplies its own idle defaults, which is what this test
    // actually exercises. (A genuinely *omitted* key is a remote-host-only
    // possibility — reconcileTasks's own `info === undefined` guard exists
    // for that case, mirroring session-reconciler.ts's `alive === undefined`
    // rule, but isn't reachable through a local-only test setup like this
    // one.)
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("claimed");
    await app.close();
  });

  describe("review agent (this phase's binding design)", () => {
    it("spawns the configured review agent when a task enters reviewing, recording reviewSessionId", async () => {
      const app = await buildApp();
      // "in_progress", not "claimed" — task-claim queueing (rate-limit-storm
      // fix) removed the claimed -> reviewing edge; see this describe
      // block's own "in_progress -> reviewing" test below for why that
      // used to be tested via BOTH edges and is now only reachable via one.
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "in_progress",
        "codex",
      );
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.reviewSessionId).not.toBe(workerSessionId);

      await app.close();
    });

    // #9 — named and locked at spawn time, same reasoning/pattern as the
    // worker spawns (task-claim.ts's own tests).
    it("names and locks the review session (#9)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      const { sessions } = await import("../../src/db/schema.js");
      const [session] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, row.reviewSessionId))
        .all();
      expect(session).toMatchObject({ name: `Task #${taskId} · review`, nameLocked: true });

      await app.close();
    });

    it("spawns the review agent even when its adapter can't receive a seed (#487), recording reviewSeedDelivered: false and logging a warning", async () => {
      const app = await buildApp();
      // gemini, not opencode — opencode gained `initialPromptArgs`
      // (`--prompt`) and is seed-capable now, see hook-adapters/opencode.ts.
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "in_progress",
        "gemini",
      );
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.reviewSessionId).not.toBe(workerSessionId);
      // Spawned anyway (advisory, unlike the worker claim's outright
      // refusal) — but the row now records the seed miss instead of it
      // being visible only in server logs.
      expect(row.reviewSeedDelivered).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
        expect.stringContaining("can't receive an initial prompt"),
      );
      // gemini has no adapter at all, so no initial-prompt argv form — the
      // spawned command is untouched, not carrying the review prompt
      // anywhere.
      const call = vi
        .mocked(childProcessSpawn)
        .mock.calls.findLast(([command]) => command === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toBe("gemini");

      await app.close();
    });

    it("records reviewSeedDelivered: true for a seed-capable review agent, delivering the review prompt as argv (not stashSeed — additionalContext never starts a turn)", async () => {
      const app = await buildApp();
      // "in_progress", not "claimed" — task-claim queueing (rate-limit-storm
      // fix) removed the claimed -> reviewing edge; in_progress -> reviewing
      // is the only path left to exercise this.
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const stashSeedSpy = vi.spyOn(app.pty, "stashSeed");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.reviewSeedDelivered).toBe(true);
      expect(stashSeedSpy).not.toHaveBeenCalled();

      const call = vi
        .mocked(childProcessSpawn)
        .mock.calls.findLast(([command]) => command === "systemd-run");
      const args = call?.[1] as string[];
      // shellQuote escapes the apostrophe in "task's" as close-escape-reopen.
      // Asserted in pieces rather than as one contiguous string: the review
      // prompt is now built by task-prompt.ts's buildReviewPrompt, which
      // interposes the worker's-worktree hazard between the advisory
      // framing and the task spec. The exact wording lives in
      // test/services/task-prompt.test.ts; what matters here is that the
      // whole thing reaches the spawned command line as argv.
      const spawnedArg = args[args.length - 1];
      expect(spawnedArg).toContain(
        "'Review this task'\\''s diff. You are not expected to make changes.",
      );
      expect(spawnedArg).toContain("Task: reviewed task\n\nsome spec'");

      await app.close();
    });

    // Independent post-Hermes review, PR #538 — the review agent's spawn
    // shares the exact version-skew risk claimTask/retryTask already cover
    // (test/services/task-claim.test.ts): a remote agent build too old to
    // know about `initialPrompt` silently strips it, so `reviewSeedDelivered`
    // must not be trusted as `true` just because the resolved agent's
    // adapter supports it locally.
    it("does not trust reviewSeedDelivered:true for a remote host that never confirms the review prompt was applied (version skew)", async () => {
      const app = await buildApp();
      const warnSpy = vi.spyOn(app.log, "warn");

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-review-skew", cwd: "/remote/project", hostId },
      });
      const projectId = project.json().id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultReviewAgent: "codex" },
      });
      // Real (FK-valid) rows, inserted directly rather than through
      // POST /api/sessions/claim — no spawn happens during this setup, so
      // resolveBackend can be mocked afterward with no ordering hazard.
      const { sessions } = await import("../../src/db/schema.js");
      const [workerSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          // "in_progress", not "claimed" — task-claim queueing (rate-limit-
          // storm fix) removed the claimed -> reviewing edge.
          projectId,
          title: "reviewed task",
          body: "some spec",
          status: "in_progress",
          sessionId: workerSession.id,
          claimedAt: new Date(),
          startedAt: new Date(),
          worktreePath: "/remote/project",
        })
        .returning()
        .all();

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        spawn: vi.fn().mockResolvedValue({}),
        // Keyed by the real worker session id — task-reconciler.ts treats
        // an omitted key as "unknown, skip" (defaultDeriveStatusInfo never
        // runs), same posture as an untracked local session; `fakeInfo`'s
        // shape matches what app.pty.get(id).toInfo() returns elsewhere in
        // this file, and this is liveStatus's own remote-host equivalent.
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSession.id)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        isMasterAlive: vi.fn().mockResolvedValue({}),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
      };
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("reviewing");
      // codex is seed-capable — a naive reviewSeedDelivered:seedCapable
      // would have reported true here despite the remote host never
      // confirming it applied the prompt.
      expect(row.reviewSeedDelivered).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, hostId, seedCapable: true }),
        expect.stringContaining("possible version skew"),
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    // #778 — the review agent's seed prompt must be told to write to the
    // OWNING host's own sessionsDir, not the primary's. Extends the
    // version-skew test's fakeBackend/remote-host setup above with a
    // distinct `resolveSessionsDir` return value and asserts the spawned
    // findings path is built from THAT value.
    it("embeds the remote host's own sessionsDir in the review agent's findings path (#778)", async () => {
      const app = await buildApp();

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-review-remote-dir", cwd: "/remote/project", hostId },
      });
      const projectId = project.json().id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultReviewAgent: "codex" },
      });
      const { sessions } = await import("../../src/db/schema.js");
      const [workerSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "reviewed task",
          body: "some spec",
          status: "in_progress",
          sessionId: workerSession.id,
          claimedAt: new Date(),
          startedAt: new Date(),
          worktreePath: "/remote/project",
        })
        .returning()
        .all();

      let capturedInitialPrompt: string | undefined;
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        spawn: vi.fn().mockImplementation((opts: { initialPrompt?: string }) => {
          capturedInitialPrompt = opts.initialPrompt;
          return Promise.resolve({});
        }),
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSession.id)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        isMasterAlive: vi.fn().mockResolvedValue({}),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
        readTaskReviewFindings: vi.fn().mockResolvedValue(null),
        deleteTaskReviewFindings: vi.fn().mockResolvedValue(undefined),
        resolveSessionsDir: vi.fn().mockResolvedValue("/remote/own/sessions-dir"),
        readTaskCommitTitle: vi.fn().mockResolvedValue(null),
      };
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      await reconcileTasks(app);

      // The initial prompt is only real argv when the review command is
      // seed-capable (codex is) — spawn() itself is what's mocked here, not
      // createSessionRecord's own initialPrompt-vs-stashSeed branching, so
      // this reaches the same prompt-building path buildReviewPrompt uses.
      expect(capturedInitialPrompt).toBeDefined();
      expect(capturedInitialPrompt).toContain(
        `/remote/own/sessions-dir/task-${task.id}.review.0.md`,
      );
      // The wrong (primary-local) path must never appear.
      expect(capturedInitialPrompt).not.toContain(path.dirname(app.pty.hookSocketPath));
      expect(fakeBackend.resolveSessionsDir).toHaveBeenCalled();

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    // #778 — a resolveSessionsDir failure (host unreachable, version skew)
    // must degrade to the primary's local path with a warn, not strand the
    // review spawn.
    it("falls back to the primary's local sessionsDir when resolving the remote host's own fails (#778)", async () => {
      const app = await buildApp();
      const warnSpy = vi.spyOn(app.log, "warn");

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-review-remote-fallback", cwd: "/remote/project", hostId },
      });
      const projectId = project.json().id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultReviewAgent: "codex" },
      });
      const { sessions } = await import("../../src/db/schema.js");
      const [workerSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "reviewed task",
          body: "some spec",
          status: "in_progress",
          sessionId: workerSession.id,
          claimedAt: new Date(),
          startedAt: new Date(),
          worktreePath: "/remote/project",
        })
        .returning()
        .all();

      let capturedInitialPrompt: string | undefined;
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        spawn: vi.fn().mockImplementation((opts: { initialPrompt?: string }) => {
          capturedInitialPrompt = opts.initialPrompt;
          return Promise.resolve({});
        }),
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSession.id)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        isMasterAlive: vi.fn().mockResolvedValue({}),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
        readTaskReviewFindings: vi.fn().mockResolvedValue(null),
        deleteTaskReviewFindings: vi.fn().mockResolvedValue(undefined),
        resolveSessionsDir: vi.fn().mockRejectedValue(new Error("host unreachable")),
        readTaskCommitTitle: vi.fn().mockResolvedValue(null),
      };
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      await reconcileTasks(app);

      const localSessionsDir = path.dirname(app.pty.hookSocketPath);
      expect(capturedInitialPrompt).toBeDefined();
      expect(capturedInitialPrompt).toContain(`${localSessionsDir}/task-${task.id}.review.0.md`);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, hostId }),
        expect.stringContaining("failed to resolve the owning host's own sessionsDir"),
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("does not spawn a review agent when none is configured", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();

      await app.close();
    });

    it("logs and swallows a review agent spawn failure without affecting the reviewing transition", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const sessionsModule = await import("../../src/services/session-lifecycle.js");
      vi.spyOn(sessionsModule, "createSessionRecord").mockResolvedValueOnce({
        ok: false,
        reason: "spawn-failed",
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();

      await app.close();
    });

    it("does not transition a finished task into reviewing (or spawn a review agent) while Task Master is disabled — avoids stranding it past approve/reject's own gate (Hermes review, PR #480, second pass)", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
        } as never);
        const sessionsModule = await import("../../src/services/session-lifecycle.js");
        const createSessionSpy = vi.spyOn(sessionsModule, "createSessionRecord");

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        // Left in "in_progress" rather than advanced to "reviewing" —
        // approve and reject are both gated on "enabled" too, so a
        // reviewing task would otherwise be unresolvable until Task Master
        // is turned back on. Still reachable by the (ungated) budget
        // force-fail below.
        expect(row.status).toBe("in_progress");
        expect(row.reviewSessionId).toBeNull();
        expect(createSessionSpy).not.toHaveBeenCalled();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("transitions the held-back task into reviewing (and spawns its review agent) once Task Master is re-enabled", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
        } as never);

        await reconcileTasks(app);
        expect((await getTask(app, taskId)).status).toBe("in_progress");

        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "on" } },
        });
        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).not.toBeNull();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("spawns the review agent on the in_progress -> reviewing path too", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "agy");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });
  });

  // Hermes review, PR #574 (finding #2) — maybeOpenDraftPR's wiring was
  // previously exercised only via the real openDraftPRForTask silently
  // no-op'ing on "no-token" in this test DB, which never proved the
  // reconciler actually calls it (with the right task/project) or persists
  // its result. task-promote.ts is mocked above specifically for these.
  describe("draft PR on entering reviewing (Hermes review, PR #574, finding #2)", () => {
    // The former "claimed -> reviewing edge" sibling of this test was
    // deleted (task-claim queueing, rate-limit-storm fix) — that edge no
    // longer exists (dispatchClaimedTask now flips claimed -> in_progress
    // BEFORE a session ever spawns), so in_progress -> reviewing is the
    // only edge left to exercise this behavior through.
    it("calls openDraftPRForTask on the in_progress -> reviewing edge, and persists its result", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockOpenDraftPRForTask.mockResolvedValue({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/11",
        prNumber: 11,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(mockOpenDraftPRForTask.mock.calls[0][1]).toMatchObject({ id: taskId });
      expect(row.prUrl).toBe("https://github.com/test-owner/test-repo/pull/11");
      expect(row.prNumber).toBe(11);

      await app.close();
    });

    it("never blocks the reviewing transition, and leaves prUrl/prNumber unset, when openDraftPRForTask fails (best-effort posture)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockOpenDraftPRForTask.mockResolvedValue({ ok: false, reason: "dirty-tree" });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(row.prUrl).toBeNull();
      expect(row.prNumber).toBeNull();

      await app.close();
    });
  });

  // RC2/#722's investigation (task 213765) — a "reviewing" task whose ONE
  // draft-PR attempt (above) failed (dirty tree right after the worker's
  // last turn, a transient host/push failure) previously had no way back
  // into promotion: the claimed/in_progress SELECT excludes it, and
  // processReviewingTasks is joined on the review session, not the worker,
  // so a task with no review agent is invisible to it too. This sweep
  // (retryStrandedDraftPRs) is the fix.
  describe("stranded draft-PR retry sweep", () => {
    async function createReviewingTaskWithNoPR(
      app: Awaited<ReturnType<typeof buildApp>>,
      prNumber: number | null = null,
    ) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: `p-stranded-${Math.random()}`, cwd: "/tmp" },
      });
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId: project.json().id,
          title: "stranded",
          status: "reviewing",
          claimedAt: new Date(),
          reviewingAt: new Date(),
          prNumber,
        })
        .returning()
        .all();
      return { taskId: row.id };
    }

    it("retries a reviewing task with no PR and persists the result once it succeeds", async () => {
      const app = await buildApp();
      const { taskId } = await createReviewingTaskWithNoPR(app);
      mockOpenDraftPRForTask.mockResolvedValue({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/42",
        prNumber: 42,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(mockOpenDraftPRForTask.mock.calls[0][1]).toMatchObject({ id: taskId });
      expect(row.status).toBe("reviewing");
      expect(row.prUrl).toBe("https://github.com/test-owner/test-repo/pull/42");
      expect(row.prNumber).toBe(42);

      await app.close();
    });

    it("does not record a draft PR that opened after the task already left 'reviewing' (independent review, PR #725)", async () => {
      const app = await buildApp();
      const { taskId } = await createReviewingTaskWithNoPR(app);
      // Simulates a concurrent give-up landing while openDraftPRForTask's
      // own network call is still in flight — by the time it resolves, the
      // task is no longer "reviewing".
      mockOpenDraftPRForTask.mockImplementation(async () => {
        app.db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, taskId)).run();
        return {
          ok: true,
          prUrl: "https://github.com/test-owner/test-repo/pull/99",
          prNumber: 99,
        };
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.prUrl).toBeNull();
      expect(row.prNumber).toBeNull();

      await app.close();
    });

    it("does not touch a reviewing task that already has a PR", async () => {
      const app = await buildApp();
      await createReviewingTaskWithNoPR(app, 7);

      await reconcileTasks(app);

      expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
      await app.close();
    });

    it("backs off after an attempt instead of retrying on every tick", async () => {
      const app = await buildApp();
      await createReviewingTaskWithNoPR(app);
      mockOpenDraftPRForTask.mockResolvedValue({ ok: false, reason: "dirty-tree" });

      await reconcileTasks(app);
      await reconcileTasks(app);

      // Second tick lands well inside the 5-minute TTL — no second attempt.
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("does not retry while Task Master is disabled", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        await createReviewingTaskWithNoPR(app);

        await reconcileTasks(app);

        expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("#759 — does not attempt a draft PR while the install-wide GitHub rate-limit budget is in effect", async () => {
      const app = await buildApp();
      try {
        await createReviewingTaskWithNoPR(app);
        recordGitHubRateLimit(Date.now() + 60_000);

        await reconcileTasks(app);

        expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
      } finally {
        resetGitHubRateLimitForTests();
        await app.close();
      }
    });

    // #759 — the entry-point check above only catches a limit already in
    // effect when the sweep opens; this proves the SEPARATE per-task
    // re-check (right beside the sweep's own MAX_DRAFT_PR_RETRIES_PER_SWEEP
    // cap) actually stops the loop when the limit lands mid-pass instead.
    it("#759 — stops attempting further draft PRs mid-pass once the rate limit lands, rather than continuing to the next task", async () => {
      const app = await buildApp();
      try {
        await createReviewingTaskWithNoPR(app);
        await createReviewingTaskWithNoPR(app);
        mockOpenDraftPRForTask.mockImplementation(async () => {
          // Simulates the limit being discovered via this exact attempt's
          // own response — recorded here, not before the sweep started.
          recordGitHubRateLimit(Date.now() + 60_000);
          return { ok: false, reason: "dirty-tree" };
        });

        await reconcileTasks(app);

        // Two "reviewing, no PR" rows exist; only the FIRST attempt should
        // ever fire — the per-task re-check must stop the loop before the
        // second row is ever reached, whichever row that attempt landed on.
        expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      } finally {
        resetGitHubRateLimitForTests();
        await app.close();
      }
    });
  });

  describe("merge-on-approve sweep (processMergeRequests)", () => {
    // Mirrors createReviewingTaskWithNoPR above — inserts a "done" task with
    // a linked PR and mergeRequestedAt already set, exactly the state
    // approve (or a "Merge now" click) leaves behind. worktreePath is
    // deliberately left null (never set) on every task here: the sweep must
    // resolve repoRef/token from the project alone (see attemptMerge's own
    // doc comment) — a task whose worktree was already cleaned up at
    // approve is the REAL shape this sweep always sees, so a test that
    // accidentally depended on worktreePath would be testing a case that
    // can't happen in production.
    async function createDoneTaskWithPendingMerge(
      app: Awaited<ReturnType<typeof buildApp>>,
      prNumber = 9,
    ) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: `p-merge-${Math.random()}`, cwd: "/tmp" },
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

    function mockPr(overrides: Partial<Record<string, unknown>> = {}) {
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

    beforeEach(() => {
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
      mockResolveGitHubToken.mockResolvedValue("tok");
    });

    // Same reasoning as the CI-gated review-spawn block's own afterEach
    // above: restore the pass-through defaults so this block's fake
    // "tok"/"o/r" values can't leak into an unrelated later test.
    afterEach(() => {
      mockResolveRepoRef.mockImplementation(
        actualHostGitModule.resolveRepoRef as (...args: unknown[]) => unknown,
      );
      mockResolveGitHubToken.mockImplementation(actualGithubIntegrationModule.resolveGitHubToken);
      mockGetPullRequestByNumber.mockImplementation(actualGithubWriteModule.getPullRequestByNumber);
    });

    it("merges a clean PR and deletes its remote branch, clearing the merge flag", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
      mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
      mockDeleteRemoteBranch.mockResolvedValue(undefined);

      await reconcileTasks(app);

      expect(mockMergePullRequest).toHaveBeenCalledWith("tok", "o", "r", 9, {
        sha: "sha-head",
        commitTitle: "feat: do the thing",
      });
      expect(mockDeleteRemoteBranch).toHaveBeenCalledWith("tok", "o", "r", "mullion/task-x");
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).toBeNull();
      expect(row.mergeError).toBeNull();

      await app.close();
    });

    it("still merges when the remote-branch delete fails — the merge itself is the outcome that matters", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
      mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
      mockDeleteRemoteBranch.mockRejectedValue(new Error("network blip"));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).toBeNull();
      expect(row.mergeError).toBeNull();

      await app.close();
    });

    it("updates a behind branch and waits for the next tick instead of merging in the same pass", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "behind" }));
      mockUpdatePullRequestBranch.mockResolvedValue(undefined);

      await reconcileTasks(app);

      expect(mockUpdatePullRequestBranch).toHaveBeenCalledWith("tok", "o", "r", 9, "sha-head");
      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).not.toBeNull();
      expect(row.mergeError).toContain("behind");

      await app.close();
    });

    it("does not merge on 'unstable' — a non-required check is failing or still running", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).not.toBeNull();
      expect(row.mergeError).toContain("non-required check");

      await app.close();
    });

    it("backs off and retries on a real conflict ('dirty') rather than giving up", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).not.toBeNull();
      expect(row.mergeError).toContain("Conflicts with main");

      await app.close();
    });

    describe("auto-rebase on a real conflict (#758)", () => {
      // Mirrors createDoneTaskWithPendingMerge above, plus the fields
      // attemptAutoRebase needs: branchName/agentCommand (a claimed task
      // always has both by the time it's "done" — see task-claim.ts's own
      // reservation transaction), and project.autoApprove defaulted ON
      // (unlike the bare merge-sweep tests above, which deliberately leave
      // it off to prove the plain-backoff fallback).
      async function createDoneTaskWithConflict(
        app: Awaited<ReturnType<typeof buildApp>>,
        overrides: Partial<{
          autoApprove: boolean;
          branchName: string | null;
          agentCommand: string | null;
          rebaseAttempts: number;
          rebaseStartedAt: Date | null;
          sessionId: number | null;
        }> = {},
      ) {
        const { autoApprove = true, ...taskOverrides } = overrides;
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { createDir: true, name: `p-rebase-${Math.random()}`, cwd: "/tmp" },
        });
        const projectId = project.json().id;
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}`,
          payload: { autoApprove },
        });
        const [row] = app.db
          .insert(tasks)
          .values({
            projectId,
            title: "conflicted",
            status: "done",
            claimedAt: new Date(),
            completedAt: new Date(),
            prNumber: 9,
            prUrl: "https://github.com/o/r/pull/9",
            mergeRequestedAt: new Date(),
            branchName: "mullion/task-x",
            agentCommand: "claude",
            ...taskOverrides,
          })
          .returning()
          .all();
        return { taskId: row.id, projectId };
      }

      it("spawns an auto-rebase worker when autoApprove is on", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));
        mockResumeTaskWorktree.mockResolvedValue({
          path: "/tmp/.mullion-worktrees/mullion-task-x",
          branch: "mullion/task-x",
        });

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).toHaveBeenCalledWith("/tmp", "mullion/task-x");
        const row = await getTask(app, taskId);
        expect(row.rebaseAttempts).toBe(1);
        expect(row.rebaseStartedAt).not.toBeNull();
        expect(row.sessionId).not.toBeNull();
        expect(row.worktreePath).toBe("/tmp/.mullion-worktrees/mullion-task-x");
        expect(row.mergeError).toContain("in progress");
        // #9 — the rebase worker is still task #N's worker, named/locked
        // the same as the claim/retry spawns.
        const rebaseSession = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, row.sessionId))
          .all()[0];
        expect(rebaseSession).toMatchObject({
          name: `Task #${taskId} · worker`,
          nameLocked: true,
        });

        await app.close();
      });

      it("clears a stale worktree from a prior attempt before resuming", async () => {
        const app = await buildApp();
        await createDoneTaskWithConflict(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));
        mockResumeTaskWorktree.mockResolvedValue({
          path: "/tmp/.mullion-worktrees/mullion-task-x",
          branch: "mullion/task-x",
        });

        await reconcileTasks(app);

        const expectedStalePath = deriveWorktreePath("/tmp", "mullion/task-x");
        expect(mockRemoveWorktree).toHaveBeenCalledWith(expectedStalePath, "/tmp");
        // Cleared BEFORE resuming, not after — a second attempt at the same
        // deterministic path fails outright otherwise (resumeTaskWorktree's
        // own "target path already exists" refusal).
        const removeOrder = mockRemoveWorktree.mock.invocationCallOrder[0];
        const resumeOrder = mockResumeTaskWorktree.mock.invocationCallOrder[0];
        expect(removeOrder).toBeLessThan(resumeOrder);

        await app.close();
      });

      it("does not spawn a second worker while one is still in flight", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app, {
          rebaseAttempts: 1,
          rebaseStartedAt: new Date(),
        });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.rebaseAttempts).toBe(1);
        expect(row.mergeError).toContain("in progress");

        await app.close();
      });

      it("retries once the previous attempt's window goes stale", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app, {
          rebaseAttempts: 1,
          rebaseStartedAt: new Date(Date.now() - 31 * 60_000),
        });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));
        mockResumeTaskWorktree.mockResolvedValue({
          path: "/tmp/.mullion-worktrees/mullion-task-x",
          branch: "mullion/task-x",
        });

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).toHaveBeenCalledWith("/tmp", "mullion/task-x");
        const row = await getTask(app, taskId);
        expect(row.rebaseAttempts).toBe(2);

        await app.close();
      });

      // Fresh review, PR #783 — a stale rebaseStartedAt is a TIME check, not
      // proof the previous attempt's session actually died: Task Master
      // workers are told to keep running, so "still active" is normal even
      // for a genuinely long-running (not abandoned) rebase-and-reverify
      // round. This proves the still-active session is terminated (and its
      // row flips to "killed", not left "active") BEFORE the stale-worktree
      // force-remove/retry proceeds — never force-removing a worktree a live
      // process might still be writing to.
      it("terminates a stale attempt's still-active session before clearing its worktree and retrying", async () => {
        const app = await buildApp();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { createDir: true, name: `p-rebase-${Math.random()}`, cwd: "/tmp" },
        });
        const projectId = project.json().id;
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}`,
          payload: { autoApprove: true },
        });
        const session = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const staleSessionId = session.json().id as number;
        const [row] = app.db
          .insert(tasks)
          .values({
            projectId,
            title: "conflicted",
            status: "done",
            claimedAt: new Date(),
            completedAt: new Date(),
            prNumber: 9,
            prUrl: "https://github.com/o/r/pull/9",
            mergeRequestedAt: new Date(),
            branchName: "mullion/task-x",
            agentCommand: "claude",
            sessionId: staleSessionId,
            rebaseAttempts: 1,
            rebaseStartedAt: new Date(Date.now() - 31 * 60_000),
          })
          .returning()
          .all();
        const taskId = row.id;
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));
        mockResumeTaskWorktree.mockResolvedValue({
          path: "/tmp/.mullion-worktrees/mullion-task-x",
          branch: "mullion/task-x",
        });

        await reconcileTasks(app);

        const staleSession = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, staleSessionId))
          .all()[0];
        expect(staleSession.status).toBe("killed");
        expect(mockResumeTaskWorktree).toHaveBeenCalledWith("/tmp", "mullion/task-x");
        const updatedRow = await getTask(app, taskId);
        expect(updatedRow.rebaseAttempts).toBe(2);
        expect(updatedRow.sessionId).not.toBe(staleSessionId);

        await app.close();
      });

      it("gives up and falls back to plain conflict backoff once attempts are exhausted", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app, { rebaseAttempts: 2 });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
        expect(mockRemoveWorktree).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.rebaseAttempts).toBe(2);
        expect(row.mergeRequestedAt).not.toBeNull();
        expect(row.mergeError).toContain("gave up after 2 attempt(s)");

        await app.close();
      });

      // Second review, PR #783 — the cap check must run BEFORE the
      // stale-attempt termination, not after: a task that's already at the
      // cap gets no more attempts either way, so terminating a possibly
      // still-working session only to then immediately give up would be a
      // pointless, irreversible kill. This is the one case that combination
      // can actually happen in (stale window + at cap + session still
      // active) — the previous "gives up..." test above never sets
      // rebaseStartedAt, so it can't exercise this ordering.
      // Third review, PR #783 — the in-flight/window check runs BEFORE the
      // cap check specifically so a last-attempt-at-cap still within its
      // window waits for it rather than being reported as "gave up" while
      // it may yet succeed. Every other test here covers rebaseAttempts at
      // 1 (under cap) or a STALE window at the cap — nothing pins the
      // "at cap, but still fresh" combination, which is exactly the case
      // that ordering exists to get right and a future refactor could
      // silently regress.
      it("keeps waiting on an in-flight attempt even when it's the last one allowed (at cap, still within its window)", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app, {
          rebaseAttempts: 2,
          rebaseStartedAt: new Date(),
        });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
        expect(mockRemoveWorktree).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.rebaseAttempts).toBe(2);
        expect(row.mergeError).toContain("in progress");
        expect(row.mergeError).not.toContain("gave up");

        await app.close();
      });

      it("gives up without terminating a stale attempt's still-active session, once attempts are exhausted", async () => {
        const app = await buildApp();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { createDir: true, name: `p-rebase-${Math.random()}`, cwd: "/tmp" },
        });
        const projectId = project.json().id;
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}`,
          payload: { autoApprove: true },
        });
        const session = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const staleSessionId = session.json().id as number;
        const [row] = app.db
          .insert(tasks)
          .values({
            projectId,
            title: "conflicted",
            status: "done",
            claimedAt: new Date(),
            completedAt: new Date(),
            prNumber: 9,
            prUrl: "https://github.com/o/r/pull/9",
            mergeRequestedAt: new Date(),
            branchName: "mullion/task-x",
            agentCommand: "claude",
            sessionId: staleSessionId,
            rebaseAttempts: 2,
            rebaseStartedAt: new Date(Date.now() - 31 * 60_000),
          })
          .returning()
          .all();
        const taskId = row.id;
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
        expect(mockRemoveWorktree).not.toHaveBeenCalled();
        const staleSession = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, staleSessionId))
          .all()[0];
        expect(staleSession.status).toBe("active");
        const updatedRow = await getTask(app, taskId);
        expect(updatedRow.rebaseAttempts).toBe(2);
        expect(updatedRow.sessionId).toBe(staleSessionId);
        expect(updatedRow.mergeError).toContain("gave up after 2 attempt(s)");

        await app.close();
      });

      it("surfaces rather than retries when the branch can't be recreated", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));
        mockResumeTaskWorktree.mockResolvedValue(null);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        // Not retryable by spawning again — attempts/rebaseStartedAt are left
        // untouched so a later merge-sweep tick doesn't mistake this for an
        // in-flight or exhausted attempt; it's surfaced for a human instead.
        expect(row.rebaseAttempts).toBe(0);
        expect(row.rebaseStartedAt).toBeNull();
        expect(row.mergeError).toContain("could not recreate the worktree");

        await app.close();
      });

      // Fresh review, PR #783 — a rebased-then-merged task's worktree/session
      // are real again (attemptAutoRebase overwrote them from their
      // post-approve null), and nothing else ever cleans them up once the
      // conflict resolves: the task never leaves "done", so approveTask's
      // own cleanup (which only fires on a "-> done" transition) never fires
      // a second time for it. clearMergeState must do that cleanup itself —
      // and must NOT reset rebaseAttempts, a lifetime counter design point 8
      // otherwise has zero coverage for.
      it("cleans up the worktree/session and clears rebaseStartedAt on a successful merge, but preserves rebaseAttempts", async () => {
        const app = await buildApp();
        const session = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { createDir: true, name: `p-rebase-merge-${Math.random()}`, cwd: "/tmp" },
        });
        const projectId = session.json().id;
        const workerSession = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const sessionId = workerSession.json().id as number;
        const [row] = app.db
          .insert(tasks)
          .values({
            projectId,
            title: "was-conflicted",
            status: "done",
            claimedAt: new Date(),
            completedAt: new Date(),
            prNumber: 9,
            prUrl: "https://github.com/o/r/pull/9",
            mergeRequestedAt: new Date(),
            branchName: "mullion/task-x",
            agentCommand: "claude",
            sessionId,
            worktreePath: "/tmp/.mullion-worktrees/mullion-task-x",
            rebaseAttempts: 1,
            rebaseStartedAt: new Date(),
          })
          .returning()
          .all();
        const taskId = row.id;
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
        mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
        mockDeleteRemoteBranch.mockResolvedValue(undefined);

        await reconcileTasks(app);

        const updatedRow = await getTask(app, taskId);
        expect(updatedRow.mergeRequestedAt).toBeNull();
        expect(updatedRow.rebaseStartedAt).toBeNull();
        // The lifetime counter — never reset, unlike everything else
        // clearMergeState clears.
        expect(updatedRow.rebaseAttempts).toBe(1);
        const finalSession = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .all()[0];
        expect(finalSession.status).toBe("killed");

        await app.close();
      });
    });

    it("backs off and retries when a required check is blocked", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).not.toBeNull();
      expect(row.mergeError).toContain("Required checks");

      await app.close();
    });

    // #737 — "blocked" collapses several distinct reasons; these pin the
    // review-decision-aware message and the re-assert path.
    describe("blocked -> review decision (#737)", () => {
      it("reports a missing required review distinctly from a red/pending check", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");

        await reconcileTasks(app);

        expect(mockMergePullRequest).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.mergeError).toContain("Waiting on a required approving review");

        await app.close();
      });

      it("reports changes-requested distinctly, without re-asserting (no reviewer App configured)", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockGetPullRequestReviewDecision.mockResolvedValue("CHANGES_REQUESTED");
        mockResolveReviewerToken.mockResolvedValue(null);

        await reconcileTasks(app);

        expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.mergeError).toContain("Changes were requested on the PR");

        await app.close();
      });

      it("falls back to the generic checks message when the review-decision read itself fails", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockGetPullRequestReviewDecision.mockRejectedValue(new Error("GraphQL error"));

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeError).toContain("Required checks");

        await app.close();
      });

      // D1/D3 — a live dry run (2026-08-27) confirmed this exact deadlock:
      // a "blocked" PR with no required-approval rule (`reviewDecision:
      // null`) and green CI was still misdiagnosed as "Required checks are
      // red or still pending" when the real, sole cause was an unresolved
      // review conversation. These derive the cause from OBSERVED threads
      // (branch protection's own `required_conversation_resolution` flag
      // isn't readable without the `administration` scope this App
      // deliberately doesn't have — same gap `fetchRequiredStatusContexts`
      // already documents for `required_status_checks`).
      describe("blocked -> unresolved review conversations (D1/D3)", () => {
        it("reports the unresolved-conversation count instead of the generic message", async () => {
          const app = await buildApp();
          const { taskId } = await createDoneTaskWithPendingMerge(app);
          mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
          mockFetchPullRequestReviewThreads.mockResolvedValue({
            viewerLogin: "mullion-bot[bot]",
            threads: [
              {
                id: "thread-human",
                isResolved: false,
                comments: [
                  {
                    author: "octocat",
                    createdAt: "2026-08-20T10:00:00Z",
                    path: "src/foo.ts",
                    line: 1,
                    body: "Just a suggestion.",
                  },
                ],
              },
              // Already resolved — must not count toward the total.
              {
                id: "thread-resolved",
                isResolved: true,
                comments: [
                  {
                    author: "octocat",
                    createdAt: "2026-08-19T10:00:00Z",
                    path: "src/bar.ts",
                    line: 1,
                    body: "Already handled.",
                  },
                ],
              },
            ],
            truncated: false,
          });

          await reconcileTasks(app);

          const row = await getTask(app, taskId);
          expect(row.mergeError).toBe("Blocked on 1 unresolved review conversation");
          // The unresolved thread is a human's — never a candidate to auto-resolve.
          expect(mockResolveReviewThread).not.toHaveBeenCalled();

          await app.close();
        });

        it("self-heals by resolving Mullion's own stale thread when its last ingested verdict was clean", async () => {
          const app = await buildApp();
          const { taskId } = await createDoneTaskWithPendingMerge(app);
          // Simulates round 2 already coming back clean, but the
          // verdict-time resolve attempt (processReviewingTasks) itself
          // failing (fetch error, truncation, mint failure) — the merge
          // sweep is the backstop that retries it.
          app.db
            .update(tasks)
            .set({ lastReviewVerdict: "clean" })
            .where(eq(tasks.id, taskId))
            .run();
          mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
          mockFetchPullRequestReviewThreads.mockResolvedValue({
            viewerLogin: "mullion-bot[bot]",
            threads: [
              {
                id: "thread-own",
                isResolved: false,
                comments: [
                  {
                    author: "mullion-reviewer[bot]",
                    createdAt: "2026-08-20T10:00:00Z",
                    path: "src/foo.ts",
                    line: 1,
                    body: "Fix this.",
                  },
                ],
              },
            ],
            truncated: false,
          });
          mockResolveMullionReviewLogins.mockResolvedValue(
            new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
          );

          await reconcileTasks(app);

          expect(mockResolveReviewThread).toHaveBeenCalledExactlyOnceWith("tok", "thread-own");
          // Independent review, round 3 — the diagnostic message below must
          // reuse the self-heal's own fetch rather than paying for a
          // second GraphQL round trip in the same tick.
          expect(mockFetchPullRequestReviewThreads).toHaveBeenCalledOnce();

          await app.close();
        });

        // Independent review, round 2 — the defect this test guards against:
        // `POST .../approve` and the closed-issue sync path both promote
        // "reviewing" straight to "done" on `canTransition` alone, never
        // consulting `lastReviewVerdict`. A human (or a closed issue) can
        // therefore reach "done" with a standing "changes-requested"
        // verdict still on the row. Self-healing in that case would
        // silently resolve Mullion's own unaddressed finding with zero
        // corroboration it was ever fixed — exactly the failure mode the
        // "clean verdict" gate exists to prevent.
        it("does NOT self-heal when the task's last ingested verdict was changes-requested", async () => {
          const app = await buildApp();
          const { taskId } = await createDoneTaskWithPendingMerge(app);
          app.db
            .update(tasks)
            .set({ lastReviewVerdict: "changes-requested" })
            .where(eq(tasks.id, taskId))
            .run();
          mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
          mockFetchPullRequestReviewThreads.mockResolvedValue({
            viewerLogin: "mullion-bot[bot]",
            threads: [
              {
                id: "thread-own",
                isResolved: false,
                comments: [
                  {
                    author: "mullion-reviewer[bot]",
                    createdAt: "2026-08-20T10:00:00Z",
                    path: "src/foo.ts",
                    line: 1,
                    body: "Fix this.",
                  },
                ],
              },
            ],
            truncated: false,
          });
          mockResolveMullionReviewLogins.mockResolvedValue(
            new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
          );

          await reconcileTasks(app);

          expect(mockResolveReviewThread).not.toHaveBeenCalled();
          const row = await getTask(app, taskId);
          expect(row.mergeError).toBe("Blocked on 1 unresolved review conversation");

          await app.close();
        });

        // Independent review, round 3 — a repo requiring BOTH an approval
        // AND conversation resolution can be "blocked" with the approval
        // requirement already satisfied (reviewDecision: "APPROVED") while
        // a stale conversation is the sole remaining cause. Treating
        // "APPROVED" as already-explained (the old behavior) would leave
        // exactly this combination on the generic, misleading message
        // forever.
        it("reports the unresolved-conversation cause even when reviewDecision is APPROVED", async () => {
          const app = await buildApp();
          const { taskId } = await createDoneTaskWithPendingMerge(app);
          mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
          mockGetPullRequestReviewDecision.mockResolvedValue("APPROVED");
          mockResolveReviewerToken.mockResolvedValue(null);
          mockFetchPullRequestReviewThreads.mockResolvedValue({
            viewerLogin: "mullion-bot[bot]",
            threads: [
              {
                id: "thread-human",
                isResolved: false,
                comments: [
                  {
                    author: "octocat",
                    createdAt: "2026-08-20T10:00:00Z",
                    path: "src/foo.ts",
                    line: 1,
                    body: "Please also fix this.",
                  },
                ],
              },
            ],
            truncated: false,
          });

          await reconcileTasks(app);

          const row = await getTask(app, taskId);
          expect(row.mergeError).toBe("Blocked on 1 unresolved review conversation");

          await app.close();
        });

        it("keeps the generic message when there are no unresolved threads at all", async () => {
          const app = await buildApp();
          const { taskId } = await createDoneTaskWithPendingMerge(app);
          mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
          mockFetchPullRequestReviewThreads.mockResolvedValue({
            viewerLogin: "mullion-bot[bot]",
            threads: [],
            truncated: false,
          });

          await reconcileTasks(app);

          const row = await getTask(app, taskId);
          expect(row.mergeError).toBe("Required checks are red or still pending");
          // Independent review, round 2 — with zero unresolved threads,
          // resolveMullionOwnThreadsIfClean's own cheap pre-filter must
          // skip the reviewer-identity lookup entirely, not just skip
          // resolving anything after paying for it.
          expect(mockResolveMullionReviewLogins).not.toHaveBeenCalled();

          await app.close();
        });

        it("fails closed (keeps the generic message) rather than trusting a truncated thread enumeration", async () => {
          const app = await buildApp();
          const { taskId } = await createDoneTaskWithPendingMerge(app);
          mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
          mockFetchPullRequestReviewThreads.mockResolvedValue({
            viewerLogin: "mullion-bot[bot]",
            threads: [],
            truncated: true,
          });

          await reconcileTasks(app);

          const row = await getTask(app, taskId);
          expect(row.mergeError).toBe(
            "Blocked on the PR, but its review threads couldn't be fully enumerated",
          );
          expect(mockResolveReviewThread).not.toHaveBeenCalled();

          await app.close();
        });

        it("keeps the generic message when the thread fetch itself fails", async () => {
          const app = await buildApp();
          const { taskId } = await createDoneTaskWithPendingMerge(app);
          mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
          mockFetchPullRequestReviewThreads.mockRejectedValue(new Error("GitHub is down"));

          await reconcileTasks(app);

          const row = await getTask(app, taskId);
          expect(row.mergeError).toBe("Required checks are red or still pending");

          await app.close();
        });
      });

      // Re-assert: `attemptMerge` only ever runs for `status: "done"` tasks
      // (this suite's own createDoneTaskWithPendingMerge), so every case
      // below already satisfies that half of the gate implicitly.
      it("re-asserts an APPROVE from the reviewer identity when a prior approval was dismissed", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");
        mockResolveReviewerToken.mockResolvedValue("reviewer_tok");
        mockCreatePullRequestReview.mockResolvedValue({
          id: 999,
          htmlUrl: "https://github.com/o/r/pull/9#pullrequestreview-999",
        });

        await reconcileTasks(app);

        expect(mockCreatePullRequestReview).toHaveBeenCalledWith("reviewer_tok", "o", "r", 9, {
          body: expect.any(String),
          commitId: "sha-head",
          event: "APPROVE",
        });
        expect(mockMergePullRequest).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        // No error recorded — the sweep re-classifies fresh state next tick
        // rather than surfacing a message this tick already knows is stale.
        expect(row.mergeError).toBeNull();

        await app.close();
      });

      // Hermes review, PR #827 (round 3): the round-2 memoization
      // (`lastReassertedSha`) was silently defeated by `processMergeRequests`
      // unconditionally overwriting the WHOLE `mergeRetryState` entry
      // (without spreading the prior one) immediately before every
      // `attemptMerge` call — so the re-assert-once-per-SHA guard never
      // actually survived past the tick that set it. This file otherwise
      // avoids `vi.useFakeTimers` (see the red-CI dedup describe block's own
      // comment on why), but that precedent is about *DB-backed* timestamps
      // having no fake-timer equivalent — this is a plain in-memory Map read
      // via `Date.now()`, which fake timers control directly. Scoped tightly
      // to this one test.
      it("does not repost the re-assert APPROVE on the next tick for an unchanged head SHA", async () => {
        const app = await buildApp();
        await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");
        mockResolveReviewerToken.mockResolvedValue("reviewer_tok");
        mockCreatePullRequestReview.mockResolvedValue({ id: 999, htmlUrl: "https://x" });

        vi.useFakeTimers();
        try {
          await reconcileTasks(app);
          expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);

          // Past MERGE_RETRY_TTL_MS's own per-task backoff, so this second
          // tick actually reaches attemptMerge again rather than being
          // skipped by the unrelated rate limiter — isolating the
          // memoization itself as what's under test.
          vi.setSystemTime(Date.now() + 61_000);
          await reconcileTasks(app);
        } finally {
          vi.useRealTimers();
        }

        // Still exactly once: the same head SHA (mockGetPullRequestByNumber
        // never changes it) must have been recognized as already
        // re-asserted, surviving processMergeRequests' own state write
        // between the two ticks.
        expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);

        await app.close();
      });

      // Hermes review, PR #827: re-assert used to also fire on
      // CHANGES_REQUESTED, which would silently override a review posted
      // AFTER the task's own approval (a human on GitHub, or a later
      // review-agent round) — exactly the "manufacture an approval nobody
      // made" failure mode this mechanism must never become. Pins that a
      // configured, working reviewer App does NOT change this outcome —
      // the earlier "no reviewer App configured" case above already
      // covered the message; this covers that the identity being available
      // doesn't matter for CHANGES_REQUESTED specifically.
      it("never re-asserts over CHANGES_REQUESTED even when a reviewer App is configured and working", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockGetPullRequestReviewDecision.mockResolvedValue("CHANGES_REQUESTED");
        mockResolveReviewerToken.mockResolvedValue("reviewer_tok");
        mockCreatePullRequestReview.mockResolvedValue({ id: 999, htmlUrl: "https://x" });

        await reconcileTasks(app);

        expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.mergeError).toContain("Changes were requested on the PR");

        await app.close();
      });

      it("does not re-assert when GitHub already reports APPROVED (no spin)", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockGetPullRequestReviewDecision.mockResolvedValue("APPROVED");
        mockResolveReviewerToken.mockResolvedValue("reviewer_tok");

        await reconcileTasks(app);

        expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        // Still "blocked" on GitHub's mergeable_state despite an APPROVED
        // review decision (e.g. a required CHECK, not a review, is what's
        // actually red) — falls through to the generic checks message.
        expect(row.mergeError).toContain("Required checks");

        await app.close();
      });

      it("does not re-assert, and reports the specific message, when no reviewer App is configured", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");
        mockResolveReviewerToken.mockResolvedValue(null);

        await reconcileTasks(app);

        expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.mergeError).toContain("Waiting on a required approving review");

        await app.close();
      });

      it("falls back to recording the message when the re-assert attempt itself fails", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");
        mockResolveReviewerToken.mockResolvedValue("reviewer_tok");
        mockCreatePullRequestReview.mockRejectedValue(new Error("HTTP 422"));

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeError).toContain("Waiting on a required approving review");

        await app.close();
      });
    });

    it("waits with no error recorded while GitHub is still computing mergeability (mergeable: null)", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: null, mergeableState: "unknown" }),
      );

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).not.toBeNull();
      expect(row.mergeError).toBeNull();

      await app.close();
    });

    it("clears the merge flag idempotently when the PR was already merged out of band", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ merged: true, state: "closed" }));

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).toBeNull();
      expect(row.mergeError).toBeNull();

      await app.close();
    });

    // Hermes review, PR #763 — clearMergeState must drop the task's
    // mergeRetryState entry, not just the DB flag. Proved indirectly: a
    // fresh merge request for the SAME task right after resolution is
    // attempted on the very next tick rather than being suppressed by a
    // leftover backoff entry from the resolved attempt.
    it("re-attempts a fresh merge request immediately after a prior resolution, not backed off by a stale entry", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValueOnce(mockPr({ merged: true, state: "closed" }));

      await reconcileTasks(app);
      let row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).toBeNull();

      app.db.update(tasks).set({ mergeRequestedAt: new Date() }).where(eq(tasks.id, taskId)).run();
      mockGetPullRequestByNumber.mockResolvedValueOnce(mockPr({ mergeableState: "dirty" }));

      await reconcileTasks(app);

      expect(mockGetPullRequestByNumber).toHaveBeenCalledTimes(2);
      row = await getTask(app, taskId);
      expect(row.mergeError).toContain("Conflicts with main");

      await app.close();
    });

    it("clears the merge flag idempotently when the PR was closed (not merged) out of band", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ merged: false, state: "closed" }));

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).toBeNull();
      expect(row.mergeError).toBeNull();

      await app.close();
    });

    it("records the failure and keeps retrying when the merge call itself throws (e.g. a 409 head-sha race)", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
      mockMergePullRequest.mockRejectedValue(
        new Error("GitHub API error (HTTP 409): Head branch was modified"),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).not.toBeNull();
      expect(row.mergeError).toContain("409");

      await app.close();
    });

    it("backs off after an attempt instead of retrying on every tick", async () => {
      const app = await buildApp();
      await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

      await reconcileTasks(app);
      await reconcileTasks(app);

      // Second tick lands well inside the 1-minute TTL — no second lookup.
      expect(mockGetPullRequestByNumber).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("does not attempt a merge while Task Master is disabled", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        await createDoneTaskWithPendingMerge(app);

        await reconcileTasks(app);

        expect(mockGetPullRequestByNumber).not.toHaveBeenCalled();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("does not touch a done task with no merge requested", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: `p-no-merge-${Math.random()}`, cwd: "/tmp" },
      });
      app.db
        .insert(tasks)
        .values({
          projectId: project.json().id,
          title: "done, no merge requested",
          status: "done",
          claimedAt: new Date(),
          completedAt: new Date(),
          prNumber: 9,
          prUrl: "https://github.com/o/r/pull/9",
        })
        .run();

      await reconcileTasks(app);

      expect(mockGetPullRequestByNumber).not.toHaveBeenCalled();
      await app.close();
    });

    it("#759 — does not attempt a merge while the install-wide GitHub rate-limit budget is in effect", async () => {
      const app = await buildApp();
      try {
        await createDoneTaskWithPendingMerge(app);
        recordGitHubRateLimit(Date.now() + 60_000);

        await reconcileTasks(app);

        expect(mockGetPullRequestByNumber).not.toHaveBeenCalled();
      } finally {
        resetGitHubRateLimitForTests();
        await app.close();
      }
    });
  });

  describe("autorelease sweep (#744 — processReleaseRequests + attemptMerge's own arming)", () => {
    const FOUND_WORKFLOW = {
      kind: "found" as const,
      workflow: { id: 2, name: "Release Please", path: ".github/workflows/release-please.yml" },
    };
    const RELEASE_PR_SUMMARY = {
      number: 42,
      htmlUrl: "https://github.com/o/r/pull/42",
      headRef: "release-please--branches--main",
      title: "chore(main): release 1.2.3",
    };
    function releasePr(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        number: 42,
        htmlUrl: "https://github.com/o/r/pull/42",
        nodeId: "PR_release",
        draft: false,
        headSha: "release-sha",
        headRef: "release-please--branches--main",
        baseRef: "main",
        title: "chore(main): release 1.2.3",
        state: "open",
        merged: false,
        mergeable: true,
        mergeableState: "clean",
        ...overrides,
      };
    }

    async function createProject(
      app: Awaited<ReturnType<typeof buildApp>>,
      autoTagRelease: boolean,
    ): Promise<number> {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: `p-release-${Math.random()}`, cwd: "/tmp" },
      });
      const projectId = project.json().id as number;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { autoTagRelease },
      });
      return projectId;
    }

    async function createDoneTaskWithPendingMerge(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      prNumber: number,
    ) {
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: `task-${prNumber}`,
          status: "done",
          claimedAt: new Date(),
          completedAt: new Date(),
          prNumber,
          prUrl: `https://github.com/o/r/pull/${prNumber}`,
          mergeRequestedAt: new Date(),
        })
        .returning()
        .all();
      return row.id;
    }

    // A releaseRequestedAt far enough in the past to already have cleared
    // processReleaseRequests' own RELEASE_QUIET_MS (10 minutes) — every
    // "acts now" test below needs this; the "still quiet" test below uses
    // `new Date()` instead.
    const PAST_QUIET_WINDOW = new Date(Date.now() - 11 * 60_000);

    async function createDoneTaskWithReleaseRequested(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      overrides: Partial<{ releaseRequestedAt: Date; prNumber: number }> = {},
    ) {
      const prNumber = overrides.prNumber ?? 9;
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: `released-${prNumber}`,
          status: "done",
          claimedAt: new Date(),
          completedAt: new Date(),
          prNumber,
          prUrl: `https://github.com/o/r/pull/${prNumber}`,
          releaseRequestedAt: overrides.releaseRequestedAt ?? PAST_QUIET_WINDOW,
        })
        .returning()
        .all();
      return row.id;
    }

    beforeEach(() => {
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
      mockResolveGitHubToken.mockResolvedValue("tok");
    });

    afterEach(() => {
      mockResolveRepoRef.mockImplementation(
        actualHostGitModule.resolveRepoRef as (...args: unknown[]) => unknown,
      );
      mockResolveGitHubToken.mockImplementation(actualGithubIntegrationModule.resolveGitHubToken);
      mockGetPullRequestByNumber.mockImplementation(actualGithubWriteModule.getPullRequestByNumber);
    });

    describe('arming (attemptMerge\'s own case "clean")', () => {
      it("arms releaseRequestedAt once the task's own PR merges, when autoTagRelease is on", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskId = await createDoneTaskWithPendingMerge(app, projectId, 9);
        mockGetPullRequestByNumber.mockResolvedValue(
          releasePr({ number: 9, headSha: "sha-head", title: "feat: do the thing" }),
        );
        mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
        mockDeleteRemoteBranch.mockResolvedValue(undefined);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeRequestedAt).toBeNull();
        expect(row.releaseRequestedAt).not.toBeNull();

        await app.close();
      });

      it("does NOT arm when autoTagRelease is off (the default)", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, false);
        const taskId = await createDoneTaskWithPendingMerge(app, projectId, 9);
        mockGetPullRequestByNumber.mockResolvedValue(releasePr({ number: 9 }));
        mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
        mockDeleteRemoteBranch.mockResolvedValue(undefined);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeRequestedAt).toBeNull();
        expect(row.releaseRequestedAt).toBeNull();

        await app.close();
      });

      it("does NOT arm on a PR closed without merging (already-done, not clean)", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskId = await createDoneTaskWithPendingMerge(app, projectId, 9);
        // classifyMergeReadiness collapses `state: "closed"` into
        // "already-done" the same as an actual merge — attemptMerge must not
        // arm a release for this, only for the "clean" branch.
        mockGetPullRequestByNumber.mockResolvedValue(
          releasePr({ number: 9, state: "closed", merged: false }),
        );

        await reconcileTasks(app);

        expect(mockMergePullRequest).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.mergeRequestedAt).toBeNull();
        expect(row.releaseRequestedAt).toBeNull();

        await app.close();
      });
    });

    describe("the sweep itself (processReleaseRequests)", () => {
      it("does nothing while inside the quiet window", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskId = await createDoneTaskWithReleaseRequested(app, projectId, {
          releaseRequestedAt: new Date(), // just landed — well inside the window
        });

        await reconcileTasks(app);

        expect(mockDetectReleaseWorkflow).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.releaseRequestedAt).not.toBeNull();

        await app.close();
      });

      it("merges the release PR once quiet, coalescing N armed tasks into ONE merge call", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskA = await createDoneTaskWithReleaseRequested(app, projectId, { prNumber: 10 });
        const taskB = await createDoneTaskWithReleaseRequested(app, projectId, { prNumber: 11 });
        mockDetectReleaseWorkflow.mockResolvedValue(FOUND_WORKFLOW);
        mockGetDefaultBranch.mockResolvedValue("main");
        mockFindReleasePullRequest.mockResolvedValue(RELEASE_PR_SUMMARY);
        mockGetPullRequestByNumber.mockResolvedValue(releasePr());
        mockMergePullRequest.mockResolvedValue({ merged: true, sha: "release-merged" });

        await reconcileTasks(app);

        expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
        expect(mockMergePullRequest).toHaveBeenCalledWith("tok", "o", "r", 42, {
          sha: "release-sha",
          commitTitle: "chore(main): release 1.2.3",
        });
        for (const taskId of [taskA, taskB]) {
          const row = await getTask(app, taskId);
          expect(row.releaseRequestedAt).toBeNull();
          expect(row.releaseError).toBeNull();
        }

        await app.close();
      });

      it("records the reason and keeps retrying when required checks are blocked", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskId = await createDoneTaskWithReleaseRequested(app, projectId);
        mockDetectReleaseWorkflow.mockResolvedValue(FOUND_WORKFLOW);
        mockGetDefaultBranch.mockResolvedValue("main");
        mockFindReleasePullRequest.mockResolvedValue(RELEASE_PR_SUMMARY);
        mockGetPullRequestByNumber.mockResolvedValue(releasePr({ mergeableState: "blocked" }));

        await reconcileTasks(app);

        expect(mockMergePullRequest).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.releaseRequestedAt).not.toBeNull();
        expect(row.releaseError).toContain("Required checks");

        await app.close();
      });

      it("clears the intent (but keeps the error visible) when the repo has no release-please workflow", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskId = await createDoneTaskWithReleaseRequested(app, projectId);
        mockDetectReleaseWorkflow.mockResolvedValue({ kind: "not-configured" });

        await reconcileTasks(app);

        expect(mockFindReleasePullRequest).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.releaseRequestedAt).toBeNull();
        expect(row.releaseError).toContain("no release-please workflow");

        await app.close();
      });

      it("ignores a project with autoTagRelease off even if a task somehow has releaseRequestedAt set", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, false);
        const taskId = await createDoneTaskWithReleaseRequested(app, projectId);

        await reconcileTasks(app);

        expect(mockDetectReleaseWorkflow).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.releaseRequestedAt).not.toBeNull();

        await app.close();
      });
    });
  });

  describe("auto-approve sweep (processAutoApprovals)", () => {
    // Every field an auto-approve candidate needs already set — mirrors
    // exactly what processReviewingTasks' own ingestion write leaves
    // behind for a "clean" verdict. Individual tests override just the
    // field(s) they're testing.
    async function createAutoApproveCandidate(
      app: Awaited<ReturnType<typeof buildApp>>,
      overrides: Partial<{
        lastReviewVerdict: string | null;
        reviewFindingsIngestedSessionId: number | null;
        prNumber: number | null;
        autoApprove: boolean;
        worktreePath: string | null;
        agentCommand: string | null;
        autoReturnRounds: number;
        sessionId: number | null;
        lastPrReviewCommentAt: Date | null;
      }> = {},
    ) {
      const { autoApprove = true, ...taskOverrides } = overrides;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: `p-auto-approve-${Math.random()}`, cwd: "/tmp" },
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

    function mockPr(overrides: Partial<Record<string, unknown>> = {}) {
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

    function ciRun(conclusion: "success" | "failure") {
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

    beforeEach(() => {
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
      mockResolveGitHubToken.mockResolvedValue("tok");
    });

    // Same reasoning as the merge sweep's own afterEach above — restore the
    // pass-through defaults so this block's fake values can't leak into an
    // unrelated later test.
    afterEach(() => {
      mockResolveRepoRef.mockImplementation(
        actualHostGitModule.resolveRepoRef as (...args: unknown[]) => unknown,
      );
      mockResolveGitHubToken.mockImplementation(actualGithubIntegrationModule.resolveGitHubToken);
      mockGetPullRequestByNumber.mockImplementation(actualGithubWriteModule.getPullRequestByNumber);
      mockPromoteTaskToPR.mockImplementation(actualTaskPromoteModule.promoteTaskToPR);
      mockFetchRequiredStatusContexts.mockResolvedValue(null);
      mockFetchCheckRunsForHead.mockResolvedValue([]);
    });

    it("auto-approves once the latest verdict is clean and CI reads success", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockPromoteTaskToPR.mockResolvedValueOnce({
        ok: true,
        prUrl: "https://github.com/o/r/pull/9",
        prNumber: 9,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("done");
      expect(row.prUrl).toBe("https://github.com/o/r/pull/9");

      await app.close();
    });

    it("records the transition via 'auto-approve', distinct from a human's 'approve'", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockPromoteTaskToPR.mockResolvedValueOnce({
        ok: true,
        prUrl: "https://github.com/o/r/pull/9",
        prNumber: 9,
      });
      const infoSpy = vi.spyOn(app.log, "info");

      await reconcileTasks(app);

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, via: "auto-approve" }),
        "task transition",
      );

      await app.close();
    });

    it("does not approve when the project's autoApprove is off", async () => {
      const app = await buildApp();
      await createAutoApproveCandidate(app, { autoApprove: false });

      await reconcileTasks(app);

      expect(mockGetPullRequestByNumber).not.toHaveBeenCalled();

      await app.close();
    });

    it("does not approve while Task Master is disabled", async () => {
      const app = await buildApp();
      try {
        await createAutoApproveCandidate(app);
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });

        await reconcileTasks(app);

        expect(mockGetPullRequestByNumber).not.toHaveBeenCalled();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    // #755 — the CI fetch is now hoisted ABOVE these gates (so a red
    // REQUIRED check can return the task even when one of them would
    // otherwise block forever, see the dedicated describe block below), so
    // `getPullRequestByNumber` genuinely IS called now, unlike before #755.
    // CI is mocked to "success" here — `attemptReturnRedCiToWorker`'s own
    // very first check is `current.status !== "failure"`, so a passing CI
    // status makes it a no-op immediately and these tests still isolate
    // exactly the gate they're named for.
    it("does not approve when no review round has been ingested yet", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app, {
        reviewFindingsIngestedSessionId: null,
      });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");

      await app.close();
    });

    it("does not approve on a stale ingested verdict from an earlier review round", async () => {
      const app = await buildApp();
      const { taskId, projectId } = await createAutoApproveCandidate(app);
      // Simulates a fresh review round spawned after the ingested one —
      // reviewSessionId has moved on, but reviewFindingsIngestedSessionId
      // (and the "clean" verdict it produced) still point at the OLD round.
      const freshSession = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      app.db
        .update(tasks)
        .set({ reviewSessionId: freshSession.json().id })
        .where(eq(tasks.id, taskId))
        .run();
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");

      await app.close();
    });

    it.each(["changes-requested", "inconclusive"])(
      "does not approve on a '%s' verdict",
      async (verdict) => {
        const app = await buildApp();
        const { taskId } = await createAutoApproveCandidate(app, { lastReviewVerdict: verdict });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

        await reconcileTasks(app);

        expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");

        await app.close();
      },
    );

    it("waits (does not approve) while CI is still in progress", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue([
        {
          name: "CI",
          status: "in_progress",
          conclusion: null,
          htmlUrl: "https://x/1",
          headSha: "sha-head",
        },
      ]);

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");

      await app.close();
    });

    // Also #755's fail-closed default in action: mockFetchRequiredStatusContexts
    // resolves to `null` (this describe block's own beforeEach) here, same as
    // a real 403/404 — the red-CI-return gate must not fire on a "don't know"
    // any more than the pre-existing approve gate below it does.
    it("waits (does not approve) while CI status is red", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("failure"));

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");

      await app.close();
    });

    // #755 — a red REQUIRED check returns the task to its worker for one
    // automatic round, the same mechanism a "changes-requested" review uses.
    // Fresh-review finding on an earlier version of this PR: the required
    // set (`required_status_checks.contexts`) and `fetchRunsForHead` live in
    // two DIFFERENT GitHub API namespaces — Workflow Run names (`"CI/CD"`,
    // `"CodeQL"`) vs. per-job Check Run names (`"test-node /
    // lint-and-test"`) — verified live against this repo's own protected
    // branch. Every test below deliberately uses DISTINCT, non-matching
    // names for the two, exactly like this repo's real CI, so a regression
    // back to comparing the wrong namespace fails loudly instead of passing
    // by coincidence the way the original (buggy) version of these tests did.
    describe("red required CI returns the task to the worker (#755)", () => {
      async function createRedCiCandidate(
        app: Awaited<ReturnType<typeof buildApp>>,
        overrides: Parameters<typeof createAutoApproveCandidate>[1] = {},
      ) {
        const candidate = await createAutoApproveCandidate(app, {
          worktreePath: "/tmp",
          agentCommand: "claude",
          ...overrides,
        });
        const workerSession = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId: candidate.projectId, command: "bash" },
        });
        app.db
          .update(tasks)
          .set({ sessionId: workerSession.json().id })
          .where(eq(tasks.id, candidate.taskId))
          .run();
        return candidate;
      }

      // The Workflow Run layer — only used for the coarse "is anything red
      // at all" pre-filter (`current.status !== "failure"`), never compared
      // against `requiredContexts` directly (that would be this bug again).
      function workflowRun(name: string, conclusion: "success" | "failure") {
        return [
          {
            name,
            status: "completed" as const,
            conclusion,
            htmlUrl: "https://x/1",
            headSha: "sha-head",
          },
        ];
      }

      // The Check Run layer — THIS is what's actually compared against
      // `requiredContexts`.
      function checkRun(name: string, conclusion: "success" | "failure") {
        return [{ name, conclusion }];
      }

      it("returns the task when a REQUIRED check fails", async () => {
        const app = await buildApp();
        const { taskId } = await createRedCiCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
        mockFetchRequiredStatusContexts.mockResolvedValue(["test-node / lint-and-test"]);
        mockFetchCheckRunsForHead.mockResolvedValue(
          checkRun("test-node / lint-and-test", "failure"),
        );

        await reconcileTasks(app);

        expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.autoReturnRounds).toBe(1);
        expect(row.lastAutoReturnReason).toBe("ci");

        await app.close();
      });

      it("does NOT return the task when the red check is not in the required set (this repo's own test-e2e)", async () => {
        const app = await buildApp();
        const { taskId } = await createRedCiCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
        mockFetchRequiredStatusContexts.mockResolvedValue(["test-node / lint-and-test"]);
        // "test-e2e" is red, but it's not in the required set above —
        // exactly this repo's own real branch protection.
        mockFetchCheckRunsForHead.mockResolvedValue([
          { name: "test-node / lint-and-test", conclusion: "success" },
          { name: "test-e2e", conclusion: "failure" },
        ]);

        await reconcileTasks(app);

        expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnRounds).toBe(0);

        await app.close();
      });

      it("does not fetch check runs at all when the coarse Workflow Run status isn't red (avoids an extra GitHub call on the common green path)", async () => {
        const app = await buildApp();
        await createRedCiCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "success"));

        await reconcileTasks(app);

        expect(mockFetchCheckRunsForHead).not.toHaveBeenCalled();

        await app.close();
      });

      it("returns the task even with no review agent configured (gate 2 would otherwise never pass)", async () => {
        const app = await buildApp();
        const { taskId } = await createRedCiCandidate(app, {
          reviewFindingsIngestedSessionId: null,
          lastReviewVerdict: null,
        });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
        mockFetchRequiredStatusContexts.mockResolvedValue(["test-node / lint-and-test"]);
        mockFetchCheckRunsForHead.mockResolvedValue(
          checkRun("test-node / lint-and-test", "failure"),
        );

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.lastAutoReturnReason).toBe("ci");

        await app.close();
      });

      it("returns the task even when the verdict is inconclusive (gate 3 would otherwise never pass)", async () => {
        const app = await buildApp();
        const { taskId } = await createRedCiCandidate(app, { lastReviewVerdict: "inconclusive" });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
        mockFetchRequiredStatusContexts.mockResolvedValue(["test-node / lint-and-test"]);
        mockFetchCheckRunsForHead.mockResolvedValue(
          checkRun("test-node / lint-and-test", "failure"),
        );

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.lastAutoReturnReason).toBe("ci");

        await app.close();
      });

      it("posts a cap-reached comment and stays in 'reviewing' once the round budget is spent", async () => {
        const app = await buildApp();
        const { taskId } = await createRedCiCandidate(app, { autoReturnRounds: 2 });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
        mockFetchRequiredStatusContexts.mockResolvedValue(["test-node / lint-and-test"]);
        mockFetchCheckRunsForHead.mockResolvedValue(
          checkRun("test-node / lint-and-test", "failure"),
        );

        await reconcileTasks(app);

        expect(mockCreatePullRequestReview).toHaveBeenCalledWith(
          "tok",
          "o",
          "r",
          9,
          expect.objectContaining({ body: expect.stringContaining("round cap (2)") }),
        );
        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnRounds).toBe(2);
        // Issue #1038 — this trigger has no other durable write to
        // piggyback the announcement on, so it needs its own; assert it
        // actually landed.
        expect(row.autoReturnCapAnnouncedAt).not.toBeNull();

        await app.close();
      });

      // Note: `ciCapCommentedRounds`'s dedup ALSO covers a LATER tick, once
      // `autoApproveRetryState`'s own ~30s-to-30min backoff has elapsed and
      // this task becomes eligible for another attempt — that direction
      // isn't meaningfully exercisable here without fake timers, which this
      // file deliberately never uses (time here is faked via backdated DB
      // timestamps, not `vi.useFakeTimers`, and there's no DB-backed clock
      // for an in-memory `Map`). The test below covers what CAN be tested
      // with this file's existing tooling: the dedup is keyed per-task, not
      // shared/global — a mis-keying bug (e.g. accidentally keying on the
      // round number alone) would under-post across different tasks in the
      // very same tick, which needs no elapsed time to observe.
      it("keys the cap-reached dedup per task, not globally — two different capped tasks in the same tick both get a comment", async () => {
        const app = await buildApp();
        await createRedCiCandidate(app, { autoReturnRounds: 2 });
        await createRedCiCandidate(app, { autoReturnRounds: 2 });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
        mockFetchRequiredStatusContexts.mockResolvedValue(["test-node / lint-and-test"]);
        mockFetchCheckRunsForHead.mockResolvedValue(
          checkRun("test-node / lint-and-test", "failure"),
        );

        await reconcileTasks(app);

        expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(2);

        await app.close();
      });

      it("does not return the task when the project's autoApprove is off", async () => {
        const app = await buildApp();
        const { taskId } = await createRedCiCandidate(app, { autoApprove: false });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
        mockFetchRequiredStatusContexts.mockResolvedValue(["test-node / lint-and-test"]);
        mockFetchCheckRunsForHead.mockResolvedValue(
          checkRun("test-node / lint-and-test", "failure"),
        );

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnRounds).toBe(0);

        await app.close();
      });
    });

    // #757 — new GitHub PR review comments on unresolved threads (excluding
    // Mullion's own review bot) send a "reviewing" task back to its worker
    // for one automatic round, same mechanism/cap as #755's red-CI-return.
    describe("new PR review comments return the task to the worker (#757)", () => {
      async function createPrCommentCandidate(
        app: Awaited<ReturnType<typeof buildApp>>,
        overrides: Parameters<typeof createAutoApproveCandidate>[1] = {},
      ) {
        const candidate = await createAutoApproveCandidate(app, {
          worktreePath: "/tmp",
          agentCommand: "claude",
          ...overrides,
        });
        const workerSession = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId: candidate.projectId, command: "bash" },
        });
        app.db
          .update(tasks)
          .set({ sessionId: workerSession.json().id })
          .where(eq(tasks.id, candidate.taskId))
          .run();
        return candidate;
      }

      function thread(
        isResolved: boolean,
        author: string | null,
        body: string,
        createdAt: string,
        path: string | null = "src/foo.ts",
        line: number | null = 42,
      ) {
        return {
          isResolved,
          comments: [{ author, createdAt, path, line, body }],
        };
      }

      it("returns the task when a new unresolved review comment arrives", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
          truncated: false,
        });

        await reconcileTasks(app);

        expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.autoReturnRounds).toBe(1);
        expect(row.lastAutoReturnReason).toBe("pr-comment");
        expect(row.lastPrReviewCommentAt?.toISOString()).toBe("2026-08-20T10:00:00.000Z");

        await app.close();
      });

      it("does NOT return the task when the thread is resolved", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [thread(true, "octocat", "Already resolved.", "2026-08-20T10:00:00Z")],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnRounds).toBe(0);

        await app.close();
      });

      it("does NOT return the task for a comment already covered by the cursor", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app, {
          lastPrReviewCommentAt: new Date("2026-08-20T10:00:00Z"),
        });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          // Same timestamp as the cursor — not newer than it.
          threads: [thread(false, "octocat", "Already answered.", "2026-08-20T10:00:00Z")],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnRounds).toBe(0);

        await app.close();
      });

      it("filters out Mullion's own review comments (matching viewerLogin) — no round for its own output", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [thread(false, "mullion-bot[bot]", "My own findings.", "2026-08-20T10:00:00Z")],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnRounds).toBe(0);

        await app.close();
      });

      // D0 — a live dry run (2026-08-27) confirmed this exact gap: a
      // gating review round's own findings post from the REVIEWER App
      // (#737/#827), a distinct login from `viewerLogin` above (which is
      // the caller's own, primary-token identity). Before this fix, the
      // filter above missed comments authored by that second identity
      // entirely — Mullion re-ingested its own still-unresolved round-1
      // finding as if a human had posted it, burning an auto-return round
      // on the same tick a clean follow-up verdict landed.
      it("also filters out comments authored by the reviewer App's own login, not just the primary identity", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [
            thread(
              false,
              "mullion-reviewer[bot]",
              "My own gating finding.",
              "2026-08-20T10:00:00Z",
            ),
          ],
          truncated: false,
        });
        mockResolveMullionReviewLogins.mockResolvedValue(
          new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
        );

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnRounds).toBe(0);
        expect(row.lastPrReviewCommentAt).toBeNull();

        await app.close();
      });

      // Round 2, self-review: the test above only proves the two-identity
      // set doesn't UNDER-filter (misses the reviewer App). This proves the
      // companion direction — a two-member `mullionLogins` set must not
      // OVER-filter a genuine human comment sitting alongside a bot one on
      // the same PR, which a mis-scoped `mullionLogins.has()` check could
      // plausibly do without any test catching it.
      it("still returns the task for a genuine human comment even when the reviewer App's own comment is also present", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [
            thread(
              false,
              "mullion-reviewer[bot]",
              "My own gating finding.",
              "2026-08-20T10:00:00Z",
            ),
            thread(false, "octocat", "Please also fix this.", "2026-08-20T10:05:00Z"),
          ],
          truncated: false,
        });
        mockResolveMullionReviewLogins.mockResolvedValue(
          new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
        );

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.autoReturnRounds).toBe(1);
        expect(row.lastAutoReturnReason).toBe("pr-comment");
        expect(row.lastPrReviewCommentAt).toEqual(new Date("2026-08-20T10:05:00Z"));

        await app.close();
      });

      it("returns the task even with no review agent configured (gate 2 would otherwise never pass)", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app, {
          reviewFindingsIngestedSessionId: null,
          lastReviewVerdict: null,
        });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.lastAutoReturnReason).toBe("pr-comment");

        await app.close();
      });

      it("returns the task even when the verdict is inconclusive (gate 3 would otherwise never pass)", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app, {
          lastReviewVerdict: "inconclusive",
        });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.lastAutoReturnReason).toBe("pr-comment");

        await app.close();
      });

      it("posts a cap-reached comment and stays in 'reviewing' once the round budget is spent", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app, { autoReturnRounds: 2 });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
          truncated: false,
        });

        await reconcileTasks(app);

        expect(mockCreatePullRequestReview).toHaveBeenCalledWith(
          "tok",
          "o",
          "r",
          9,
          expect.objectContaining({ body: expect.stringContaining("round cap (2)") }),
        );
        // Issue #1038 — same reasoning as the red-CI cap test above: its
        // own CAS'd write, no other durable write to piggyback on.
        expect((await getTask(app, taskId)).autoReturnCapAnnouncedAt).not.toBeNull();

        // A second tick with the SAME (unchanged) comments must not post a
        // second cap-reached comment — deduped per round, same as #755's.
        await reconcileTasks(app);
        expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);

        await app.close();
      });

      // Fresh review, PR #784 — attemptReturnPrCommentsToWorker resolves
      // its own repoRef/token independently of attemptAutoApprove's own CI
      // lookup specifically so a REST-side failure (this repo's own
      // getPullRequestByNumber, a different rate-limit bucket than
      // GraphQL) doesn't also block PR-comment ingestion. Only a test that
      // combines BOTH a thrown CI lookup AND a pending new comment can
      // catch a regression back to the early `return` this fix removed.
      it("still returns the task for a new PR comment even when the CI lookup itself throws", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app);
        mockGetPullRequestByNumber.mockRejectedValue(new Error("network blip"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.lastAutoReturnReason).toBe("pr-comment");

        await app.close();
      });

      // Fresh review, PR #784 — resolveGitHubToken must be called with the
      // SAME scope postReviewFindingsComment itself uses ("write", not
      // "read"): an installation predating the "read" scope's permissions
      // 422s a read-scoped mint specifically and falls back to the shared
      // PAT, while a write-scoped mint for that SAME installation still
      // succeeds against the App — so a read-scoped call here could
      // resolve `viewerLogin` to a genuinely different identity than the
      // one that actually posts Mullion's own review comments, silently
      // breaking the self-comment filter below. Pinned directly rather
      // than only via the filtering tests above, which can't distinguish
      // "the right scope was requested" from "the mock happened to return
      // a consistent viewerLogin regardless of scope."
      it("resolves the GitHub token with 'write' scope, matching postReviewFindingsComment's own", async () => {
        const app = await buildApp();
        await createPrCommentCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
          truncated: false,
        });

        await reconcileTasks(app);

        expect(mockResolveGitHubToken).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          "write",
        );

        await app.close();
      });

      it("filters a self-authored comment out of a result that also has a genuine human one, and still returns the task for the human comment", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          // The self-authored comment is the NEWER of the two, deliberately
          // — if the self-filter were broken (comparing the wrong field, or
          // applied after the newest-timestamp computation instead of
          // before it), the cursor would land on 11:00, not 10:00, and this
          // assertion would actually catch it. Making the human comment the
          // newer one (as an earlier version of this test did) can't tell
          // "the filter worked" apart from "Math.max just picked the newer
          // of the two either way."
          threads: [
            thread(false, "mullion-bot[bot]", "My own findings.", "2026-08-20T11:00:00Z"),
            thread(false, "octocat", "A genuine human comment.", "2026-08-20T10:00:00Z"),
          ],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.lastAutoReturnReason).toBe("pr-comment");
        // The cursor reflects only the genuine (non-self) comment's
        // timestamp — proves the self comment was excluded before the
        // newest-timestamp computation, not just before the round-trigger
        // decision.
        expect(row.lastPrReviewCommentAt?.toISOString()).toBe("2026-08-20T10:00:00.000Z");

        await app.close();
      });

      it("advances the cursor to the NEWEST comment across multiple unresolved threads, not the first", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [
            thread(false, "octocat", "Older comment.", "2026-08-20T08:00:00Z"),
            thread(false, "octocat", "Newest comment.", "2026-08-20T12:00:00Z"),
            thread(false, "octocat", "Middle comment.", "2026-08-20T10:00:00Z"),
          ],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.lastPrReviewCommentAt?.toISOString()).toBe("2026-08-20T12:00:00.000Z");

        await app.close();
      });
    });

    it("waits forever (no deadline) when no CI is found at all — unlike the review-spawn gate", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue([]);

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");

      await app.close();
    });

    it("backs off and retries when the CI lookup itself throws", async () => {
      const app = await buildApp();
      await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockRejectedValue(new Error("network blip"));

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();

      await app.close();
    });

    it("does not treat a concurrent human approve/reject (cas-lost) as an error", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      // Simulates a human's reject landing while promoteTaskToPR's own
      // network call is still in flight.
      mockPromoteTaskToPR.mockImplementationOnce(async () => {
        app.db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, taskId)).run();
        return { ok: true, prUrl: "https://github.com/o/r/pull/9", prNumber: 9 };
      });

      await expect(reconcileTasks(app)).resolves.toBeUndefined();

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");

      await app.close();
    });

    it("backs off after an attempt instead of re-checking CI on every tick", async () => {
      const app = await buildApp();
      await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("failure"));

      await reconcileTasks(app);
      await reconcileTasks(app);

      // Second tick lands well inside the 1-minute TTL — no second lookup.
      expect(mockGetPullRequestByNumber).toHaveBeenCalledTimes(1);

      await app.close();
    });

    // Hermes review, PR #768 — attemptAutoApprove's switch on
    // ApproveOutcome's failure reasons originally omitted "no-worktree"
    // entirely (no case, no default), so it fell through silently: no log,
    // no named disposition, directly contradicting the function's own
    // "every reason needs a named disposition" contract. Proves the task
    // stays in "reviewing" (retried, not marked failed) and that the
    // disposition is now actually logged.
    it("backs off and logs on a 'no-worktree' promotion failure, instead of falling through silently", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockPromoteTaskToPR.mockResolvedValueOnce({
        ok: false,
        reason: "no-worktree",
        detail: "Task has no worktree to promote",
      });
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, reason: "no-worktree" }),
        "task reconcile: auto-approve attempt failed — retrying",
      );

      await app.close();
    });

    it("#759 — does not attempt an auto-approve while the install-wide GitHub rate-limit budget is in effect", async () => {
      const app = await buildApp();
      try {
        await createAutoApproveCandidate(app);
        recordGitHubRateLimit(Date.now() + 60_000);

        await reconcileTasks(app);

        expect(mockFetchRunsForHead).not.toHaveBeenCalled();
      } finally {
        resetGitHubRateLimitForTests();
        await app.close();
      }
    });
  });

  // #722's investigation (task 213765) — a `stop_failure` (rate-limit,
  // quota) produces the exact same "phase: done" -> derived.status:
  // "finished" signal as a real completion. These prove the "-> reviewing"
  // transition now verifies the branch actually has commits before firing,
  // and that a stale finish latch (the reject snap-back, RC5) can't fire it
  // either.
  describe("reviewing gate — commits ahead of base and finish-since-claim (#722)", () => {
    // Low-entropy on purpose (not a real commit hash) — a realistic-looking
    // 40-char hex string trips detect-secrets' hex-high-entropy heuristic.
    const BASE_SHA = "0000000111122223333444455556666777788889";

    async function createSessionAndTaskWithBase(
      app: Awaited<ReturnType<typeof buildApp>>,
      status: "claimed" | "in_progress",
      claimedAt: Date = new Date(),
    ) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: `p-gate-${Math.random()}`, cwd: "/tmp" },
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
          baseSha: BASE_SHA,
        })
        .returning()
        .all();
      return { taskId: row.id, sessionId };
    }

    function gitStatus(hash: string | null, isClean: boolean, files: unknown[] = []) {
      return {
        ok: true,
        value: {
          isRepo: true,
          status: { branch: "mullion/task-999", hash, ahead: 0, behind: 0, files, isClean },
        },
      };
    }

    it("fails the task, salvages a WIP commit, and terminates the session when HEAD is still at baseSha", async () => {
      const app = await buildApp();
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId, sessionId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      // "0000000" is a prefix of BASE_SHA — HEAD hasn't moved since claim.
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));
      mockCommitWipChanges.mockResolvedValue({ committed: true });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("no commits");
      expect(row.failureReason).toContain("mullion/task-999");
      expect(mockCommitWipChanges).toHaveBeenCalledWith("/tmp/mullion-task-worktree");
      expect(terminateSpy).toHaveBeenCalledWith(String(sessionId));
      // #772 — killSession, not a bare backend.terminate: the session row
      // itself must flip to "killed", not linger "active" until the 30s
      // exited-session reconciler eventually marks it "exited".
      const { sessions } = await import("../../src/db/schema.js");
      const [sessionRow] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      expect(sessionRow.status).toBe("killed");

      await app.close();
    });

    it("still fails the task (best-effort posture) when the WIP salvage commit itself fails", async () => {
      const app = await buildApp();
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));
      mockCommitWipChanges.mockResolvedValue({ committed: false, error: "git add -u failed" });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("no commits");

      await app.close();
    });

    it("still advances to reviewing when the tree is dirty but the branch has commits ahead of base (blast-radius regression)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      // Different hash from BASE_SHA — real commits exist, tree just has a
      // stray scratch file (files.length > 0 -> isClean: false).
      mockResolveHostGitStatus.mockResolvedValue(
        gitStatus("abcdef1", false, [{ path: "scratch.txt" }]),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(mockCommitWipChanges).not.toHaveBeenCalled();

      await app.close();
    });

    it("advances to reviewing when clean and ahead of base (unchanged happy path)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

      await reconcileTasks(app);

      expect((await getTask(app, taskId)).status).toBe("reviewing");
      await app.close();
    });

    it("fails open (advances to reviewing) when the git-status check itself is unresolvable", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue({ ok: false, reason: "unsupported" });

      await reconcileTasks(app);

      expect((await getTask(app, taskId)).status).toBe("reviewing");
      await app.close();
    });

    // Independent review, PR #726 — checkReviewingGate itself IS proxied for
    // a #484-capable remote host (resolveHostGitStatus works there), but
    // failReviewingGate's salvage commit is local-only. Firing the gate
    // without the salvage would fail the task, terminate its session, and
    // leave the tree dirty — worse than pre-#722 behavior for a
    // remote-hosted task. The whole gate stays fail-open for remote hosts
    // until a remote salvage-commit proxy exists.
    it("fails open (advances to reviewing) for a remote-hosted task, without even checking git status", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-remote-gate", cwd: "/remote/project", hostId },
      });
      const projectId = project.json().id;
      // Inserted directly, not via POST /api/sessions (same reasoning as
      // the "does not trust reviewSeedDelivered:true..." test above — this
      // fake host isn't actually reachable, so a real spawn attempt 502s).
      const [workerSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .all();
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "t",
          status: "in_progress",
          sessionId: workerSession.id,
          claimedAt: new Date(),
          startedAt: new Date(),
          worktreePath: "/remote/project",
          branchName: "mullion/task-999",
          baseSha: BASE_SHA,
        })
        .returning()
        .all();

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        spawn: vi.fn().mockResolvedValue({}),
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSession.id)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        isMasterAlive: vi.fn().mockResolvedValue({}),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
      };
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);
      // Would trigger the no-commits failure if the gate actually ran.
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", true));

      await reconcileTasks(app);

      const updated = await getTask(app, row.id);
      expect(updated.status).toBe("reviewing");
      expect(mockResolveHostGitStatus).not.toHaveBeenCalled();

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    // The former "applies the same no-commits gate on the claimed ->
    // reviewing edge" sibling of this describe block was deleted (task-claim
    // queueing, rate-limit-storm fix) — that edge no longer exists, and this
    // block's own in_progress-based no-commits-gate coverage above
    // ("still fails the task... when the WIP salvage commit itself fails")
    // already exercises the identical assertion via the one edge that
    // remains.

    // RC5 — the reject snap-back: derived.status === "finished" is a LATCH
    // on lastTurnEndedAt, not an edge. A task rejected back to "in_progress"
    // whose worker session is still alive keeps its OLD, pre-reject latch —
    // without this guard, the very next tick would re-derive "finished" and
    // snap it straight back to "reviewing" before a human ever gets a
    // chance to type feedback into the terminal.
    it("does not snap an in_progress task back to reviewing when the finish latch predates this claim spell (reject snap-back)", async () => {
      const app = await buildApp();
      const claimedAt = new Date();
      const { taskId } = await createSessionAndTask(app, "in_progress", claimedAt);
      const staleLastTurnEndedAt = claimedAt.getTime() - 60_000;
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: staleLastTurnEndedAt }),
      } as never);

      await reconcileTasks(app);
      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();

      await app.close();
    });

    it("advances normally once the finish signal postdates the claim spell", async () => {
      const app = await buildApp();
      const claimedAt = new Date();
      const { taskId } = await createSessionAndTask(app, "in_progress", claimedAt);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      expect((await getTask(app, taskId)).status).toBe("reviewing");
      await app.close();
    });
  });

  describe("review-findings loop (processReviewingTasks)", () => {
    // Only the given session ids report "finished" — every other id (in
    // particular a worker session freshly re-spawned by THIS SAME
    // reconcileTasks() call's own processReviewingTasks pass, before the
    // claimed/in_progress loop's own SELECT runs) reports plain idle
    // silence. A blanket "everyone is finished" mock would make that
    // brand-new session look already-finished too, and the claimed/
    // in_progress loop — which reads its rows AFTER processReviewingTasks
    // runs, in the same call — would immediately flip it straight back to
    // "reviewing" a second time, a false cascade this mock exists to avoid
    // (a real freshly-spawned session has no Stop hook fired yet).
    function mockFinishedSessionIds(app: Awaited<ReturnType<typeof buildApp>>, ...ids: number[]) {
      const finished = new Set(ids.map(String));
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              finished.has(String(id)) ? fakeInfo({ lastTurnEndedAt: Date.now() }) : fakeInfo(),
          }) as never,
      );
    }

    async function claimIntoReviewing(
      app: Awaited<ReturnType<typeof buildApp>>,
      reviewAgent: string,
    ) {
      // "in_progress", not "claimed" — task-claim queueing (rate-limit-storm
      // fix) removed the claimed -> reviewing edge; this helper's whole job
      // is getting a task INTO "reviewing" via reconcileTasks below, so it
      // needs to start somewhere that edge still exists.
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "in_progress",
        reviewAgent,
      );
      // createSessionAndTaskWithReviewAgent (shared with the review-agent
      // describe block above) never sets agentCommand — a real claim always
      // does (task-claim.ts). reseedTaskIfSessionExited's own guard
      // silently no-ops without it, so it must be set here for the
      // auto-return path this describe block actually exercises. Must be a
      // seed-capable command (not e.g. "bash", which matches no hook
      // adapter) — Hermes review, PR #576's shouldAutoReturn gate now
      // requires commandSupportsSeed(task.agentCommand) too.
      app.db.update(tasks).set({ agentCommand: "codex" }).where(eq(tasks.id, taskId)).run();
      mockFinishedSessionIds(app, workerSessionId);
      await reconcileTasks(app);
      const row = await getTask(app, taskId);
      const reviewSessionId = row.reviewSessionId as number;
      // From here on, only the REVIEW session (not any later re-spawned
      // worker session) reports finished — see this function's own doc
      // comment above.
      mockFinishedSessionIds(app, reviewSessionId);
      return { taskId, workerSessionId, reviewSessionId };
    }

    function writeFindings(
      app: Awaited<ReturnType<typeof buildApp>>,
      taskId: number,
      round: number,
      content: string,
    ) {
      const findingsPath = taskReviewFindingsPath(
        path.dirname(app.pty.hookSocketPath),
        taskId,
        round,
      );
      fs.writeFileSync(findingsPath, content);
    }

    // Doubles as the freeform/legacy-text regression test: this findings
    // file is plain text, not JSON, so it only reaches this behavior via
    // parseReviewFindings's tolerant fallback to `changes-requested` (see
    // that function's own doc comment in task-prompt.ts). If a future
    // change ever narrowed the fallback verdict, this is the test that
    // would catch it — tied here explicitly so a failure points at the
    // right place.
    it("ingests non-empty freeform findings (parsed as changes-requested via the tolerant fallback), appends them, and auto-returns to in_progress exactly once", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, "Fix the null check on line 42.");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.reviewFindings).toContain("Fix the null check on line 42.");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      // The worker session was force-terminated and replaced — nobody was
      // watching the idle survivor to type the findings in themselves.
      expect(row.sessionId).not.toBe(workerSessionId);
      expect(row.sessionId).not.toBeNull();

      await app.close();
    });

    // Task Master trial 220921 / PR #743's incident — a "finished" review
    // session with no findings file yet must NOT be ingested as
    // inconclusive the instant that's observed: the review prompt now asks
    // the agent to run the repo's whole verification gate before writing
    // anything, so a few minutes of silence is normal. Only once the
    // review SESSION (not the current turn) has been alive past
    // REVIEW_FINDINGS_GRACE_MS is a still-missing file treated as
    // genuinely absent — see that constant's own doc comment.
    it("does NOT ingest a 'finished' review with no findings file yet — still within the grace window", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId } = await claimIntoReviewing(app, "codex");
      // Deliberately no writeFindings call, and the review session was just
      // created by claimIntoReviewing above — well within the grace window.

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toBeNull();
      expect(row.reviewFindingsIngestedSessionId).toBeNull();
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // The regression guard this whole PR exists for: task 220921 / PR
    // #743's real incident — a review agent's genuine `verdict: "clean"`
    // file landed 21 seconds after a tick had already observed "finished"
    // with no file yet. Before this PR, that first tick would have latched
    // `reviewFindingsIngestedSessionId` immediately and permanently,
    // making the real file (written on tick 2 here) unreadable forever.
    it("ingests the REAL findings file on a later tick, after an earlier tick observed 'finished' with no file yet", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");

      // Tick 1 — "finished", no file yet, still within the grace window:
      // must NOT latch anything (pinned by the test just above too).
      await reconcileTasks(app);
      const afterTick1 = await getTask(app, taskId);
      expect(afterTick1.reviewFindings).toBeNull();
      expect(afterTick1.reviewFindingsIngestedSessionId).toBeNull();

      // The real review finishes its work and writes its verdict — this is
      // the "21 seconds later" moment from the actual incident.
      writeFindings(app, taskId, 0, JSON.stringify({ verdict: "clean", summary: "All good." }));

      // Tick 2 — the SAME review session, now with a real file on disk.
      await reconcileTasks(app);
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toContain("All good.");
      expect(row.reviewFindings).not.toContain("inconclusive");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // D1 — a live dry run (2026-08-27) confirmed this exact deadlock: a
    // "clean" verdict ingests fine, but Mullion's own anchored finding from
    // an earlier round left a GitHub review thread unresolved, and nothing
    // in the codebase ever resolved it — `attemptMerge` then read
    // `mergeable_state: "blocked"` forever, even with green CI. This is the
    // fix's corroboration bound: a "clean" verdict resolves Mullion's own
    // remaining unresolved threads, but never a human's.
    describe("resolves Mullion's own review threads on a clean verdict (D1)", () => {
      beforeEach(() => {
        mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
        mockResolveGitHubToken.mockResolvedValue("tok");
      });

      afterEach(() => {
        mockResolveRepoRef.mockImplementation(
          actualHostGitModule.resolveRepoRef as (...args: unknown[]) => unknown,
        );
        mockResolveGitHubToken.mockImplementation(actualGithubIntegrationModule.resolveGitHubToken);
      });

      it("resolves a thread authored by Mullion's own reviewer identity, never a human's", async () => {
        const app = await buildApp();
        const { taskId } = await claimIntoReviewing(app, "codex");
        app.db.update(tasks).set({ prNumber: 9 }).where(eq(tasks.id, taskId)).run();
        writeFindings(app, taskId, 0, JSON.stringify({ verdict: "clean", summary: "All good." }));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [
            {
              id: "thread-own",
              isResolved: false,
              comments: [
                {
                  author: "mullion-reviewer[bot]",
                  createdAt: "2026-08-20T10:00:00Z",
                  path: "src/foo.ts",
                  line: 1,
                  body: "Fix this.",
                },
              ],
            },
            {
              id: "thread-human",
              isResolved: false,
              comments: [
                {
                  author: "octocat",
                  createdAt: "2026-08-20T10:00:00Z",
                  path: "src/foo.ts",
                  line: 2,
                  body: "Also fix this.",
                },
              ],
            },
          ],
          truncated: false,
        });
        mockResolveMullionReviewLogins.mockResolvedValue(
          new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
        );

        await reconcileTasks(app);

        expect(mockResolveReviewThread).toHaveBeenCalledExactlyOnceWith("tok", "thread-own");
        expect(mockResolveReviewThread).not.toHaveBeenCalledWith("tok", "thread-human");
        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("clean");

        await app.close();
      });

      it("does not attempt to resolve anything on a changes-requested verdict", async () => {
        const app = await buildApp();
        const { taskId } = await claimIntoReviewing(app, "codex");
        app.db
          .update(tasks)
          .set({ prNumber: 9, agentCommand: "codex" })
          .where(eq(tasks.id, taskId))
          .run();
        writeFindings(
          app,
          taskId,
          0,
          JSON.stringify({
            verdict: "changes-requested",
            summary: "Needs work.",
            findings: [{ path: "src/foo.ts", line: 1, severity: "blocker", body: "Fix this." }],
          }),
        );

        await reconcileTasks(app);

        expect(mockFetchPullRequestReviewThreads).not.toHaveBeenCalled();
        expect(mockResolveReviewThread).not.toHaveBeenCalled();

        await app.close();
      });

      it("does not attempt to resolve anything on an inconclusive verdict (a crashed reviewer confirms nothing)", async () => {
        const app = await buildApp();
        const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
        app.db.update(tasks).set({ prNumber: 9 }).where(eq(tasks.id, taskId)).run();
        // No writeFindings call at all — the grace window elapsing with no
        // file is what produces "inconclusive" (see the dedicated test
        // above this describe block).
        const { sessions } = await import("../../src/db/schema.js");
        await app.db
          .update(sessions)
          .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
          .where(eq(sessions.id, reviewSessionId));

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("inconclusive");
        expect(mockFetchPullRequestReviewThreads).not.toHaveBeenCalled();
        expect(mockResolveReviewThread).not.toHaveBeenCalled();

        await app.close();
      });

      // Independent review, round 3 — ownership must be judged across
      // EVERY comment in a thread, not just the first. A thread that
      // started as Mullion's own finding but later got a human reply
      // pushing back inside it must stay unresolved: auto-resolving on
      // comments[0] alone would dismiss that human objection right along
      // with the original finding.
      it("does not resolve a thread Mullion started if a human later replied inside it", async () => {
        const app = await buildApp();
        const { taskId } = await claimIntoReviewing(app, "codex");
        app.db.update(tasks).set({ prNumber: 9 }).where(eq(tasks.id, taskId)).run();
        writeFindings(app, taskId, 0, JSON.stringify({ verdict: "clean", summary: "All good." }));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [
            {
              id: "thread-contested",
              isResolved: false,
              comments: [
                {
                  author: "mullion-reviewer[bot]",
                  createdAt: "2026-08-20T10:00:00Z",
                  path: "src/foo.ts",
                  line: 1,
                  body: "Fix this.",
                },
                {
                  author: "octocat",
                  createdAt: "2026-08-20T10:05:00Z",
                  path: "src/foo.ts",
                  line: 1,
                  body: "Disagree, this is intentional.",
                },
              ],
            },
          ],
          truncated: false,
        });
        mockResolveMullionReviewLogins.mockResolvedValue(
          new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
        );

        await reconcileTasks(app);

        expect(mockResolveReviewThread).not.toHaveBeenCalled();

        await app.close();
      });
    });

    it("records an inconclusive entry once the grace window elapses with still no findings file", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      // Deliberately no writeFindings call — the prompt now tells the agent
      // to ALWAYS write the file, so a missing one can no longer be read as
      // a confident "clean" review; it's reported as inconclusive instead,
      // once the review session has been alive long enough that the file
      // genuinely isn't coming.
      const { sessions } = await import("../../src/db/schema.js");
      await app.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(sessions.id, reviewSessionId));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("inconclusive");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // Hermes review, PR #754 — grace-elapsed alone must not be enough for a
    // session that's demonstrably still doing something. A genuinely slow
    // verification-gate run (severity "busy": working/compacting/subagent/
    // background) past 30 minutes is not a hung session; ingesting it as
    // inconclusive would permanently latch reviewFindingsIngestedSessionId
    // out from under a real verdict that's still coming — new-vs-main
    // behavior main never had (main never ingested a still-active session
    // at all), and the exact dead end this PR exists to fix, just
    // relocated to the 30-minute mark.
    it("does NOT ingest past the grace window while the session is still actively working", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({ activity: "working" })
                : fakeInfo(),
          }) as never,
      );
      const { sessions } = await import("../../src/db/schema.js");
      await app.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(sessions.id, reviewSessionId));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toBeNull();
      expect(row.reviewFindingsIngestedSessionId).toBeNull();
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // The genuinely-stuck counterpart to the "still working" test above —
    // a session that's gone quiet (never latched "finished," not
    // "working"/"busy" either) past the grace window IS treated as
    // "nothing more is coming," but with wording that doesn't falsely
    // claim it "finished" (Hermes review, PR #754's other finding).
    it("ingests past the grace window with a third, non-'finished' wording when the session has gone quiet without ever finishing", async () => {
      const app = await buildApp();
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () => (String(id) === String(reviewSessionId) ? fakeInfo() : fakeInfo()),
          }) as never,
      );
      const { sessions } = await import("../../src/db/schema.js");
      await app.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(sessions.id, reviewSessionId));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toContain("produced no findings file within the expected time");
      expect(row.reviewFindings).not.toContain("finished but wrote no findings file");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);

      await app.close();
    });

    // The regression guard Change 1 exists for. Under the old "a findings
    // file means act on it" rule, always writing a file (this prompt's own
    // change) would have made a clean review indistinguishable from one
    // requesting changes — auto-returning and burning the task's one round
    // on a worker that has nothing to fix.
    it("does NOT auto-return, and stays in reviewing, when the review agent's JSON verdict is clean", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(
        app,
        taskId,
        0,
        JSON.stringify({
          verdict: "clean",
          summary: "Reviewed the diff and ran the test suite; no issues found.",
        }),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("no issues found");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    it("auto-returns exactly once, and renders anchored findings, when the review agent's JSON verdict is changes-requested", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(
        app,
        taskId,
        0,
        JSON.stringify({
          verdict: "changes-requested",
          summary: "One errcheck failure.",
          findings: [
            {
              path: "cmd/branchdam/main_test.go",
              line: 669,
              body: "occupied.Close()'s error return is unchecked.",
            },
          ],
        }),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.reviewFindings).toContain("cmd/branchdam/main_test.go:669");
      expect(row.reviewFindings).toContain("error return is unchecked");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).not.toBe(workerSessionId);

      await app.close();
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
        payload: { createDir: true, name: "p-bounded", cwd: "/tmp" },
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
          autoReturnRounds: 2,
          worktreePath: "/tmp",
          agentCommand: "claude",
          claimedAt: new Date(),
        })
        .returning()
        .all();
      mockFinishedSessionIds(app, reviewSession.json().id);
      writeFindings(app, task.id, 2, "A third-round finding, arriving after the cap.");

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(2);
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
        payload: { createDir: true, name: "p-bounded-clean", cwd: "/tmp" },
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
          autoReturnRounds: 2,
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
      writeFindings(app, task.id, 2, JSON.stringify({ verdict: "clean", summary: "All good." }));

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(2);
      expect(row.lastReviewVerdict).toBe("clean");
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
        payload: { createDir: true, name: "p-bounded-anchored", cwd: "/tmp" },
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
          autoReturnRounds: 2,
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
        2,
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
          body: expect.stringContaining("round cap (2)"),
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
    // own anchored inline comment — autonomous-pr-review §5, and the whole
    // point of the "review-body" render mode. `tasks.reviewFindings` (the
    // task detail drawer's own record, asserted via `row.reviewFindings`
    // below) intentionally keeps the bullet form — nothing there is
    // anchored to anything.
    it("renders the PR review body with a per-section anchor count, not repeated path:line prose", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "p-review-body-anchors", cwd: "/tmp" },
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
    it("auto-returns for a second round under the default cap (2)", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "p-second-round", cwd: "/tmp" },
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
        payload: { createDir: true, name: "p-low-cap", cwd: "/tmp" },
      });
      const projectId = project.json().id;
      app.db
        .update(projects)
        .set({ maxAutoReturnRounds: 1 })
        .where(eq(projects.id, projectId))
        .run();
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
    // THIS process's own local sessionsDir, and reading local-only for a
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
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-remote-review", cwd: "/remote/project", hostId },
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
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-remote-review-ok", cwd: "/remote/project", hostId },
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
      expect(row.lastReviewVerdict).toBe("clean");
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
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-remote-review-readfail", cwd: "/remote/project", hostId },
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
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-remote-review-absent", cwd: "/remote/project", hostId },
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

    // Hermes review, PR #576, finding #2 — a review agent that ends its
    // process right after its turn (instead of staying running) derives
    // "exited", not "finished". Accepting "exited" unconditionally would
    // also ingest a session a human killed, or one that crashed, as a false
    // "no findings" — only accept it when a findings file actually exists.
    describe("a review session that derives 'exited' instead of 'finished'", () => {
      it("still ingests its findings when the findings file exists", async () => {
        const app = await buildApp();
        const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
        writeFindings(app, taskId, 0, "Found via an agent that exited right after its turn.");
        vi.spyOn(app.pty, "get").mockImplementation(
          (id: string) =>
            ({
              toInfo: () =>
                String(id) === String(reviewSessionId)
                  ? fakeInfo({ endedReason: "process-exit", exitCode: 0 })
                  : fakeInfo(),
            }) as never,
        );
        const [reviewSessionRow] = app.db
          .update(sessions)
          .set({ status: "exited" })
          .where(eq(sessions.id, reviewSessionId))
          .returning()
          .all();
        expect(reviewSessionRow.status).toBe("exited");

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.reviewFindings).toContain("exited right after its turn");
        expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);

        await app.close();
      });

      // Task Master trial 220921 / PR #743's fix, PR 4 of 4 — "exited" is
      // now an unconditional usable signal (see `isUsableSignal`'s own doc
      // comment in task-reconciler.ts): a session that has genuinely exited
      // can't write anything more no matter how long is waited, so there's
      // nothing to gain by NOT ingesting it. This closes a pre-existing gap
      // this test used to pin the OPPOSITE of: a killed/crashed session
      // with no findings file used to leave the task stalled in "reviewing"
      // silently forever, with no comment ever posted at all.
      it("IS ingested as inconclusive when no findings file exists for a killed/crashed session — no more silent-forever stall", async () => {
        const app = await buildApp();
        const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
        // Deliberately no writeFindings call.
        vi.spyOn(app.pty, "get").mockImplementation(
          (id: string) =>
            ({
              toInfo: () =>
                String(id) === String(reviewSessionId)
                  ? fakeInfo({ endedReason: "signal", exitCode: null })
                  : fakeInfo(),
            }) as never,
        );
        app.db
          .update(sessions)
          .set({ status: "killed" })
          .where(eq(sessions.id, reviewSessionId))
          .run();

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.reviewFindings).toContain("inconclusive");
        expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);

        await app.close();
      });
    });

    // Hermes review, PR #576, finding #5 — reseedTaskIfSessionExited delivers
    // the findings as an argv initial prompt only; a non-seed-capable worker
    // adapter (e.g. gemini, which has no adapter at all) would auto-return
    // to a fresh session with NO instructions, burning the task's one round
    // for nothing and leaving it to ride its budget out. Findings must
    // still be recorded/commented; only the auto-return itself is skipped.
    // (OpenCode used to be this test's example too, but it gained
    // `initialPromptArgs` — see hook-adapters/opencode.ts.)
    it("records and comments findings but does not auto-return when the worker's agent can't receive a seeded prompt", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      // gemini matches no adapter at all, so no initialPromptArgs — see
      // task-agent-resolve.ts's commandSupportsSeed.
      app.db.update(tasks).set({ agentCommand: "gemini" }).where(eq(tasks.id, taskId)).run();
      writeFindings(app, taskId, 0, "This should reach the drawer and the PR, not the worker.");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("should reach the drawer and the PR");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // Hermes review, PR #580 — accepting "exited" for ingestion (finding #2
    // of the PR #576 round) opened a narrower gap: a review agent that
    // crashes AFTER writing a partial findings file also derives "exited"
    // with a non-null file. Auto-returning on that signal would spend the
    // task's one round on a half-written review. Only a genuine "finished"
    // may drive auto-return; "exited" is ingest-and-comment only.
    it("ingests and comments an 'exited' review session's findings but does NOT spend the auto-return round on them", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, "Possibly a partial review — the agent crashed right after.");
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({ endedReason: "process-exit", exitCode: 1 })
                : fakeInfo(),
          }) as never,
      );
      app.db
        .update(sessions)
        .set({ status: "exited" })
        .where(eq(sessions.id, reviewSessionId))
        .run();

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("Possibly a partial review");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // Coverage gap flagged in this PR's own review: every other "exited"
    // test above uses freeform text, which the tolerant fallback always
    // parses as changes-requested — none of them actually exercise a
    // genuine JSON `verdict: "clean"` on a non-"finished" session. Auto-
    // return is already gated on `derived.status === "finished"`
    // independent of the verdict, so this can't currently misfire — this
    // test pins that guarantee explicitly rather than leaving it implicit.
    it("ingests and comments a JSON 'clean' verdict from an exited review session, and does not auto-return", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(
        app,
        taskId,
        0,
        JSON.stringify({ verdict: "clean", summary: "Looked clean right before the crash." }),
      );
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({ endedReason: "process-exit", exitCode: 0 })
                : fakeInfo(),
          }) as never,
      );
      app.db
        .update(sessions)
        .set({ status: "exited" })
        .where(eq(sessions.id, reviewSessionId))
        .run();

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("Looked clean right before the crash.");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // Hermes review, PR #580 — autoReturnRounds is spent in the same CAS that
    // flips status to in_progress, before the re-seed's own outcome is
    // known. A re-seed failure (terminate/spawn error, or a lost race —
    // see reseedTaskIfSessionExited's own doc comment) previously left the
    // task's one auto-return round permanently spent with nobody having
    // received the findings.
    //
    // Issue #973 — `status` now rolls back to "reviewing" alongside the
    // round, not just the round: task 258971 (PR #136) shows why leaving it
    // at "in_progress" (pointing at a `sessionId` this same call just failed
    // to replace) is dangerous, not just cosmetically wrong — a later,
    // unrelated session-death detection for that stale session flipped the
    // task straight to "failed" with a misleading reason.
    it("rolls back the spent auto-return round AND status when the re-seed itself fails", async () => {
      const app = await buildApp();
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, "This should not cost the task its one round.");
      mockReseedTaskIfSessionExited.mockResolvedValueOnce(false);
      const warnSpy = vi.spyOn(app.log, "warn");
      const infoSpy = vi.spyOn(app.log, "info");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("should not cost the task its one round");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      // Fresh subagent review, PR #774 — a rolled-back attempt means no
      // auto-return round actually completed, so lastAutoReturnReason must
      // roll back to whatever it was before too (null, here), not linger
      // at "review" for a round that never happened.
      expect(row.lastAutoReturnReason).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, rolledBack: true }),
        expect.stringContaining("rolled back the spent auto-return round"),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, from: "in_progress", to: "reviewing", via: "reconcile" }),
        "task transition",
      );

      await app.close();
    });

    // Issue #973 — the CAS above (`status = "in_progress"`) is a real
    // semantic change, not just a tighter guard: this is the scenario it
    // exists for. task 258971's actual incident was a session-death
    // detection racing this exact rollback and flipping status to "failed"
    // out from under it. Simulates that race by mutating the row's status
    // out from under the rollback, inside the re-seed mock — mirroring
    // session-reconciler.ts's session-death handler landing between the
    // forward CAS and this rollback. The rollback CAS must lose (status
    // stays "failed", not resurrected to "reviewing") and must NOT spend
    // the round back onto a task nobody is tracking as "reviewing" anymore.
    it("does not resurrect a task a concurrent transition already moved off in_progress", async () => {
      const app = await buildApp();
      const { taskId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, "Findings that already got recorded.");
      mockReseedTaskIfSessionExited.mockImplementationOnce(async () => {
        app.db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, taskId)).run();
        return false;
      });
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.autoReturnRounds).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, rolledBack: false }),
        expect.stringContaining("rolled back the spent auto-return round"),
      );

      await app.close();
    });
  });

  // #738 follow-up — the review-agent spawn moved out of the "→ reviewing"
  // transition into its own pass (processPendingReviewSpawns), gated on CI
  // reaching a terminal state for the task's PR head commit. These tests
  // exercise that pass directly rather than through the review-agent
  // describe block above, whose every existing test relies on there being
  // no PR (so resolveReviewCi short-circuits to `undefined` and the spawn
  // still fires in the same tick as the transition) — deliberately
  // unchanged behavior, not something this new pass needed to touch.
  describe("CI-gated review spawn (processPendingReviewSpawns)", () => {
    // claimWithPR below configures mockResolveRepoRef/mockResolveGitHubToken/
    // mockGetPullRequestByNumber with a fake, persistent `.mockResolvedValue`
    // (not `Once`) so every task-under-test's own CI lookup resolves
    // deterministically. That's fine within a given test, but this file
    // shares ONE DB across its whole run with no per-test reset (module-level
    // comment above) — a task these tests leave behind (even a successfully
    // spawned one) can still get re-examined by an UNRELATED later test's own
    // broad `vi.spyOn(app.pty, "get")` mock, which would then hit these fake
    // "tok"/"o/r" values instead of the real (harmless, no-op) test-env
    // defaults, attempting a real GitHub call with fabricated credentials.
    // Restoring the pass-through default after every test in this block
    // keeps that fakery from outliving the test that needed it.
    afterEach(() => {
      mockResolveRepoRef.mockImplementation(
        actualHostGitModule.resolveRepoRef as (...args: unknown[]) => unknown,
      );
      mockResolveGitHubToken.mockImplementation(actualGithubIntegrationModule.resolveGitHubToken);
      mockGetPullRequestByNumber.mockImplementation(actualGithubWriteModule.getPullRequestByNumber);
    });

    // Local copy of the review-findings-loop describe block's own helper
    // above (not shared scope) — same "only the given ids are finished"
    // reasoning.
    function mockFinishedSessionIds(app: Awaited<ReturnType<typeof buildApp>>, ...ids: number[]) {
      const finished = new Set(ids.map(String));
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              finished.has(String(id)) ? fakeInfo({ lastTurnEndedAt: Date.now() }) : fakeInfo(),
          }) as never,
      );
    }

    async function claimWithPR(app: Awaited<ReturnType<typeof buildApp>>) {
      // "in_progress", not "claimed" — see claimIntoReviewing's own comment
      // above (task-claim queueing, rate-limit-storm fix removed the
      // claimed -> reviewing edge this helper relies on to reach "reviewing").
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "in_progress",
        "codex",
      );
      app.db.update(tasks).set({ prNumber: 9 }).where(eq(tasks.id, taskId)).run();
      // Targeted, not a blanket "every session is finished" mock (matching
      // mockFinishedSessionIds' own reasoning above): once a review session
      // spawns, a blanket mock would make IT look "finished" too on the
      // very next tick, dragging processReviewingTasks into ingesting it —
      // and since these tests' GitHub mocks resolve a real-looking repo/PR,
      // that pass would then attempt a REAL createPullRequestReview network
      // call. Only the worker session's id is ever "finished" here.
      mockFinishedSessionIds(app, workerSessionId);
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
      mockResolveGitHubToken.mockResolvedValue("tok");
      mockGetPullRequestByNumber.mockResolvedValue({
        number: 9,
        htmlUrl: "https://x/pull/9",
        nodeId: "n",
        draft: true,
        headSha: "sha1",
      });
      return { taskId, workerSessionId };
    }

    // Hermes review, PR #742 — a null status (no runs) waits exactly like
    // "in_progress" rather than spawning immediately. `openDraftPRForTask`
    // and this pass run in the SAME reconcile tick as the → reviewing
    // transition, so the very first lookup here lands within moments of the
    // push that created the head commit — GitHub's Actions runs for a
    // just-pushed commit routinely aren't registered yet, indistinguishable
    // at lookup time from "this repo has no CI at all." Spawning
    // immediately on that null would reproduce the exact #213782 incident
    // this whole change exists to prevent.
    it("waits when CI resolves to null (no runs yet) and before the deadline, then spawns once it's terminal on a later tick", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([]);

      await reconcileTasks(app);

      let row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewSpawnClaimedAt).toBeNull();

      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
      await reconcileTasks(app);

      row = await getTask(app, taskId);
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    it("spawns anyway once reviewCiWaitMinutes is exceeded, even while CI still resolves to null (no runs)", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: 0 } },
        });
        const { taskId } = await claimWithPR(app);
        mockFetchRunsForHead.mockResolvedValueOnce([]);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).not.toBeNull();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: -1 } },
        });
        await app.close();
      }
    });

    it("spawns in the same tick as the transition once CI is already terminal (failure)", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "failure",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    // Task Master trial 220921 / PR #743 — `unlinkFindingsFileIfPresent` used
    // to run only at INGEST time, so a leftover from a prior same-round
    // attempt (round-suffixed, not per-attempt — see
    // `taskReviewFindingsPath`'s own doc comment on why round-suffixing
    // alone doesn't cover this) would sit on disk until the NEXT review
    // agent's own turn ends, at which point it would be read as if it were
    // this fresh attempt's real output. `spawnReviewAgentNow` now unlinks it
    // before the fresh agent even starts, closing that window entirely.
    it("unlinks a stale round-N findings file at spawn time, before the fresh review agent writes anything", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      const sessionsDir = path.dirname(app.pty.hookSocketPath);
      const findingsPath = taskReviewFindingsPath(sessionsDir, taskId, 0);
      fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
      fs.writeFileSync(
        findingsPath,
        JSON.stringify({
          verdict: "clean",
          summary: "STALE — left over from a prior attempt at this same round.",
        }),
      );
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();
      expect(fs.existsSync(findingsPath)).toBe(false);

      await app.close();
    });

    it("waits while CI is in_progress and before the deadline, then spawns once it's terminal on a later tick", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        { name: "CI", status: "queued", conclusion: null, htmlUrl: "https://x/1", headSha: "sha1" },
      ]);

      await reconcileTasks(app);

      let row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewSpawnClaimedAt).toBeNull(); // never claimed — nothing to wait for is not the same as failed

      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
      await reconcileTasks(app);

      row = await getTask(app, taskId);
      expect(row.reviewSessionId).not.toBeNull();
      // The worker session itself is untouched by any of this — only the
      // review AGENT'S spawn was gated, not the worker's own completion.
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    it("spawns anyway once reviewCiWaitMinutes is exceeded, even while CI is still in_progress", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: 0 } },
        });
        const { taskId } = await claimWithPR(app);
        mockFetchRunsForHead.mockResolvedValueOnce([
          {
            name: "CI",
            status: "queued",
            conclusion: null,
            htmlUrl: "https://x/1",
            headSha: "sha1",
          },
        ]);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        // waitMinutes: 0 means "never wait" — `now - reviewingAt` is always
        // `>= 0`, so the deadline is already past on the very first check.
        expect(row.reviewSessionId).not.toBeNull();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: -1 } },
        });
        await app.close();
      }
    });

    // Hermes review, PR #742 (second pass) — a thrown lookup waits up to
    // the deadline exactly like `in_progress`/`null`, rather than spawning
    // without CI on the very first failure: a transient network blip or
    // GitHub not yet being consistent on the brand-new PR, in the exact
    // just-pushed window, is indistinguishable from "will succeed next
    // tick," and spawning immediately would reintroduce the #213782 gap.
    it("waits when the CI lookup itself throws and before the deadline, then spawns once it succeeds on a later tick", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockRejectedValueOnce(new Error("GitHub is down"));
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      let row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewSpawnClaimedAt).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
        expect.stringContaining("CI lookup for review spawn failed — waiting to retry"),
      );

      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
      await reconcileTasks(app);

      row = await getTask(app, taskId);
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    it("spawns without CI context once a persistently throwing CI lookup passes the wait deadline", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: 0 } },
        });
        const { taskId } = await claimWithPR(app);
        mockFetchRunsForHead.mockRejectedValueOnce(new Error("GitHub is down"));
        const warnSpy = vi.spyOn(app.log, "warn");

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).not.toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ taskId }),
          expect.stringContaining("still failing past the wait deadline"),
        );
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: -1 } },
        });
        await app.close();
      }
    });

    // The regression guard for the concurrency hazard splitting the spawn
    // out of the transition's own CAS introduced: a CI lookup is genuine
    // async work (unlike the old inline spawn, which ran inside the same
    // CAS'd write as the transition itself), so a human's Reject/Give-up/
    // Approve can land on this exact task while the lookup is still in
    // flight. The claim write's own CAS (re-checking status = "reviewing"
    // AND reviewSessionId/reviewSpawnClaimedAt IS NULL) must refuse rather
    // than spawn a reviewer for a task that's already moved on.
    it("refuses to spawn when a concurrent reject flips the task away from reviewing mid-CI-lookup", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockImplementationOnce(async () => {
        // Simulates a human's Reject landing on this exact task WHILE this
        // lookup is in flight — the same write routes/tasks.ts's own
        // reject handler makes, just fired synchronously here instead of
        // via a real concurrent request.
        app.db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, taskId)).run();
        return [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            htmlUrl: "https://x/1",
            headSha: "sha1",
          },
        ];
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress"); // the concurrent reject wins
      expect(row.reviewSessionId).toBeNull(); // no reviewer spawned for it

      await app.close();
    });

    it("clears the spawn claim on a failed spawn so the next tick retries, rather than leaving the task with no reviewer forever", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      // This test file shares one DB across every test (by design — see its
      // own module-level comment) and doesn't reset tasks between tests, so
      // an EARLIER test's own task can still be sitting in "reviewing" with
      // reviewSessionId null (e.g. "logs and swallows a review agent spawn
      // failure..." above, whose whole point is that its own failure is
      // never retried within its own single tick — but processPendingReviewSpawns
      // now retries it on every LATER test's tick too). A plain
      // `.mockResolvedValueOnce` on createSessionRecord would fail
      // whichever task's spawn call happens to run first in that pass's
      // `Promise.all`, not necessarily this test's own — so this scopes the
      // one-time failure to THIS test's own project id and delegates every
      // other call (including any leftover task's real retry) to the real
      // implementation.
      const projectId = (await getTask(app, taskId)).projectId;
      const sessionsModule = await import("../../src/services/session-lifecycle.js");
      const actualCreateSessionRecord = sessionsModule.createSessionRecord;
      let failedOnce = false;
      vi.spyOn(sessionsModule, "createSessionRecord").mockImplementation(async (a, opts) => {
        if (!failedOnce && opts.projectId === projectId) {
          failedOnce = true;
          return { ok: false, reason: "spawn-failed" };
        }
        return actualCreateSessionRecord(a, opts);
      });

      await reconcileTasks(app);

      let row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewSpawnClaimedAt).toBeNull();

      // Second tick — createSessionRecord runs for real this time.
      await reconcileTasks(app);

      row = await getTask(app, taskId);
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    // Regression guard — spawning a review agent used to be gated on
    // "enabled" only transitively, by riding along inside the (gated) →
    // reviewing transition's own write. Splitting the spawn into this
    // separate pass lost that transitive coverage; must be re-checked
    // explicitly, same posture as retryStrandedDraftPRs' own "does not
    // retry while Task Master is disabled" test above.
    it("does not spawn a review agent while Task Master is disabled, even for a task already in 'reviewing'", async () => {
      const app = await buildApp();
      let taskId: number | undefined;
      try {
        ({ taskId } = await claimWithPR(app));
        mockFetchRunsForHead.mockResolvedValueOnce([
          {
            name: "CI",
            status: "queued",
            conclusion: null,
            htmlUrl: "https://x/1",
            headSha: "sha1",
          },
        ]);
        await reconcileTasks(app); // -> reviewing; CI still in_progress, so nothing spawns yet either way

        let row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).toBeNull();

        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });

        await reconcileTasks(app);

        row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).toBeNull();
        // The gate must fire before any CI resolution work, not just before
        // the eventual spawn.
        expect(mockFetchRunsForHead).toHaveBeenCalledTimes(1);
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        // This task is deliberately left "reviewing" with reviewSessionId
        // still null by design (the whole point of this test) — unlike the
        // beforeEach sweep above (scoped to `prNumber IS NULL`), it has a
        // real prNumber and would otherwise survive into every later test's
        // shared DB, getting reprocessed by their own processPendingReviewSpawns
        // pass and consuming THEIR single-shot mockFetchRunsForHead queue
        // entries out from under them (see the module-level sharedDB
        // comment). Delete it rather than let it outlive this test.
        if (taskId !== undefined) {
          getDb().delete(tasks).where(eq(tasks.id, taskId)).run();
        }
        await app.close();
      }
    });

    // Regression guard for the gap the claim CAS alone doesn't close: it
    // protects the WRITE that claims the slot, but createSessionRecord
    // itself (a real spawn, possibly a network round-trip) is real async
    // work after that claim lands, during which Reject/Give-up/Approve can
    // still land — they CAS on `status` alone and know nothing of this
    // claim. The final write must re-check `status = "reviewing"` and
    // discard (kill) the now-orphaned session rather than recording it onto
    // a task that has moved on.
    it("kills the orphaned session when the task leaves 'reviewing' while its review agent is still spawning", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);

      const projectId = (await getTask(app, taskId)).projectId;
      const sessionsModule = await import("../../src/services/session-lifecycle.js");
      const actualCreateSessionRecord = sessionsModule.createSessionRecord;
      vi.spyOn(sessionsModule, "createSessionRecord").mockImplementation(async (a, opts) => {
        if (opts.projectId === projectId) {
          // Simulates a human's Reject landing on this exact task WHILE
          // this spawn's own I/O is in flight — the same write
          // routes/tasks.ts's own reject handler makes, just fired
          // synchronously here instead of via a real concurrent request.
          app.db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, taskId)).run();
        }
        return actualCreateSessionRecord(a, opts);
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress"); // the concurrent reject wins
      expect(row.reviewSessionId).toBeNull(); // never recorded onto a task that moved on
      expect(terminateSpy).toHaveBeenCalledWith(expect.any(String));
      // killSession, not a bare backend.terminate — the orphaned session's
      // own row must flip to "killed" too, or the exited-session reconciler
      // would later surface it as a crashed session with no task behind it.
      const [orphanedSession] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, Number(terminateSpy.mock.calls[0]?.[0])))
        .all();
      expect(orphanedSession?.status).toBe("killed");

      await app.close();
    });

    // Regression guard for the gap the `changes === 0` branch above doesn't
    // cover: a throw AFTER createSessionRecord already succeeded (a DB
    // error on the CAS update, or resolveSeedDelivered itself throwing)
    // used to fall into the generic `catch`, which only cleared the claim —
    // `result` was scoped inside the `try`, unreachable from there, so the
    // already-spawned session was never killed (Hermes review, PR #742).
    it("kills the orphaned session when a later step throws after createSessionRecord already succeeded", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);

      const taskAgentResolveModule = await import("../../src/services/task-agent-resolve.js");
      const resolveSeedDeliveredSpy = vi
        .spyOn(taskAgentResolveModule, "resolveSeedDelivered")
        .mockImplementation(() => {
          throw new Error("boom");
        });

      try {
        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).toBeNull(); // the throw happened before this write
        expect(row.reviewSpawnClaimedAt).toBeNull(); // cleared by the catch block
        expect(terminateSpy).toHaveBeenCalledWith(expect.any(String));
        const [orphanedSession] = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, Number(terminateSpy.mock.calls[0]?.[0])))
          .all();
        expect(orphanedSession?.status).toBe("killed");
      } finally {
        resolveSeedDeliveredSpy.mockRestore();
        // This task is deliberately left "reviewing" + reviewSessionId null
        // with a real prNumber — same shared-DB leak hazard as the
        // "disabled" test's own cleanup above.
        getDb().delete(tasks).where(eq(tasks.id, taskId)).run();
        await app.close();
      }
    });

    // Regression guard for a claim abandoned by a process crash/redeploy
    // between the claim write and either outcome — nothing else ever clears
    // reviewSpawnClaimedAt in that case, so without a staleness reclaim the
    // task would lose its reviewer forever.
    it("reclaims a review-spawn claim abandoned by a crashed prior attempt once it's stale", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        { name: "CI", status: "queued", conclusion: null, htmlUrl: "https://x/1", headSha: "sha1" },
      ]);
      // -> reviewing; CI still in_progress, so this tick never claims —
      // reviewSpawnClaimedAt starts genuinely null, not just unset.
      await reconcileTasks(app);
      expect((await getTask(app, taskId)).reviewSpawnClaimedAt).toBeNull();

      // Simulates a prior attempt's process dying right after claiming the
      // slot but before spawning or clearing it.
      app.db
        .update(tasks)
        .set({ reviewSpawnClaimedAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(tasks.id, taskId))
        .run();
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    it("does not reclaim a review-spawn claim that's still within the staleness window", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        { name: "CI", status: "queued", conclusion: null, htmlUrl: "https://x/1", headSha: "sha1" },
      ]);
      await reconcileTasks(app); // -> reviewing, waits on CI, never claimed

      app.db
        .update(tasks)
        .set({ reviewSpawnClaimedAt: new Date(Date.now() - 60_000) })
        .where(eq(tasks.id, taskId))
        .run();
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();

      // Same reasoning as the "disabled" test's own cleanup above: this
      // task is deliberately left "reviewing" + reviewSessionId null with a
      // real prNumber, which the beforeEach sweep (scoped to `prNumber IS
      // NULL`) won't catch — left behind, it'd be reprocessed by whichever
      // later test's reconcileTasks() call runs next, consuming THAT test's
      // own single-shot mockFetchRunsForHead queue entry out from under it.
      getDb().delete(tasks).where(eq(tasks.id, taskId)).run();
      await app.close();
    });
  });
});
