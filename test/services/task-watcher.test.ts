import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockListLabeledIssues = vi.hoisted(() => vi.fn());
const mockGetToken = vi.hoisted(() => vi.fn());
const mockParseGitRemote = vi.hoisted(() => vi.fn());

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

import { startTaskWatcher } from "../../src/services/task-watcher.js";

interface InsertedTaskRow {
  projectId: number;
  issueNumber: number;
  title: string;
  body: string | null;
  htmlUrl: string;
}

function mockApp(
  rows: { id: number; cwd: string; hostId: string }[],
  inserted: InsertedTaskRow[],
): FastifyInstance {
  return {
    db: {
      select: () => ({ from: () => ({ all: () => rows }) }),
      insert: () => ({
        values: (v: InsertedTaskRow) => {
          inserted.push(v);
          return { onConflictDoNothing: () => ({ run: () => {} }) };
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

  it("fetches labeled issues for a local project and inserts a pending task row per issue", async () => {
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
      },
    ]);

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
});
