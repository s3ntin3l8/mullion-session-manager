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
const mockParseGitRemote = vi.fn();
const mockGetRemoteHostClient = vi.fn();
const mockGetFileDiff = vi.fn();
const mockCommitWipChanges = vi.fn();

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
vi.mock("../../src/services/git-remote.js", () => ({
  parseGitRemote: mockParseGitRemote,
}));
vi.mock("../../src/services/git-diff.js", () => ({
  getFileDiff: mockGetFileDiff,
}));
vi.mock("../../src/services/git-worktree.js", () => ({
  commitWipChanges: mockCommitWipChanges,
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

const {
  resolveHostGitStatus,
  resolveHostBaseRef,
  pushHostBranch,
  resolveHostFileDiff,
  commitHostWipChanges,
  resolveRepoRefResult,
  resolveRepoRef,
} = await import("../../src/services/host-git.js");
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

  // Issue #895
  describe("resolveHostFileDiff", () => {
    it("local: diffs via the real getFileDiff", async () => {
      mockGetFileDiff.mockResolvedValue("--- a/AGENTS.md\n+++ b/AGENTS.md\n");

      const result = await resolveHostFileDiff(fakeApp, "local", "/worktree", "AGENTS.md");

      expect(mockGetFileDiff).toHaveBeenCalledWith("/worktree", "AGENTS.md");
      expect(result).toEqual({ ok: true, value: "--- a/AGENTS.md\n+++ b/AGENTS.md\n" });
    });

    it("local: value:null when there's no diff — not an error", async () => {
      mockGetFileDiff.mockResolvedValue(null);

      const result = await resolveHostFileDiff(fakeApp, "local", "/worktree", "AGENTS.md");

      expect(result).toEqual({ ok: true, value: null });
    });

    it("remote: proxies to the remote client's own per-file diff route, unwrapping {patch}", async () => {
      const mockResolveGitFileDiff = vi.fn().mockResolvedValue({ patch: "diff text" });
      mockGetRemoteHostClient.mockReturnValue({ resolveGitFileDiff: mockResolveGitFileDiff });

      const result = await resolveHostFileDiff(
        fakeApp,
        "remote-host-1",
        "/remote/worktree",
        "AGENTS.md",
      );

      expect(mockResolveGitFileDiff).toHaveBeenCalledWith("/remote/worktree", "AGENTS.md");
      expect(result).toEqual({ ok: true, value: "diff text" });
    });

    it("remote: an unreachable host maps to reason 'unreachable'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveGitFileDiff: vi
          .fn()
          .mockRejectedValue(new HostUnreachableError("h1", new Error("timeout"))),
      });

      const result = await resolveHostFileDiff(fakeApp, "remote-host-1", "/x", "AGENTS.md");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unreachable");
    });
  });

  // Issue #895
  describe("commitHostWipChanges", () => {
    it("local: commits via the real commitWipChanges, passing the message through", async () => {
      mockCommitWipChanges.mockResolvedValue({ committed: true });

      const result = await commitHostWipChanges(fakeApp, "local", "/worktree", "chore: scaffold");

      expect(mockCommitWipChanges).toHaveBeenCalledWith("/worktree", "chore: scaffold");
      expect(result).toEqual({ ok: true, value: { committed: true } });
    });

    it("remote: proxies the message to the remote client's own commit-wip route", async () => {
      const mockResolveCommitWipChanges = vi.fn().mockResolvedValue({ committed: true });
      mockGetRemoteHostClient.mockReturnValue({
        resolveCommitWipChanges: mockResolveCommitWipChanges,
      });

      const result = await commitHostWipChanges(
        fakeApp,
        "remote-host-1",
        "/remote/worktree",
        "chore: scaffold",
      );

      expect(mockResolveCommitWipChanges).toHaveBeenCalledWith(
        "/remote/worktree",
        "chore: scaffold",
      );
      expect(result).toEqual({ ok: true, value: { committed: true } });
    });

    it("remote: a git-level 'nothing to commit' no-op surfaces as ok:true with the inner committed:false — not conflated with a transport failure", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveCommitWipChanges: vi.fn().mockResolvedValue({ committed: false }),
      });

      const result = await commitHostWipChanges(fakeApp, "remote-host-1", "/remote/worktree");

      expect(result).toEqual({ ok: true, value: { committed: false } });
    });

    it("remote: an old agent build (404) maps to reason 'unsupported'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveCommitWipChanges: vi.fn().mockRejectedValue(new HostRequestError("h1", 404, "")),
      });

      const result = await commitHostWipChanges(fakeApp, "remote-host-1", "/remote/worktree");

      expect(result).toEqual({ ok: false, reason: "unsupported" });
    });
  });

  // Moved here from github-webhook.ts as part of routes/projects.ts's
  // GitHub-route dedup — routes/projects.ts's `loadProjectRepoContext`
  // needs the 3-way `ok:true/value:null` vs. `ok:false` split
  // `resolveRepoRefResult` gives it (unlike the null-collapsing
  // `resolveRepoRef` below, which every other caller — webhook
  // registration/sync, Task Master's promote/sync/watcher paths — uses
  // instead).
  describe("resolveRepoRefResult", () => {
    it("local: ok:true with parseGitRemote's resolved owner/repo", async () => {
      mockParseGitRemote.mockReturnValue({ owner: "acme", repo: "widgets" });

      const result = await resolveRepoRefResult(fakeApp, { cwd: "/project", hostId: "local" });

      expect(mockParseGitRemote).toHaveBeenCalledWith("/project");
      expect(result).toEqual({ ok: true, value: { owner: "acme", repo: "widgets" } });
    });

    it("local: ok:true with value:null when there's no github.com remote — not an error", async () => {
      mockParseGitRemote.mockReturnValue(null);

      const result = await resolveRepoRefResult(fakeApp, { cwd: "/project", hostId: "local" });

      expect(result).toEqual({ ok: true, value: null });
    });

    it("remote: proxies to the remote client's resolveGitHubRepo", async () => {
      const mockResolveGitHubRepo = vi.fn().mockResolvedValue({ owner: "acme", repo: "widgets" });
      mockGetRemoteHostClient.mockReturnValue({ resolveGitHubRepo: mockResolveGitHubRepo });

      const result = await resolveRepoRefResult(fakeApp, {
        cwd: "/remote/project",
        hostId: "remote-host-1",
      });

      expect(mockResolveGitHubRepo).toHaveBeenCalledWith("/remote/project");
      expect(result).toEqual({ ok: true, value: { owner: "acme", repo: "widgets" } });
    });

    it("remote: an unreachable host maps to reason 'unreachable', not a thrown error", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveGitHubRepo: vi
          .fn()
          .mockRejectedValue(new HostUnreachableError("h1", new Error("ECONNREFUSED"))),
      });

      const result = await resolveRepoRefResult(fakeApp, {
        cwd: "/remote/project",
        hostId: "remote-host-1",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unreachable");
    });

    it("remote: an old agent build (404) maps to reason 'unsupported'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveGitHubRepo: vi.fn().mockRejectedValue(new HostRequestError("h1", 404, "")),
      });

      const result = await resolveRepoRefResult(fakeApp, {
        cwd: "/remote/project",
        hostId: "remote-host-1",
      });

      expect(result).toEqual({ ok: false, reason: "unsupported" });
    });
  });

  // The null-collapsing wrapper every non-projects.ts caller uses.
  describe("resolveRepoRef", () => {
    it("local: unwraps ok:true to the resolved repoRef", async () => {
      mockParseGitRemote.mockReturnValue({ owner: "acme", repo: "widgets" });

      const result = await resolveRepoRef(fakeApp, { cwd: "/project", hostId: "local" });

      expect(result).toEqual({ owner: "acme", repo: "widgets" });
    });

    it("local: unwraps ok:true/value:null to null", async () => {
      mockParseGitRemote.mockReturnValue(null);

      const result = await resolveRepoRef(fakeApp, { cwd: "/project", hostId: "local" });

      expect(result).toBeNull();
    });

    it("remote: collapses ok:false (any reason) to null, matching the pre-move bare catch's behavior", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        resolveGitHubRepo: vi
          .fn()
          .mockRejectedValue(new HostUnreachableError("h1", new Error("timeout"))),
      });

      const result = await resolveRepoRef(fakeApp, {
        cwd: "/remote/project",
        hostId: "remote-host-1",
      });

      expect(result).toBeNull();
    });
  });
});
