import { describe, it, expect, vi, beforeEach } from "vitest";

// #484 — host-git.ts's whole job is dispatching (app, hostId, ...) calls to
// either the real local git-status.js/git-refs.js/git-push.js functions or
// a RemoteHostClient method, and mapping that client's two error types onto
// a discriminated HostGitResult. Every collaborator is mocked so this file
// tests exactly that dispatch/mapping logic, not git itself (covered by
// git-status.test.ts/git-refs.test.ts/git-push.test.ts) or the wire format
// (covered by test/routes/internal.test.ts).

const mockGetGitStatus = vi.fn();
const mockIsGitRepo = vi.fn();
const mockResolveDefaultBaseRef = vi.fn();
const mockResolveCommitSha = vi.fn();
const mockPushBranch = vi.fn();
const mockGetRemoteHostClient = vi.fn();

vi.mock("../../src/services/git-status.js", () => ({
  getGitStatus: mockGetGitStatus,
  isGitRepo: mockIsGitRepo,
}));
vi.mock("../../src/services/git-refs.js", () => ({
  resolveDefaultBaseRef: mockResolveDefaultBaseRef,
  resolveCommitSha: mockResolveCommitSha,
}));
vi.mock("../../src/services/git-push.js", () => ({
  pushBranch: mockPushBranch,
}));
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
  HostUnreachableError: class extends Error {
    constructor(hostId: string, cause: unknown) {
      super(
        `Host ${hostId} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      this.name = "HostUnreachableError";
    }
  },
}));

const { resolveHostGitStatus, resolveHostBaseRef, pushHostBranch } =
  await import("../../src/services/host-git.js");
const { HostRequestError, HostUnreachableError } =
  await import("../../src/services/remote-host-client.js");

const fakeApp = { config: {} } as never;

const cleanStatus = {
  branch: "main",
  hash: "abc123",
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  hasConflicts: false,
};

describe("host-git.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resolveHostGitStatus", () => {
    it("local: reads real git status with forceFresh, never fails", async () => {
      mockIsGitRepo.mockReturnValue(true);
      mockGetGitStatus.mockResolvedValue(cleanStatus);

      const result = await resolveHostGitStatus(fakeApp, "local", "/some/worktree");

      expect(mockGetGitStatus).toHaveBeenCalledWith("/some/worktree", { forceFresh: true });
      expect(result).toEqual({ ok: true, value: { isRepo: true, status: cleanStatus } });
    });

    it("local: isRepo:false for a non-repo cwd, without ever calling getGitStatus", async () => {
      mockIsGitRepo.mockReturnValue(false);

      const result = await resolveHostGitStatus(fakeApp, "local", "/not/a/repo");

      expect(mockGetGitStatus).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, value: { isRepo: false, status: null } });
    });

    it("remote: proxies via the remote client with fresh:true", async () => {
      const mockResolveGitStatus = vi.fn().mockResolvedValue({ isRepo: true, status: cleanStatus });
      mockGetRemoteHostClient.mockReturnValue({ resolveGitStatus: mockResolveGitStatus });

      const result = await resolveHostGitStatus(fakeApp, "remote-host-1", "/remote/worktree");

      expect(mockResolveGitStatus).toHaveBeenCalledWith("/remote/worktree", { fresh: true });
      expect(result).toEqual({ ok: true, value: { isRepo: true, status: cleanStatus } });
    });

    it("remote: HostRequestError maps to reason 'unsupported'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveGitStatus: vi.fn().mockRejectedValue(new HostRequestError("h1", 404, "")),
      });

      const result = await resolveHostGitStatus(fakeApp, "remote-host-1", "/remote/worktree");

      expect(result).toEqual({ ok: false, reason: "unsupported" });
    });

    it("remote: HostUnreachableError maps to reason 'unreachable' with a detail", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveGitStatus: vi
          .fn()
          .mockRejectedValue(new HostUnreachableError("h1", new Error("ECONNREFUSED"))),
      });

      const result = await resolveHostGitStatus(fakeApp, "remote-host-1", "/remote/worktree");

      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === "unreachable") {
        expect(result.detail).toContain("unreachable");
      } else {
        throw new Error("expected reason 'unreachable'");
      }
    });

    // Independent review, PR #590 — an unrelated thrown error (e.g.
    // getRemoteHostClient itself throwing a plain Error for a dangling
    // hostId with no matching hosts row) is treated as "unreachable" too,
    // not re-thrown — see viaRemote's own doc comment for why: every
    // caller of this module gets the same "never propagates an uncaught
    // throw" guarantee task-claim.ts's claimTask/retryTask already give
    // themselves individually, without each one needing its own try/catch.
    it("remote: an unrelated thrown error resolves ok:false, reason:unreachable — never re-thrown", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveGitStatus: vi.fn().mockRejectedValue(new Error("boom")),
      });

      await expect(resolveHostGitStatus(fakeApp, "remote-host-1", "/x")).resolves.toEqual({
        ok: false,
        reason: "unreachable",
        detail: "boom",
      });
    });

    it("remote: a non-404 HostRequestError (e.g. a genuine 400) is 'unreachable', not the durable-sounding 'unsupported'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveGitStatus: vi
          .fn()
          .mockRejectedValue(
            new HostRequestError("h1", 400, "cwd must be within this agent's PROJECTS_ROOTS"),
          ),
      });

      const result = await resolveHostGitStatus(fakeApp, "remote-host-1", "/x");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unreachable");
    });
  });

  describe("resolveHostBaseRef", () => {
    it("local: resolves the default base ref then pins it to a commit SHA", async () => {
      mockResolveDefaultBaseRef.mockResolvedValue("origin/main");
      mockResolveCommitSha.mockResolvedValue("deadbeef");

      const result = await resolveHostBaseRef(fakeApp, "local", "/project");

      expect(mockResolveDefaultBaseRef).toHaveBeenCalledWith("/project");
      expect(mockResolveCommitSha).toHaveBeenCalledWith("/project", "origin/main");
      expect(result).toEqual({ ok: true, value: { baseRef: "origin/main", sha: "deadbeef" } });
    });

    it("remote: proxies to the remote client's own base-ref route", async () => {
      const mockResolveHostBaseRef = vi
        .fn()
        .mockResolvedValue({ baseRef: "origin/main", sha: "cafef00d" });
      mockGetRemoteHostClient.mockReturnValue({ resolveHostBaseRef: mockResolveHostBaseRef });

      const result = await resolveHostBaseRef(fakeApp, "remote-host-1", "/remote/project");

      expect(mockResolveHostBaseRef).toHaveBeenCalledWith("/remote/project");
      expect(result).toEqual({ ok: true, value: { baseRef: "origin/main", sha: "cafef00d" } });
    });

    it("remote: an unreachable host maps to reason 'unreachable'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveHostBaseRef: vi
          .fn()
          .mockRejectedValue(new HostUnreachableError("h1", new Error("timeout"))),
      });

      const result = await resolveHostBaseRef(fakeApp, "remote-host-1", "/remote/project");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unreachable");
    });
  });

  describe("pushHostBranch", () => {
    it("local: pushes via the real pushBranch, passing the token through", async () => {
      mockPushBranch.mockResolvedValue({ ok: true });

      const result = await pushHostBranch(fakeApp, "local", "/worktree", "mullion/task-1", "ghp_x");

      expect(mockPushBranch).toHaveBeenCalledWith("/worktree", "mullion/task-1", "ghp_x");
      expect(result).toEqual({ ok: true, value: { ok: true } });
    });

    it("remote: proxies the push (and its token) to the remote client", async () => {
      const mockResolvePushBranch = vi.fn().mockResolvedValue({ ok: true });
      mockGetRemoteHostClient.mockReturnValue({ resolvePushBranch: mockResolvePushBranch });

      const result = await pushHostBranch(
        fakeApp,
        "remote-host-1",
        "/remote/worktree",
        "mullion/task-1",
        "ghp_x",
      );

      expect(mockResolvePushBranch).toHaveBeenCalledWith(
        "/remote/worktree",
        "mullion/task-1",
        "ghp_x",
      );
      expect(result).toEqual({ ok: true, value: { ok: true } });
    });

    it("remote: a git-level push failure surfaces as ok:true with the inner PushResult's own ok:false — not conflated with a transport failure", async () => {
      const mockResolvePushBranch = vi
        .fn()
        .mockResolvedValue({ ok: false, detail: "non-fast-forward" });
      mockGetRemoteHostClient.mockReturnValue({ resolvePushBranch: mockResolvePushBranch });

      const result = await pushHostBranch(
        fakeApp,
        "remote-host-1",
        "/remote/worktree",
        "mullion/task-1",
        "ghp_x",
      );

      expect(result).toEqual({ ok: true, value: { ok: false, detail: "non-fast-forward" } });
    });

    it("remote: an old agent build (404) maps to reason 'unsupported'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolvePushBranch: vi.fn().mockRejectedValue(new HostRequestError("h1", 404, "")),
      });

      const result = await pushHostBranch(
        fakeApp,
        "remote-host-1",
        "/remote/worktree",
        "mullion/task-1",
        "ghp_x",
      );

      expect(result).toEqual({ ok: false, reason: "unsupported" });
    });
  });
});
