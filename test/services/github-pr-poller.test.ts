import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as SettingsModule from "../../src/services/settings.js";

const mockGetRepoPRsStatus = vi.hoisted(() => vi.fn());
const mockRefreshDefaultBranchCi = vi.hoisted(() => vi.fn());
const mockResolveGitHubToken = vi.hoisted(() => vi.fn());
const mockResolveGitHubRepo = vi.hoisted(() => vi.fn());
const mockGetRemoteHostClient = vi.hoisted(() => vi.fn());
const mockEnrich = vi.hoisted(() => vi.fn());
const mockBroadcast = vi.hoisted(() => vi.fn());
const mockMergeState = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/github.js", () => ({
  GitHubApiError: class extends Error {
    statusCode: number;
    constructor(m: string, code: number) {
      super(m);
      this.name = "GitHubApiError";
      this.statusCode = code;
    }
  },
  getRepoPRsStatus: mockGetRepoPRsStatus,
  setRepoPRsStatus: vi.fn(),
  refreshDefaultBranchCi: mockRefreshDefaultBranchCi,
  getPullRequestMergeState: mockMergeState,
}));

// Review-state enrichment has its own tests (github-pr-reviews.test.ts); here
// it's a stub so the poller's own wiring (enrich → push on change) is isolated.
vi.mock("../../src/services/github-pr-reviews.js", () => ({
  enrichPrsWithReviewState: mockEnrich,
}));

vi.mock("../../src/services/github-ws-broadcast.js", () => ({
  broadcastToProject: mockBroadcast,
}));

vi.mock("../../src/services/github-integration.js", () => ({
  // #489 — the PR/CI poller resolves its per-repo token via
  // resolveGitHubToken(app, repoRef, "read") now, not getToken(app)
  // directly. The mock's return value is used with `await`, which works
  // fine on a plain (non-Promise) value.
  resolveGitHubToken: mockResolveGitHubToken,
}));

vi.mock("../../src/services/git-remote.js", () => ({
  parseGitRemote: () => ({ owner: "test-owner", repo: "test-repo" }),
}));

// Remote-host resolution (issue #222) — resolveGitHubRepo is the only method
// the poller calls on the client. HostRequestError also needs a real export
// (not just a mock fn) since resolveRemoteRepoRef does `instanceof` on it.
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: mockGetRemoteHostClient,
  HostRequestError: class extends Error {
    statusCode: number;
    constructor(hostId: string, statusCode: number, body: string) {
      super(`Host ${hostId} rejected the request: HTTP ${statusCode}${body ? ` — ${body}` : ""}`);
      this.name = "HostRequestError";
      this.statusCode = statusCode;
    }
  },
}));

// The poller reads its intervals through the settings row (env defaults,
// overridable from Settings → Integrations); this mock app has no real DB.
vi.mock("../../src/services/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SettingsModule>();
  return { ...actual, getStoredSettings: () => actual.DEFAULT_SETTINGS };
});

import { startGitHubPRPoller } from "../../src/services/github-pr-poller.js";

function mockApp(rows: { id: number; cwd: string; hostId: string }[]): FastifyInstance {
  return {
    db: { select: () => ({ from: () => ({ all: () => rows }) }) },
    log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: {
      MULLION_ROLE: "primary",
      GITHUB_POLL_INTERVAL_ACTIVE: 15,
      GITHUB_POLL_INTERVAL_QUIET: 60,
      GITHUB_POLL_STALE_THRESHOLD: 300,
    },
  } as unknown as FastifyInstance;
}

describe("startGitHubPRPoller", () => {
  beforeEach(() => {
    mockGetRepoPRsStatus.mockReset();
    mockGetRepoPRsStatus.mockResolvedValue({
      prs: [],
      prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
    });
    mockEnrich.mockReset();
    mockEnrich.mockResolvedValue(undefined);
    mockBroadcast.mockReset();
    mockMergeState.mockReset();
    mockRefreshDefaultBranchCi.mockReset();
    mockRefreshDefaultBranchCi.mockResolvedValue(undefined);
    mockResolveGitHubToken.mockReset();
    mockResolveGitHubRepo.mockReset();
    mockGetRemoteHostClient.mockReset();
    mockGetRemoteHostClient.mockReturnValue({ resolveGitHubRepo: mockResolveGitHubRepo });
  });

  it("starts interval immediately when no local projects exist", () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    const app = mockApp([]);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    vi.advanceTimersByTime(60_000);
    expect(mockGetRepoPRsStatus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(mockGetRepoPRsStatus).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("skips polling when no token is configured", () => {
    mockResolveGitHubToken.mockReturnValue(null);
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];
    const app = mockApp(rows);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    vi.advanceTimersByTime(200_000);
    expect(mockGetRepoPRsStatus).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("fires staggered timers and calls getRepoPRsStatus", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    const rows = [
      { id: 1, cwd: "/tmp/one", hostId: "local" },
      { id: 2, cwd: "/tmp/two", hostId: "local" },
    ];
    const app = mockApp(rows);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    // Fire the first staggered timer (setTimeout(fn, 0)). #489 — the token
    // is now resolved via an async resolveGitHubToken() call before
    // getRepoPRsStatus, so the timer callback's own work spans a
    // microtask; advanceTimersByTimeAsync (not the sync variant) is what
    // flushes that.
    await vi.advanceTimersByTimeAsync(1);
    expect(mockGetRepoPRsStatus).toHaveBeenCalledTimes(1);

    // Fire the second staggered timer.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockGetRepoPRsStatus).toHaveBeenCalledTimes(2);

    // Default-branch CI rides the same per-repo poll (right-sidebar badge).
    expect(mockRefreshDefaultBranchCi).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo");
    expect(mockRefreshDefaultBranchCi).toHaveBeenCalledTimes(2);

    cleanup();
    vi.useRealTimers();
  });

  // A poll that finds a PR's review/CI state changed pushes the browser,
  // rather than leaving it to its own next refetch. The first poll of a repo
  // has no baseline and must stay silent.
  it("pushes a pr sync to the repo's projects only when a later poll differs", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    const pr = (ciStatus: string) => ({
      number: 7,
      headSha: "abc",
      isDraft: false,
      ciStatus,
      reviewDecision: null,
      mergeable: null,
      unresolvedThreads: null,
      commentCount: null,
      prPhase: "ready_to_merge",
    });
    const status = (ciStatus: string) => ({
      prs: [pr(ciStatus)],
      prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
    });
    mockGetRepoPRsStatus
      .mockResolvedValueOnce(status("success"))
      .mockResolvedValueOnce(status("success"))
      .mockResolvedValueOnce(status("failure"));
    const app = mockApp([{ id: 1, cwd: "/tmp/one", hostId: "local" }]);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    // Initial fetch: no baseline, no push.
    await vi.advanceTimersByTimeAsync(1);
    expect(mockEnrich).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).not.toHaveBeenCalled();

    // Sweep poll: identical snapshot, still no push.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockBroadcast).not.toHaveBeenCalled();

    // Next poll (a repo with open PRs is polled on the active cadence, 15s):
    // CI flipped red → one push for the project.
    mockGetRepoPRsStatus.mockResolvedValue(status("failure"));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith("1", {
      type: "pr",
      action: "sync",
      projectId: "1",
      pr: { changed: [7] },
    });

    cleanup();
    vi.useRealTimers();
  });

  // Two projects on one repo: the initial per-project sweep may only have
  // covered one of them, so it seeds a baseline but must never push.
  it("never pushes from the initial sweep, even when projects share a repo", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    const prWith = (ciStatus: string) => ({
      number: 7,
      headSha: "abc",
      isDraft: false,
      ciStatus,
      reviewDecision: null,
      mergeable: null,
      unresolvedThreads: null,
      commentCount: null,
      prPhase: "ready_to_merge",
    });
    mockGetRepoPRsStatus
      .mockResolvedValueOnce({ prs: [prWith("success")], prSummary: { total: 1 } })
      .mockResolvedValueOnce({ prs: [prWith("failure")], prSummary: { total: 1 } });
    const app = mockApp([
      { id: 1, cwd: "/tmp/one", hostId: "local" },
      { id: 2, cwd: "/tmp/two", hostId: "local" },
    ]);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockGetRepoPRsStatus).toHaveBeenCalledTimes(2);
    expect(mockBroadcast).not.toHaveBeenCalled();

    cleanup();
    vi.useRealTimers();
  });

  it("sweepTimer fires after margin then sets up interval", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    const rows = [
      { id: 1, cwd: "/tmp/one", hostId: "local" },
      { id: 2, cwd: "/tmp/two", hostId: "local" },
    ];
    const app = mockApp(rows);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    // Fire all staggered timers first.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2_000);
    // Each staggered timer calls getRepoPRsStatus once for its single row.
    const staggeredCalls = mockGetRepoPRsStatus.mock.calls.length;
    expect(staggeredCalls).toBe(2);

    // Advance to sweep margin: (2-1)*2000 + 60000*2 = 122000ms.
    // At 2001ms now, advance 119999ms.
    await vi.advanceTimersByTimeAsync(119_999);
    // sweepTimer fires pollOnce; both rows share one repo, so it is
    // refreshed once, not once per project.
    expect(mockGetRepoPRsStatus).toHaveBeenCalledTimes(staggeredCalls + 1);

    // Interval fires after 60s — one more refresh of the shared repo.
    const intervalFiredAt = mockGetRepoPRsStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockGetRepoPRsStatus).toHaveBeenCalledTimes(intervalFiredAt + 1);

    cleanup();
    vi.useRealTimers();
  });

  it("cleanup prevents staggered timers from firing", () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    const rows = [
      { id: 1, cwd: "/tmp/one", hostId: "local" },
      { id: 2, cwd: "/tmp/two", hostId: "local" },
    ];
    const app = mockApp(rows);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    cleanup();

    vi.advanceTimersByTime(300_000);
    expect(mockGetRepoPRsStatus).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("polls a remote-hosted row via the agent (issue #222)", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    mockResolveGitHubRepo.mockResolvedValue({ owner: "remote-owner", repo: "remote-repo" });
    const rows = [{ id: 1, cwd: "/tmp/remote", hostId: "agent-1" }];
    const app = mockApp(rows);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    await vi.advanceTimersByTimeAsync(1);

    expect(mockGetRemoteHostClient).toHaveBeenCalledWith(app, "agent-1");
    expect(mockResolveGitHubRepo).toHaveBeenCalledWith("/tmp/remote");
    expect(mockGetRepoPRsStatus).toHaveBeenCalledWith("ghp_token", "remote-owner", "remote-repo");

    cleanup();
    vi.useRealTimers();
  });

  it("isolates an unreachable remote host so a sibling local row still gets polled (issue #222)", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    mockResolveGitHubRepo.mockRejectedValue(new Error("fetch failed: bad port"));
    const rows = [
      { id: 1, cwd: "/tmp/one", hostId: "local" },
      { id: 2, cwd: "/tmp/remote", hostId: "agent-down" },
    ];
    const app = mockApp(rows);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    // Fire both staggered timers (local at t=0, remote at t=2000).
    await vi.advanceTimersByTimeAsync(2_001);

    // The unreachable remote row is skipped, not thrown — only the local
    // sibling's owner/repo ever reaches getRepoPRsStatus.
    expect(mockGetRepoPRsStatus).toHaveBeenCalledTimes(1);
    expect(mockGetRepoPRsStatus).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo");
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "agent-down" }),
      expect.stringContaining("host unreachable"),
    );

    cleanup();
    vi.useRealTimers();
  });

  it("logs a distinct message when the agent rejects the request rather than being unreachable (Hermes review, PR #244)", async () => {
    mockResolveGitHubToken.mockReturnValue("ghp_token");
    const { HostRequestError } = await import("../../src/services/remote-host-client.js");
    mockResolveGitHubRepo.mockRejectedValue(new HostRequestError("agent-2", 400, "bad cwd"));
    const rows = [{ id: 1, cwd: "/tmp/remote", hostId: "agent-2" }];
    const app = mockApp(rows);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    await vi.advanceTimersByTimeAsync(1);

    expect(mockGetRepoPRsStatus).not.toHaveBeenCalled();
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "agent-2" }),
      expect.stringContaining("agent rejected github-repo request"),
    );

    cleanup();
    vi.useRealTimers();
  });

  describe("session events", () => {
    const pr = (over: Record<string, unknown> = {}) => ({
      number: 7,
      headSha: "abc",
      headBranch: "feat-x",
      title: "Add x",
      htmlUrl: "https://github.com/test-owner/test-repo/pull/7",
      isDraft: false,
      ciStatus: "in_progress",
      reviewDecision: null,
      mergeable: "MERGEABLE",
      unresolvedThreads: 0,
      commentCount: 0,
      prPhase: "ci_pending",
      ...over,
    });
    const status = (...prs: ReturnType<typeof pr>[]) => ({
      prs,
      prSummary: { total: prs.length, pass: 0, fail: 0, pending: 0, unknown: 0 },
    });

    function appWithSessions(taskSessionIds: number[] = []) {
      const emitPrEvent = vi.fn();
      const app = {
        ...mockApp([{ id: 1, cwd: "/tmp/one", hostId: "local" }]),
        pty: {
          sessionIdsOnBranch: vi.fn((projectId: number, branch: string) =>
            projectId === 1 && branch === "feat-x" ? ["11"] : [],
          ),
          sessionsWithoutBranch: vi.fn(() => []),
          get: vi.fn(() => ({ emitPrEvent })),
        },
      } as unknown as FastifyInstance;
      (app as unknown as { db: unknown }).db = {
        select: () => ({
          from: () => ({
            all: () => [{ id: 1, cwd: "/tmp/one", hostId: "local" }],
            where: () => ({ all: () => taskSessionIds.map((sessionId) => ({ sessionId })) }),
          }),
        }),
      };
      return { app, emitPrEvent };
    }

    async function runTwoPolls(first: unknown, second: unknown, taskSessionIds: number[] = []) {
      mockResolveGitHubToken.mockReturnValue("ghp_token");
      mockGetRepoPRsStatus.mockResolvedValueOnce(first).mockResolvedValue(second);
      const { app, emitPrEvent } = appWithSessions(taskSessionIds);
      vi.useFakeTimers();
      const cleanup = startGitHubPRPoller(app);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(16_000);
      cleanup();
      vi.useRealTimers();
      return emitPrEvent;
    }

    it("emits pr_ci_failed on the branch's session when CI flips red", async () => {
      const emit = await runTwoPolls(
        status(pr()),
        status(pr({ ciStatus: "failure", prPhase: "ci_failing" })),
      );
      expect(emit).toHaveBeenCalledWith("pr_ci_failed", {
        number: 7,
        title: "Add x",
        url: "https://github.com/test-owner/test-repo/pull/7",
      });
    });

    it("also reaches a Task Master task's session and emits a review decision", async () => {
      const emit = await runTwoPolls(
        status(pr({ ciStatus: "success" })),
        status(pr({ ciStatus: "success", reviewDecision: "CHANGES_REQUESTED", commentCount: 1 })),
        [22],
      );
      const kinds = emit.mock.calls.map((c) => c[0]);
      expect(kinds).toContain("pr_review_submitted");
      expect(kinds).toContain("pr_new_comments");
    });

    it("emits pr_merged when a vanished PR was merged, nothing when closed unmerged", async () => {
      mockMergeState.mockResolvedValue({
        merged: true,
        title: "Add x",
        htmlUrl: "https://github.com/test-owner/test-repo/pull/7",
      });
      const merged = await runTwoPolls(status(pr()), status());
      expect(merged).toHaveBeenCalledWith("pr_merged", expect.objectContaining({ number: 7 }));

      mockMergeState.mockResolvedValue({ merged: false, title: "", htmlUrl: "" });
      mockGetRepoPRsStatus.mockReset();
      const closed = await runTwoPolls(status(pr()), status());
      expect(closed).not.toHaveBeenCalled();
    });

    it("reaches a session that never reported a branch, via its checkout's HEAD", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poller-branch-"));
      execFileSync("git", ["init", "-q", "-b", "feat-x", dir]);
      mockResolveGitHubToken.mockReturnValue("ghp_token");
      mockGetRepoPRsStatus
        .mockResolvedValueOnce(status(pr()))
        .mockResolvedValue(status(pr({ ciStatus: "failure", prPhase: "ci_failing" })));
      const { app, emitPrEvent } = appWithSessions();
      (app as unknown as { pty: Record<string, unknown> }).pty.sessionIdsOnBranch = () => [];
      (app as unknown as { pty: Record<string, unknown> }).pty.sessionsWithoutBranch = () => [
        { id: "31", cwd: dir },
        { id: "32", cwd: "/nonexistent-dir-for-poller-test" },
      ];
      const get = vi.fn(() => ({ emitPrEvent }));
      (app as unknown as { pty: Record<string, unknown> }).pty.get = get;
      vi.useFakeTimers();
      const cleanup = startGitHubPRPoller(app);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(16_000);
      cleanup();
      vi.useRealTimers();
      // git runs in a real subprocess, so let it finish.
      await vi.waitFor(() =>
        expect(emitPrEvent).toHaveBeenCalledWith("pr_ci_failed", expect.anything()),
      );
      expect(get).toHaveBeenCalledWith("31");
      expect(get).not.toHaveBeenCalledWith("32");
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("survives a failing emit without losing the poll's bookkeeping", async () => {
      mockResolveGitHubToken.mockReturnValue("ghp_token");
      mockGetRepoPRsStatus
        .mockResolvedValueOnce(status(pr()))
        .mockResolvedValue(status(pr({ ciStatus: "failure", prPhase: "ci_failing" })));
      const app = {
        ...mockApp([{ id: 1, cwd: "/tmp/one", hostId: "local" }]),
        pty: {
          sessionsWithoutBranch: () => [],
          sessionIdsOnBranch: () => {
            throw new Error("boom");
          },
        },
      } as unknown as FastifyInstance;
      (app as unknown as { db: unknown }).db = {
        select: () => ({
          from: () => ({
            all: () => [{ id: 1, cwd: "/tmp/one", hostId: "local" }],
            where: () => ({ all: () => [] }),
          }),
        }),
      };
      vi.useFakeTimers();
      const cleanup = startGitHubPRPoller(app);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(120_000);
      const before = mockRefreshDefaultBranchCi.mock.calls.length;
      await vi.advanceTimersByTimeAsync(16_000);
      expect(app.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "test-owner" }),
        expect.stringContaining("session event emit failed"),
      );
      expect(mockRefreshDefaultBranchCi.mock.calls.length).toBeGreaterThan(before);
      cleanup();
      vi.useRealTimers();
    });
  });
});
