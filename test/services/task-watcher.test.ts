import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockListLabeledIssues = vi.hoisted(() => vi.fn());
const mockResolveGitHubToken = vi.hoisted(() => vi.fn());
const mockResolveRepoRef = vi.hoisted(() => vi.fn());
const mockGetStoredSettings = vi.hoisted(() => vi.fn());
const mockClaimTask = vi.hoisted(() => vi.fn());
const mockGetIssueState = vi.hoisted(() => vi.fn());
const mockSyncClosedIssueToLocal = vi.hoisted(() => vi.fn());
const mockSyncUnlabeledIssueToLocal = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/github.js", () => ({
  GitHubApiError: class extends Error {
    statusCode: number;
    constructor(m: string, code: number) {
      super(m);
      this.name = "GitHubApiError";
      this.statusCode = code;
    }
  },
  listLabeledIssues: mockListLabeledIssues,
}));

vi.mock("../../src/services/github-integration.js", () => ({
  // #489 — task-watcher.ts resolves its per-project token via
  // resolveGitHubToken(app, repoRef) now, not getToken(app) directly (the
  // App-token path needs the repo to decide whether an installation covers
  // it, falling back to the shared PAT — see github-integration.ts). The
  // mock's return value is used directly with `await`, which works fine on
  // a plain (non-Promise) value.
  resolveGitHubToken: mockResolveGitHubToken,
}));

// #484 — the ingest sweep resolves each project's repo via
// resolveRepoRef(app, {cwd, hostId}) now, not parseGitRemote(cwd) directly —
// that host-aware resolution is what makes the sweep reach a remote-hosted
// project's repo at all. Mocked at the same seam task-github-sync.test.ts
// already mocks it at.
vi.mock("../../src/services/github-webhook.js", () => ({
  resolveRepoRef: mockResolveRepoRef,
}));

vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: mockGetStoredSettings,
}));

vi.mock("../../src/services/task-claim.js", () => ({
  claimTask: mockClaimTask,
}));

// #490a — the read-back's unlabel half calls getIssueState directly and
// dispatches to syncUnlabeledIssueToLocal; both are mocked here so these
// tests exercise task-watcher.ts's own orchestration (which candidates get
// checked, the confirm-before-acting gate, the two independent caps) without
// re-exercising syncUnlabeledIssueToLocal's own decision logic — that's
// covered against a real DB in task-github-sync.test.ts. syncClosedIssueToLocal
// is mocked too so the pre-existing "closed" read-back path (unaffected by
// this file's earlier tests, which never populated trackedNonTerminal) stays
// isolated the same way.
vi.mock("../../src/services/github-write.js", () => ({
  getIssueState: mockGetIssueState,
}));
vi.mock("../../src/services/task-github-sync.js", () => ({
  syncClosedIssueToLocal: mockSyncClosedIssueToLocal,
  syncUnlabeledIssueToLocal: mockSyncUnlabeledIssueToLocal,
}));

import { startTaskWatcher } from "../../src/services/task-watcher.js";

interface InsertedTaskRow {
  projectId: number;
  issueNumber: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  status: string;
}

interface TrackedTaskRow {
  id: number;
  issueNumber: number;
  status: string;
}

function mockApp(
  rows: { id: number; cwd: string; hostId: string }[],
  inserted: InsertedTaskRow[],
  conflictConfigs: { set: object; where: unknown }[] = [],
  readyTasks: { id: number }[] = [],
  trackedNonTerminal: TrackedTaskRow[] = [],
): FastifyInstance {
  let nextInsertedId = 1;
  return {
    db: {
      // The ingest sweep's own project-discovery select (localProjectRows)
      // calls `.all()` directly with no `.where()` in its chain — that's
      // `rows`. Everything past `.where()` is told apart by the projection
      // passed to `select()`: a full-row `select()` (no args) is the
      // read-back's own trackedNonTerminal query; a `{id}`-projected
      // `select({id: ...})` is EITHER the auto-claim ready-tasks query
      // (`.all()`) or upsertIssueTask's existed-check (`.get()`) — those two
      // are told apart by which terminal method the caller invokes, since
      // neither of THEM ever calls the other's.
      select: (projection?: unknown) => ({
        from: () => ({
          all: () => rows,
          where: () => ({
            all: () => (projection === undefined ? trackedNonTerminal : readyTasks),
            // upsertIssueTask's existed-check — this mock always answers
            // "doesn't exist yet" (undefined), so every ingest in these
            // tests takes the fresh-insert path and gets a real
            // broadcastTaskEvent call (harmless no-op with zero WS
            // subscribers registered in this process).
            get: () => undefined,
          }),
        }),
      }),
      insert: () => ({
        values: (v: InsertedTaskRow) => {
          inserted.push(v);
          return {
            onConflictDoUpdate: (config: { set: object; where: unknown }) => {
              conflictConfigs.push(config);
              return {
                run: () => {},
                returning: () => ({ get: () => ({ id: nextInsertedId++ }) }),
              };
            },
          };
        },
      }),
    },
    log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: {
      MULLION_ROLE: "primary",
      MULLION_TASK_LABEL: "mullion-task",
      MULLION_TASK_POLL_INTERVAL: 60,
      MULLION_TASK_MASTER_ENABLED: true,
      MULLION_TASK_MAX_CONCURRENT: 2,
      MULLION_TASK_BUDGET_MINUTES: 120,
      MULLION_TASK_PROGRESS_COMMENT_MINUTES: 15,
    },
  } as unknown as FastifyInstance;
}

describe("startTaskWatcher", () => {
  beforeEach(() => {
    mockListLabeledIssues.mockReset();
    mockListLabeledIssues.mockResolvedValue([]);
    mockResolveGitHubToken.mockReset();
    mockResolveRepoRef.mockReset();
    mockResolveRepoRef.mockResolvedValue({ owner: "test-owner", repo: "test-repo" });
    mockGetStoredSettings.mockReset();
    mockGetStoredSettings.mockReturnValue({
      taskMaster: {
        autoClaimPaused: false,
        enabled: "inherit",
        maxConcurrent: -1,
        budgetMinutes: -1,
        progressCommentMinutes: -1,
      },
    });
    mockClaimTask.mockReset();
    mockClaimTask.mockResolvedValue({ ok: true });
    mockGetIssueState.mockReset();
    mockSyncClosedIssueToLocal.mockReset();
    mockSyncClosedIssueToLocal.mockResolvedValue(undefined);
    mockSyncUnlabeledIssueToLocal.mockReset();
    mockSyncUnlabeledIssueToLocal.mockResolvedValue(undefined);
  });

  it("starts interval immediately when no local projects exist", () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    const app = mockApp([], []);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    vi.advanceTimersByTime(60_000);
    expect(mockListLabeledIssues).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("skips polling when no GitHub token is configured", () => {
    mockResolveGitHubToken.mockReturnValue(null);
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];
    const app = mockApp(rows, []);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    vi.advanceTimersByTime(200_000);
    expect(mockListLabeledIssues).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("#484 — polls a remote-hosted project too, resolving its repo via resolveRepoRef(app, {cwd, hostId})", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    mockListLabeledIssues.mockResolvedValue([
      { number: 44, title: "Remote-hosted issue", body: null, htmlUrl: "https://x/44" },
    ]);
    const rows = [{ id: 1, cwd: "/tmp/remote", hostId: "agent-1" }];
    const inserted: InsertedTaskRow[] = [];
    const app = mockApp(rows, inserted);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    await vi.advanceTimersByTimeAsync(1);

    expect(mockResolveRepoRef).toHaveBeenCalledWith(app, { cwd: "/tmp/remote", hostId: "agent-1" });
    expect(mockListLabeledIssues).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      "mullion-task",
    );
    expect(inserted).toHaveLength(1);

    cleanup();
    vi.useRealTimers();
  });

  it("#484 — a remote-hosted project's unresolvable repo (not a GitHub repo, or its host is unreachable) is skipped with a debug log, never thrown", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    mockResolveRepoRef.mockResolvedValue(null);
    const rows = [{ id: 1, cwd: "/tmp/remote", hostId: "agent-1" }];
    const app = mockApp(rows, []);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    await vi.advanceTimersByTimeAsync(1);

    expect(mockListLabeledIssues).not.toHaveBeenCalled();
    expect(app.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, hostId: "agent-1" }),
      expect.stringContaining("could not resolve a GitHub repo"),
    );

    cleanup();
    vi.useRealTimers();
  });

  it("a local project's unresolvable repo (not a GitHub repo at all) is skipped silently — no debug log, that's the ordinary case", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    mockResolveRepoRef.mockResolvedValue(null);
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];
    const app = mockApp(rows, []);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    await vi.advanceTimersByTimeAsync(1);

    expect(mockListLabeledIssues).not.toHaveBeenCalled();
    expect(app.log.debug).not.toHaveBeenCalled();

    cleanup();
    vi.useRealTimers();
  });

  it("fetches labeled issues for a local project and inserts a ready task row per issue", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    mockListLabeledIssues.mockResolvedValue([
      { number: 42, title: "Fix the thing", body: "details", htmlUrl: "https://x/42" },
    ]);
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];
    const inserted: InsertedTaskRow[] = [];
    const app = mockApp(rows, inserted);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    await vi.advanceTimersByTimeAsync(1);

    expect(mockListLabeledIssues).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      "mullion-task",
    );
    expect(inserted).toEqual([
      {
        projectId: 1,
        issueNumber: 42,
        title: "Fix the thing",
        body: "details",
        htmlUrl: "https://x/42",
        status: "ready",
      },
    ]);

    cleanup();
    vi.useRealTimers();
  });

  it("inserts a Manual: true issue as backlog instead of ready", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    mockListLabeledIssues.mockResolvedValue([
      {
        number: 43,
        title: "Needs a human first",
        body: "Some spec text.\nManual: true\nMore text.",
        htmlUrl: "https://x/43",
      },
    ]);
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];
    const inserted: InsertedTaskRow[] = [];
    const app = mockApp(rows, inserted);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    await vi.advanceTimersByTimeAsync(1);

    expect(inserted).toEqual([expect.objectContaining({ issueNumber: 43, status: "backlog" })]);

    cleanup();
    vi.useRealTimers();
  });

  it("does not treat a body that merely mentions Manual: true in prose as opting out", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    mockListLabeledIssues.mockResolvedValue([
      {
        number: 44,
        title: "Discusses the convention",
        body: "Note: this repo uses a Manual: true convention for opt-out, see docs.",
        htmlUrl: "https://x/44",
      },
    ]);
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];
    const inserted: InsertedTaskRow[] = [];
    const app = mockApp(rows, inserted);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    await vi.advanceTimersByTimeAsync(1);

    expect(inserted).toEqual([expect.objectContaining({ issueNumber: 44, status: "ready" })]);

    cleanup();
    vi.useRealTimers();
  });

  it("passes a where clause to onConflictDoUpdate so an unchanged issue doesn't churn updatedAt (Hermes review, PR #471)", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    mockListLabeledIssues.mockResolvedValue([
      { number: 46, title: "Fix the thing", body: "details", htmlUrl: "https://x/46" },
    ]);
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];
    const inserted: InsertedTaskRow[] = [];
    const conflictConfigs: { set: object; where: unknown }[] = [];
    const app = mockApp(rows, inserted, conflictConfigs);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    await vi.advanceTimersByTimeAsync(1);

    expect(conflictConfigs).toHaveLength(1);
    // The where clause is what makes an unchanged issue a no-op update
    // (verified against real SQLite semantics separately) — this guards
    // against a future refactor silently dropping it and reintroducing
    // the every-poll updatedAt churn.
    expect(conflictConfigs[0].where).toBeDefined();
    expect(conflictConfigs[0].set).not.toHaveProperty("status");
    expect(conflictConfigs[0].set).not.toHaveProperty("boardOrder");

    cleanup();
    vi.useRealTimers();
  });

  it("skips a project whose repo can't be resolved", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    mockResolveRepoRef.mockResolvedValue(null);
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];
    const app = mockApp(rows, []);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockListLabeledIssues).not.toHaveBeenCalled();

    cleanup();
    vi.useRealTimers();
  });

  it("isolates a GitHub API error on one project so a sibling still gets polled", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    const { GitHubApiError } = await import("../../src/services/github.js");
    mockListLabeledIssues
      .mockRejectedValueOnce(new GitHubApiError("boom", 500))
      .mockResolvedValueOnce([]);
    const rows = [
      { id: 1, cwd: "/tmp/one", hostId: "local" },
      { id: 2, cwd: "/tmp/two", hostId: "local" },
    ];
    const app = mockApp(rows, []);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    await vi.advanceTimersByTimeAsync(2_001);

    expect(mockListLabeledIssues).toHaveBeenCalledTimes(2);
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
      expect.stringContaining("GitHub API error"),
    );

    cleanup();
    vi.useRealTimers();
  });

  describe("unlabel read-back (#490a)", () => {
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];

    it("confirms via getIssueState and syncs a ready task that lost its label", async () => {
      mockResolveGitHubToken.mockReturnValue("ghp_token");
      mockListLabeledIssues.mockResolvedValue([]); // issue 100 no longer open+labeled
      mockGetIssueState.mockResolvedValue({ state: "open", labels: [] });
      const app = mockApp(rows, [], [], [], [{ id: 5, issueNumber: 100, status: "ready" }]);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(1);

      expect(mockGetIssueState).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 100);
      expect(mockSyncUnlabeledIssueToLocal).toHaveBeenCalledWith(
        app,
        expect.objectContaining({ id: 5, issueNumber: 100 }),
        { cwd: "/tmp/one", hostId: "local" },
      );

      cleanup();
      vi.useRealTimers();
    });

    it("does not act when the confirm check shows the label is still present — sweep's own page cap, not a real removal", async () => {
      mockResolveGitHubToken.mockReturnValue("ghp_token");
      mockListLabeledIssues.mockResolvedValue([]);
      mockGetIssueState.mockResolvedValue({ state: "open", labels: ["mullion-task"] });
      const app = mockApp(rows, [], [], [], [{ id: 6, issueNumber: 101, status: "backlog" }]);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(1);

      expect(mockGetIssueState).toHaveBeenCalled();
      expect(mockSyncUnlabeledIssueToLocal).not.toHaveBeenCalled();

      cleanup();
      vi.useRealTimers();
    });

    // Hermes review, PR #510: without this, a backlog/ready task whose
    // issue is confirmed closed (without ever losing the label) would
    // never leave "ready" at all — disappearedForClose's own
    // canTransition(status,"done") gate never admits backlog/ready, so
    // nothing else in this file would ever settle it. Left alone, it would
    // be re-probed via getIssueState every sweep forever (permanently
    // occupying one of this cap's slots) AND stay eligible for
    // autoClaimReadyTasks() to spawn a real agent on an already-closed
    // issue. syncUnlabeledIssueToLocal's own decision (fail backlog/ready)
    // is exactly right here too, so this case shares that same call.
    it("also syncs a ready task when the confirm check shows the issue is closed (not just genuinely unlabeled)", async () => {
      mockResolveGitHubToken.mockReturnValue("ghp_token");
      mockListLabeledIssues.mockResolvedValue([]);
      mockGetIssueState.mockResolvedValue({ state: "closed", labels: [] });
      const app = mockApp(rows, [], [], [], [{ id: 7, issueNumber: 102, status: "ready" }]);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(1);

      expect(mockSyncUnlabeledIssueToLocal).toHaveBeenCalledWith(
        app,
        expect.objectContaining({ id: 7, issueNumber: 102 }),
        { cwd: "/tmp/one", hostId: "local" },
      );

      cleanup();
      vi.useRealTimers();
    });

    it("never checks a claimed/in_progress task for label loss — no GitHub call, no sync", async () => {
      mockResolveGitHubToken.mockReturnValue("ghp_token");
      mockListLabeledIssues.mockResolvedValue([]);
      const app = mockApp(rows, [], [], [], [{ id: 8, issueNumber: 103, status: "claimed" }]);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(1);

      expect(mockGetIssueState).not.toHaveBeenCalled();
      expect(mockSyncUnlabeledIssueToLocal).not.toHaveBeenCalled();

      cleanup();
      vi.useRealTimers();
    });

    it("routes a disappeared reviewing task through close-sync only, not the unlabel path", async () => {
      mockResolveGitHubToken.mockReturnValue("ghp_token");
      mockListLabeledIssues.mockResolvedValue([]);
      const app = mockApp(rows, [], [], [], [{ id: 9, issueNumber: 104, status: "reviewing" }]);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(1);

      expect(mockSyncClosedIssueToLocal).toHaveBeenCalledWith(
        app,
        expect.objectContaining({ id: 9, issueNumber: 104 }),
        { cwd: "/tmp/one", hostId: "local" },
      );
      expect(mockGetIssueState).not.toHaveBeenCalled();
      expect(mockSyncUnlabeledIssueToLocal).not.toHaveBeenCalled();

      cleanup();
      vi.useRealTimers();
    });

    it("each candidate set has its own cap — a backlog/ready flood doesn't starve reviewing's close-sync", async () => {
      mockResolveGitHubToken.mockReturnValue("ghp_token");
      mockListLabeledIssues.mockResolvedValue([]);
      mockGetIssueState.mockResolvedValue({ state: "open", labels: [] });
      const flood = Array.from({ length: 25 }, (_, i) => ({
        id: 100 + i,
        issueNumber: 200 + i,
        status: "ready",
      }));
      const trackedNonTerminal = [...flood, { id: 999, issueNumber: 999, status: "reviewing" }];
      const app = mockApp(rows, [], [], [], trackedNonTerminal);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(1);

      // Capped at MAX_READBACK_CHECKS_PER_SWEEP (20) for the unlabel set,
      // independent of the reviewing task's own close-sync — which still
      // runs, proving the two caps don't share a budget.
      expect(mockGetIssueState).toHaveBeenCalledTimes(20);
      expect(mockSyncClosedIssueToLocal).toHaveBeenCalledWith(
        app,
        expect.objectContaining({ id: 999 }),
        { cwd: "/tmp/one", hostId: "local" },
      );
      expect(app.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ total: 25, checking: 20 }),
        expect.stringContaining("unlabel-sync"),
      );

      cleanup();
      vi.useRealTimers();
    });
  });

  it("cleanup prevents staggered timers from firing", () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    const rows = [
      { id: 1, cwd: "/tmp/one", hostId: "local" },
      { id: 2, cwd: "/tmp/two", hostId: "local" },
    ];
    const app = mockApp(rows, []);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    cleanup();

    vi.advanceTimersByTime(300_000);
    expect(mockListLabeledIssues).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  describe("auto-claim (6.2/#215)", () => {
    it("claims every ready task via task-claim.ts's shared orchestration, auto: true", async () => {
      mockResolveGitHubToken.mockReturnValue(null);
      const readyTasks = [{ id: 10 }, { id: 11 }];
      const app = mockApp([], [], [], readyTasks);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockClaimTask).toHaveBeenCalledWith(app, 10, { auto: true });
      expect(mockClaimTask).toHaveBeenCalledWith(app, 11, { auto: true });

      cleanup();
      vi.useRealTimers();
    });

    it("runs even when no GitHub token is configured — a local task needs no GitHub connection", async () => {
      mockResolveGitHubToken.mockReturnValue(null);
      const readyTasks = [{ id: 20 }];
      const app = mockApp([], [], [], readyTasks);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockClaimTask).toHaveBeenCalledWith(app, 20, { auto: true });

      cleanup();
      vi.useRealTimers();
    });

    it("skips entirely when settings.taskMaster.autoClaimPaused is true", async () => {
      mockResolveGitHubToken.mockReturnValue(null);
      mockGetStoredSettings.mockReturnValue({
        taskMaster: {
          autoClaimPaused: true,
          enabled: "inherit",
          maxConcurrent: -1,
          budgetMinutes: -1,
          progressCommentMinutes: -1,
        },
      });
      const readyTasks = [{ id: 30 }];
      const app = mockApp([], [], [], readyTasks);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockClaimTask).not.toHaveBeenCalled();

      cleanup();
      vi.useRealTimers();
    });

    it("logs a cap outcome at debug, not warn — expected once an install is at capacity", async () => {
      mockResolveGitHubToken.mockReturnValue(null);
      mockClaimTask.mockResolvedValue({ ok: false, reason: "cap", limit: 2 });
      const readyTasks = [{ id: 40 }];
      const app = mockApp([], [], [], readyTasks);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(app.log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 40, reason: "cap" }),
        expect.stringContaining("auto-claim"),
      );
      expect(app.log.warn).not.toHaveBeenCalled();

      cleanup();
      vi.useRealTimers();
    });

    it("logs a non-cap failure outcome at warn", async () => {
      mockResolveGitHubToken.mockReturnValue(null);
      mockClaimTask.mockResolvedValue({ ok: false, reason: "no-seed-channel" });
      const readyTasks = [{ id: 41 }];
      const app = mockApp([], [], [], readyTasks);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(app.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 41, reason: "no-seed-channel" }),
        expect.stringContaining("auto-claim"),
      );

      cleanup();
      vi.useRealTimers();
    });

    it("isolates a claimTask rejection on one task so a sibling still gets attempted", async () => {
      mockResolveGitHubToken.mockReturnValue(null);
      mockClaimTask.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ok: true });
      const readyTasks = [{ id: 50 }, { id: 51 }];
      const app = mockApp([], [], [], readyTasks);
      vi.useFakeTimers();
      const cleanup = startTaskWatcher(app);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockClaimTask).toHaveBeenCalledTimes(2);
      expect(app.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 50 }),
        expect.stringContaining("threw unexpectedly"),
      );

      cleanup();
      vi.useRealTimers();
    });
  });
});
