import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockListLabeledIssues = vi.hoisted(() => vi.fn());
const mockGetToken = vi.hoisted(() => vi.fn());
const mockParseGitRemote = vi.hoisted(() => vi.fn());
const mockGetStoredSettings = vi.hoisted(() => vi.fn());
const mockClaimTask = vi.hoisted(() => vi.fn());

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
  getToken: mockGetToken,
}));

vi.mock("../../src/services/git-remote.js", () => ({
  parseGitRemote: mockParseGitRemote,
}));

vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: mockGetStoredSettings,
}));

vi.mock("../../src/services/task-claim.js", () => ({
  claimTask: mockClaimTask,
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

function mockApp(
  rows: { id: number; cwd: string; hostId: string }[],
  inserted: InsertedTaskRow[],
  conflictConfigs: { set: object; where: unknown }[] = [],
  readyTasks: { id: number }[] = [],
): FastifyInstance {
  return {
    db: {
      select: () => ({
        from: () => ({
          // The ingest sweep's own project-discovery select
          // (localProjectRows) calls `.all()` directly with no `.where()`
          // in its chain; auto-claim's ready-task query always calls
          // `.where(...)` first — told apart by which method the caller
          // invokes on this object, not by what was passed to `select()`.
          all: () => rows,
          where: () => ({ all: () => readyTasks }),
        }),
      }),
      insert: () => ({
        values: (v: InsertedTaskRow) => {
          inserted.push(v);
          return {
            onConflictDoUpdate: (config: { set: object; where: unknown }) => {
              conflictConfigs.push(config);
              return { run: () => {} };
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
    },
  } as unknown as FastifyInstance;
}

describe("startTaskWatcher", () => {
  beforeEach(() => {
    mockListLabeledIssues.mockReset();
    mockListLabeledIssues.mockResolvedValue([]);
    mockGetToken.mockReset();
    mockParseGitRemote.mockReset();
    mockParseGitRemote.mockReturnValue({ owner: "test-owner", repo: "test-repo" });
    mockGetStoredSettings.mockReset();
    mockGetStoredSettings.mockReturnValue({ taskMaster: { autoClaimPaused: false } });
    mockClaimTask.mockReset();
    mockClaimTask.mockResolvedValue({ ok: true });
  });

  it("starts interval immediately when no local projects exist", () => {
    mockGetToken.mockReturnValue("ghp_token");
    const app = mockApp([], []);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    vi.advanceTimersByTime(60_000);
    expect(mockListLabeledIssues).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("skips polling when no GitHub token is configured", () => {
    mockGetToken.mockReturnValue(null);
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];
    const app = mockApp(rows, []);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    vi.advanceTimersByTime(200_000);
    expect(mockListLabeledIssues).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("skips remote-hosted projects — local-host only for the thin slice", () => {
    mockGetToken.mockReturnValue("ghp_token");
    const rows = [{ id: 1, cwd: "/tmp/remote", hostId: "agent-1" }];
    const app = mockApp(rows, []);
    vi.useFakeTimers();
    const cleanup = startTaskWatcher(app);

    vi.advanceTimersByTime(1);
    expect(mockListLabeledIssues).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("fetches labeled issues for a local project and inserts a ready task row per issue", async () => {
    mockGetToken.mockReturnValue("ghp_token");
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
    mockGetToken.mockReturnValue("ghp_token");
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
    mockGetToken.mockReturnValue("ghp_token");
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
    mockGetToken.mockReturnValue("ghp_token");
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
    mockGetToken.mockReturnValue("ghp_token");
    mockParseGitRemote.mockReturnValue(null);
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
    mockGetToken.mockReturnValue("ghp_token");
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

  it("cleanup prevents staggered timers from firing", () => {
    mockGetToken.mockReturnValue("ghp_token");
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
      mockGetToken.mockReturnValue(null);
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
      mockGetToken.mockReturnValue(null);
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
      mockGetToken.mockReturnValue(null);
      mockGetStoredSettings.mockReturnValue({ taskMaster: { autoClaimPaused: true } });
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
      mockGetToken.mockReturnValue(null);
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
      mockGetToken.mockReturnValue(null);
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
      mockGetToken.mockReturnValue(null);
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
