import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockGetRepoPRsStatus = vi.hoisted(() => vi.fn());
const mockGetToken = vi.hoisted(() => vi.fn());
const mockResolveGitHubRepo = vi.hoisted(() => vi.fn());
const mockGetRemoteHostClient = vi.hoisted(() => vi.fn());

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
}));

vi.mock("../../src/services/github-integration.js", () => ({
  getToken: mockGetToken,
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

import { startGitHubPRPoller } from "../../src/services/github-pr-poller.js";

function mockApp(rows: { id: number; cwd: string; hostId: string }[]): FastifyInstance {
  return {
    db: { select: () => ({ from: () => ({ all: () => rows }) }) },
    log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { MULLION_ROLE: "primary" },
  } as unknown as FastifyInstance;
}

describe("startGitHubPRPoller", () => {
  beforeEach(() => {
    mockGetRepoPRsStatus.mockReset();
    mockGetRepoPRsStatus.mockResolvedValue({
      prs: [],
      prSummary: { total: 0, pass: 0, fail: 0, pending: 0 },
    });
    mockGetToken.mockReset();
    mockResolveGitHubRepo.mockReset();
    mockGetRemoteHostClient.mockReset();
    mockGetRemoteHostClient.mockReturnValue({ resolveGitHubRepo: mockResolveGitHubRepo });
  });

  it("starts interval immediately when no local projects exist", () => {
    mockGetToken.mockReturnValue("ghp_token");
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
    mockGetToken.mockReturnValue(null);
    const rows = [{ id: 1, cwd: "/tmp/one", hostId: "local" }];
    const app = mockApp(rows);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    vi.advanceTimersByTime(200_000);
    expect(mockGetRepoPRsStatus).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("fires staggered timers and calls getRepoPRsStatus", () => {
    mockGetToken.mockReturnValue("ghp_token");
    const rows = [
      { id: 1, cwd: "/tmp/one", hostId: "local" },
      { id: 2, cwd: "/tmp/two", hostId: "local" },
    ];
    const app = mockApp(rows);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    // Fire the first staggered timer (setTimeout(fn, 0)).
    vi.advanceTimersByTime(1);
    expect(mockGetRepoPRsStatus).toHaveBeenCalledTimes(1);

    // Fire the second staggered timer.
    vi.advanceTimersByTime(2_000);
    expect(mockGetRepoPRsStatus).toHaveBeenCalledTimes(2);

    cleanup();
    vi.useRealTimers();
  });

  it("sweepTimer fires after margin then sets up interval", async () => {
    mockGetToken.mockReturnValue("ghp_token");
    const rows = [
      { id: 1, cwd: "/tmp/one", hostId: "local" },
      { id: 2, cwd: "/tmp/two", hostId: "local" },
    ];
    const app = mockApp(rows);
    vi.useFakeTimers();
    const cleanup = startGitHubPRPoller(app);

    // Fire all staggered timers first.
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(2_000);
    // Each staggered timer calls getRepoPRsStatus once for its single row.
    const staggeredCalls = mockGetRepoPRsStatus.mock.calls.length;
    expect(staggeredCalls).toBe(2);

    // Advance to sweep margin: (2-1)*2000 + 60000*2 = 122000ms.
    // At 2001ms now, advance 119999ms.
    await vi.advanceTimersByTimeAsync(119_999);
    // sweepTimer fires pollOnce which iterates all 2 rows.
    expect(mockGetRepoPRsStatus).toHaveBeenCalledTimes(staggeredCalls + 2);

    // Interval fires after 60s — pollOnce again iterates 2 rows.
    const intervalFiredAt = mockGetRepoPRsStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockGetRepoPRsStatus).toHaveBeenCalledTimes(intervalFiredAt + 2);

    cleanup();
    vi.useRealTimers();
  });

  it("cleanup prevents staggered timers from firing", () => {
    mockGetToken.mockReturnValue("ghp_token");
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
    mockGetToken.mockReturnValue("ghp_token");
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
    mockGetToken.mockReturnValue("ghp_token");
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
    mockGetToken.mockReturnValue("ghp_token");
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
});
