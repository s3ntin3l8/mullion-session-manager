import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildCanonicalString,
  hashBody,
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "../../src/services/request-signature.js";

// Issue #249 / roadmap 7.5 — the 5 non-request() sites (openAttach,
// openBrowserWs, openEventsStream, openPreviewWs) construct a real `ws`
// package WebSocket; mocked here the same way `fetch` is stubbed above, so
// the exact constructor args (in particular the headers option, which is
// where signing/auth headers land) can be asserted without an actual
// network connection attempt.
const wsConstructorCalls: Array<[string, unknown]> = [];
vi.mock("ws", () => ({
  WebSocket: class MockWebSocket {
    constructor(url: string, options: unknown) {
      wsConstructorCalls.push([url, options]);
    }
  },
}));

const { RemoteHostClient, HostUnreachableError, HostRequestError } =
  await import("../../src/services/remote-host-client.js");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RemoteHostClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    wsConstructorCalls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function client() {
    return new RemoteHostClient({
      hostId: "h1",
      baseUrl: "http://example.invalid:1234/",
      token: "tok",
    });
  }

  // Issue #249 / roadmap 7.5 — a session-credentialed client, the only kind
  // that ever signs anything.
  const DEFAULT_TEST_SESSION_SECRET = "session-secret"; // pragma: allowlist secret
  function sessionClient(sessionSecret = DEFAULT_TEST_SESSION_SECRET) {
    return new RemoteHostClient({
      hostId: "h1",
      baseUrl: "http://example.invalid:1234",
      token: "session-id-as-token",
      sessionSecret,
    });
  }

  it("sets the bearer token and strips a trailing slash from baseUrl", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await client().discover();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/discover",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  // Issue #245 / roadmap 7.1. Issue #249 / roadmap 7.5: refreshCredentials
  // returns {token, sessionSecret} together (renamed from refreshToken,
  // which only returned a bare string) — see remote-host-client.ts's own
  // comment on why a rotated session must refresh both fields as one unit.
  describe("retry-once-on-401 (session-credentialed hosts only)", () => {
    it("retries once with fresh credentials from refreshCredentials() on a 401, and succeeds", async () => {
      const refreshCredentials = vi
        .fn()
        .mockReturnValue({ token: "fresh-tok", sessionSecret: null });
      const c = new RemoteHostClient({
        hostId: "h1",
        baseUrl: "http://example.invalid:1234",
        token: "stale-tok",
        refreshCredentials,
      });
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse(200, []));

      await expect(c.discover()).resolves.toEqual([]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "http://example.invalid:1234/internal/discover",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer stale-tok" }),
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://example.invalid:1234/internal/discover",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer fresh-tok" }),
        }),
      );
      expect(refreshCredentials).toHaveBeenCalledTimes(1);
    });

    it("never retries more than once, even if the retry also 401s", async () => {
      const refreshCredentials = vi
        .fn()
        .mockReturnValue({ token: "still-fresh-tok", sessionSecret: null });
      const c = new RemoteHostClient({
        hostId: "h1",
        baseUrl: "http://example.invalid:1234",
        token: "stale-tok",
        refreshCredentials,
      });
      fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

      await expect(c.discover()).rejects.toThrow(HostRequestError);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(refreshCredentials).toHaveBeenCalledTimes(1);
    });

    it("does not retry when refreshCredentials() returns unchanged credentials (nothing to gain)", async () => {
      const refreshCredentials = vi
        .fn()
        .mockReturnValue({ token: "stale-tok", sessionSecret: null });
      const c = new RemoteHostClient({
        hostId: "h1",
        baseUrl: "http://example.invalid:1234",
        token: "stale-tok",
        refreshCredentials,
      });
      fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

      await expect(c.discover()).rejects.toThrow(HostRequestError);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries when only sessionSecret changed (token identical)", async () => {
      const refreshCredentials = vi
        .fn()
        .mockReturnValue({ token: "same-tok", sessionSecret: "new-secret" }); // pragma: allowlist secret
      const c = new RemoteHostClient({
        hostId: "h1",
        baseUrl: "http://example.invalid:1234",
        token: "same-tok",
        sessionSecret: "old-secret", // pragma: allowlist secret
        refreshCredentials,
      });
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse(200, []));

      await expect(c.discover()).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("never retries a manually-registered host (no refreshCredentials at all)", async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

      await expect(client().discover()).rejects.toThrow(HostRequestError);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry a non-401 4xx", async () => {
      const refreshCredentials = vi
        .fn()
        .mockReturnValue({ token: "fresh-tok", sessionSecret: null });
      const c = new RemoteHostClient({
        hostId: "h1",
        baseUrl: "http://example.invalid:1234",
        token: "tok",
        refreshCredentials,
      });
      fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

      await expect(c.discover()).rejects.toThrow(HostRequestError);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(refreshCredentials).not.toHaveBeenCalled();
    });
  });

  // Issue #647 / roadmap 7.8.
  describe("agent self-update (getUpdateStatus / applyUpdate)", () => {
    it("resolves this agent's update status via GET /internal/updates/status", async () => {
      const status = { phase: "idle" as const };
      fetchMock.mockResolvedValue(jsonResponse(200, status));
      await expect(client().getUpdateStatus()).resolves.toEqual(status);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://example.invalid:1234/internal/updates/status",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        }),
      );
    });

    it("POSTs the version/assetUrl/checksumUrl body to /internal/updates/apply", async () => {
      fetchMock.mockResolvedValue(jsonResponse(202, { phase: "downloading", version: "0.1.5" }));
      const body = {
        version: "0.1.5",
        assetUrl: "https://github.com/x/y/a.tgz",
        checksumUrl: "https://github.com/x/y/a.tgz.sha256",
      };

      await expect(client().applyUpdate(body)).resolves.toEqual({
        phase: "downloading",
        version: "0.1.5",
      });

      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { method: string; body: string; headers: Record<string, string> },
      ];
      expect(url).toBe("http://example.invalid:1234/internal/updates/apply");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual(body);
    });

    it("signs applyUpdate's body for a session-credentialed client", async () => {
      fetchMock.mockResolvedValue(jsonResponse(202, { phase: "downloading", version: "0.1.5" }));
      const body = {
        version: "0.1.5",
        assetUrl: "https://github.com/x/y/a.tgz",
        checksumUrl: "https://github.com/x/y/a.tgz.sha256",
      };

      await sessionClient("the-secret").applyUpdate(body);

      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { headers: Record<string, string>; body: string },
      ];
      const canonicalString = buildCanonicalString({
        method: "POST",
        requestTarget: "/internal/updates/apply",
        timestamp: init.headers[TIMESTAMP_HEADER],
        nonce: init.headers[NONCE_HEADER],
        bodyHashed: true,
        bodyHash: hashBody(init.body),
      });
      expect(verify("the-secret", canonicalString, init.headers[SIGNATURE_HEADER])).toBe(true);
    });

    it("surfaces a 404 apply response as HostRequestError (old agent build signal)", async () => {
      fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
      await expect(
        client().applyUpdate({ version: "0.1.5", assetUrl: "https://x", checksumUrl: "https://x" }),
      ).rejects.toThrow(HostRequestError);
    });
  });

  it("resolves this agent's effective config via /internal/config (issue #247)", async () => {
    const config = {
      role: "agent" as const,
      version: "0.2.20",
      projectsRoots: ["/x"],
      sessionsDir: "/x/sessions",
      crsConfigDir: "/x/.config/crs",
      browserEnabled: false,
      sshAuthSock: null,
    };
    fetchMock.mockResolvedValue(jsonResponse(200, config));
    await expect(client().resolveConfig()).resolves.toEqual(config);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/config",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("resolves a remote project's github owner/repo via /internal/github-repo (issue #27)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { owner: "o", repo: "r" }));
    await expect(client().resolveGitHubRepo("/x/y")).resolves.toEqual({ owner: "o", repo: "r" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/github-repo?cwd=%2Fx%2Fy",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("resolves null when the agent finds no github.com remote", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, null));
    await expect(client().resolveGitHubRepo("/x/y")).resolves.toBeNull();
  });

  it("resolves a remote project's current branch via /internal/git-branch (issue #96)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, "main"));
    await expect(client().resolveGitBranch("/x/y")).resolves.toBe("main");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-branch?cwd=%2Fx%2Fy",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  // Issue #431 — the client half of the agent-rules triple.
  it("resolves a remote project's agent-rules targets via /internal/agent-rules", async () => {
    const targets = [{ id: "claude-code:project", exists: false }];
    fetchMock.mockResolvedValue(jsonResponse(200, targets));
    await expect(client().resolveAgentRules("/x/y")).resolves.toEqual(targets);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/agent-rules?cwd=%2Fx%2Fy",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("PUTs new content to /internal/agent-rules/:target and returns the updated target", async () => {
    const updated = { id: "claude-code:project", exists: true, content: "hi" };
    fetchMock.mockResolvedValue(jsonResponse(200, updated));
    await expect(client().writeAgentRule("/x/y", "claude-code:project", "hi")).resolves.toEqual(
      updated,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/agent-rules/claude-code%3Aproject?cwd=%2Fx%2Fy",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ content: "hi" }),
      }),
    );
  });

  it("DELETEs /internal/agent-rules/:target and resolves undefined on 204", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client().deleteAgentRule("/x/y", "claude-code:project")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/agent-rules/claude-code%3Aproject?cwd=%2Fx%2Fy",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  // Issue #431, Hermes review on PR #458 — the names-only counterpart.
  it("resolves existing rule filenames via /internal/agent-rules/exists", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, ["CLAUDE.md"]));
    await expect(client().resolveExistingRuleFileNames("/x/y")).resolves.toEqual(["CLAUDE.md"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/agent-rules/exists?cwd=%2Fx%2Fy",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("resolves a remote project's git status via /internal/git-status (issue #76)", async () => {
    const status = {
      branch: "main",
      hash: "abc1234",
      ahead: 0,
      behind: 0,
      files: [],
      isClean: true,
      hasConflicts: false,
    };
    // { isRepo, status } envelope, not a bare GitStatus — see
    // /internal/git-status's own comment on why: it lets the primary tell
    // "not a repo" apart from "repo exists but git status failed
    // transiently" for a remote host too.
    fetchMock.mockResolvedValue(jsonResponse(200, { isRepo: true, status }));
    await expect(client().resolveGitStatus("/x/y")).resolves.toEqual({ isRepo: true, status });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-status?cwd=%2Fx%2Fy",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  // #484 — opts.fresh appends &fresh=1 and requests the same cache-bypassing
  // read task-promote.ts's dirty-tree gate needs; every other caller omits
  // it and keeps the cached read (unchanged from the test right above).
  it("resolveGitStatus({fresh:true}) appends &fresh=1", async () => {
    const status = {
      branch: "main",
      hash: "abc1234",
      ahead: 0,
      behind: 0,
      files: [],
      isClean: false,
      hasConflicts: false,
    };
    fetchMock.mockResolvedValue(jsonResponse(200, { isRepo: true, status }));
    await expect(client().resolveGitStatus("/x/y", { fresh: true })).resolves.toEqual({
      isRepo: true,
      status,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-status?cwd=%2Fx%2Fy&fresh=1",
      expect.anything(),
    );
  });

  describe("#484 — task-git proxy methods (host-git.ts's remote branch)", () => {
    it("resolveHostBaseRef hits /internal/git-base-ref and returns { baseRef, sha } verbatim", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { baseRef: "origin/main", sha: "deadbeef" }));
      await expect(client().resolveHostBaseRef("/x/y")).resolves.toEqual({
        baseRef: "origin/main",
        sha: "deadbeef",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://example.invalid:1234/internal/git-base-ref?cwd=%2Fx%2Fy",
        expect.anything(),
      );
    });

    it("resolvePushBranch POSTs {cwd, branch, token} to /internal/git-push and returns the PushResult", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
      await expect(
        client().resolvePushBranch("/x/y", "mullion/task-1", "ghp_token"),
      ).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://example.invalid:1234/internal/git-push",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ cwd: "/x/y", branch: "mullion/task-1", token: "ghp_token" }),
        }),
      );
    });

    it("resolveTaskWorktreeDirs unwraps /internal/git-worktree/task-dirs's { dirs } envelope to a bare string[]", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { dirs: ["/x/y/.mullion-worktrees/mullion-task-1"] }),
      );
      await expect(client().resolveTaskWorktreeDirs("/x/y")).resolves.toEqual([
        "/x/y/.mullion-worktrees/mullion-task-1",
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://example.invalid:1234/internal/git-worktree/task-dirs?cwd=%2Fx%2Fy",
        expect.anything(),
      );
    });

    it("resolveResumeTaskWorktree POSTs {cwd, branchName} to /internal/git-worktree/resume", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          path: "/x/y/.mullion-worktrees/mullion-task-1",
          branch: "mullion/task-1",
        }),
      );
      await expect(client().resolveResumeTaskWorktree("/x/y", "mullion/task-1")).resolves.toEqual({
        path: "/x/y/.mullion-worktrees/mullion-task-1",
        branch: "mullion/task-1",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://example.invalid:1234/internal/git-worktree/resume",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ cwd: "/x/y", branchName: "mullion/task-1" }),
        }),
      );
    });

    it("resolveResumeTaskWorktree resolves null (not an error) for a git-level resume failure", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, null));
      await expect(
        client().resolveResumeTaskWorktree("/x/y", "mullion/task-1"),
      ).resolves.toBeNull();
    });

    // #760
    it("resolveReadTaskReviewFindings GETs /internal/task-review-findings and unwraps { content }", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { content: "## Round 0\n\nLooks good." }));
      await expect(client().resolveReadTaskReviewFindings(7, 0)).resolves.toBe(
        "## Round 0\n\nLooks good.",
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "http://example.invalid:1234/internal/task-review-findings?taskId=7&round=0",
        expect.anything(),
      );
    });

    it("resolveReadTaskReviewFindings resolves null (not an error) for a genuinely absent file — a real 200 response", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { content: null }));
      await expect(client().resolveReadTaskReviewFindings(7, 0)).resolves.toBeNull();
    });

    // #760's own stated safety requirement — the #590 lesson (HostRequestError
    // covers ANY 4xx, not just 404) applies directly here: a peer build too
    // old to have this route returns a genuine 404, which must throw, never
    // resolve to `null` the way a real "file absent" response does above. A
    // caller that collapsed these two would misread "this peer doesn't even
    // have the route" as "the review wrote nothing" and post a false
    // inconclusive comment.
    it("resolveReadTaskReviewFindings throws HostRequestError (not null) on a 404 — a peer build too old to have this route (version skew)", async () => {
      fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
      await expect(client().resolveReadTaskReviewFindings(7, 0)).rejects.toThrow(HostRequestError);
    });

    it("resolveReadTaskReviewFindings throws HostUnreachableError on a network failure, same as every other call", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      await expect(client().resolveReadTaskReviewFindings(7, 0)).rejects.toThrow(
        HostUnreachableError,
      );
    });

    it("resolveDeleteTaskReviewFindings DELETEs /internal/task-review-findings with taskId/round", async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      await client().resolveDeleteTaskReviewFindings(7, 0);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://example.invalid:1234/internal/task-review-findings?taskId=7&round=0",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    // #778 — mirrors resolveReadTaskReviewFindings's own shape/tests exactly.
    it("resolveReadTaskCommitTitle GETs /internal/task-commit-title and unwraps { content }", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { content: "fix: handle the edge case" }));
      await expect(client().resolveReadTaskCommitTitle(7)).resolves.toBe(
        "fix: handle the edge case",
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "http://example.invalid:1234/internal/task-commit-title?taskId=7",
        expect.anything(),
      );
    });

    it("resolveReadTaskCommitTitle resolves null (not an error) for a genuinely absent file — a real 200 response", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { content: null }));
      await expect(client().resolveReadTaskCommitTitle(7)).resolves.toBeNull();
    });

    it("resolveReadTaskCommitTitle throws HostRequestError (not null) on a 404 — a peer build too old to have this route (version skew)", async () => {
      fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
      await expect(client().resolveReadTaskCommitTitle(7)).rejects.toThrow(HostRequestError);
    });

    it("resolveReadTaskCommitTitle throws HostUnreachableError on a network failure, same as every other call", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      await expect(client().resolveReadTaskCommitTitle(7)).rejects.toThrow(HostUnreachableError);
    });

    // These four calls each wrap an agent-side git shell-out well above
    // REQUEST_TIMEOUT_MS's 5s default (git-push.ts 30s, git-refs.ts up to
    // ~50s across its chained calls, git-worktree.ts 15s) — without an
    // override, this client would raise HostUnreachableError while the
    // agent's own git call is still running, e.g. reporting push-failed on
    // a branch that actually landed. See the constants' own comments.
    it("gives each task-git proxy call a longer timeout than an ordinary request", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, { ok: true })));

      await client().discover();
      const defaultTimeout = timeoutSpy.mock.calls.at(-1)?.[0] as number;

      timeoutSpy.mockClear();
      await client().resolvePushBranch("/x", "mullion/task-1", "tok");
      const pushTimeout = timeoutSpy.mock.calls.at(-1)?.[0] as number;

      timeoutSpy.mockClear();
      await client().resolveHostBaseRef("/x");
      const baseRefTimeout = timeoutSpy.mock.calls.at(-1)?.[0] as number;

      timeoutSpy.mockClear();
      await client().resolveResumeTaskWorktree("/x", "mullion/task-1");
      const resumeTimeout = timeoutSpy.mock.calls.at(-1)?.[0] as number;

      timeoutSpy.mockClear();
      await client().resolveGitStatus("/x", { fresh: true });
      const freshStatusTimeout = timeoutSpy.mock.calls.at(-1)?.[0] as number;

      expect(pushTimeout).toBeGreaterThan(defaultTimeout);
      expect(baseRefTimeout).toBeGreaterThan(defaultTimeout);
      expect(resumeTimeout).toBeGreaterThan(defaultTimeout);
      expect(freshStatusTimeout).toBeGreaterThan(defaultTimeout);
      // No fixed ordering asserted between the four — each is sized off its
      // own agent-side budget (git-push.ts/git-refs.ts/git-worktree.ts/
      // git-status.ts's own GIT_TIMEOUT_MS constants), which move
      // independently of each other. Push is now the largest of the four
      // (#722/#725 — its 120s single-op budget was raised so `--no-verify`
      // doesn't also have to cover a slow target-repo pre-push hook), having
      // previously been smaller than base-ref's ~50s chained-calls budget —
      // asserting one specific ordering here just makes this test brittle
      // against either budget changing for an unrelated reason.

      timeoutSpy.mockRestore();
    });

    it("a plain (non-fresh) resolveGitStatus call keeps the default timeout, unlike its fresh:true sibling", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { isRepo: false, status: null })),
      );

      await client().resolveGitStatus("/x");
      const plainTimeout = timeoutSpy.mock.calls.at(-1)?.[0] as number;

      timeoutSpy.mockClear();
      await client().resolveGitStatus("/x", { fresh: true });
      const freshTimeout = timeoutSpy.mock.calls.at(-1)?.[0] as number;

      expect(freshTimeout).toBeGreaterThan(plainTimeout);
      timeoutSpy.mockRestore();
    });
  });

  it("resolves a remote project's branches and worktrees via /internal/git-branches (issue #162)", async () => {
    const result = {
      branches: [{ name: "main", isCurrent: true }],
      worktrees: [{ path: "/x/y", branch: "main", isMain: true }],
    };
    fetchMock.mockResolvedValue(jsonResponse(200, result));
    await expect(client().resolveGitBranches("/x/y")).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-branches?cwd=%2Fx%2Fy",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  // Issue #442 — mirrors the public route's own `?detail=1` opt-in.
  it("appends &detail=1 to /internal/git-branches only when detail is truthy", async () => {
    const emptyResult = { branches: [], worktrees: [], remoteBranches: [] };
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, emptyResult)));
    await client().resolveGitBranches("/x/y", true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-branches?cwd=%2Fx%2Fy&detail=1",
      expect.anything(),
    );

    fetchMock.mockClear();
    await client().resolveGitBranches("/x/y", false);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-branches?cwd=%2Fx%2Fy",
      expect.anything(),
    );
  });

  it("deletes a remote branch via /internal/git-branch-delete (issue #442)", async () => {
    const result = { deleted: true };
    fetchMock.mockResolvedValue(jsonResponse(200, result));
    await expect(client().resolveDeleteBranch("/x/y", "feature", true)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-branch-delete",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        body: JSON.stringify({ cwd: "/x/y", name: "feature", force: true }),
      }),
    );
  });

  it("removes a remote listed worktree via /internal/git-worktree/remove-listed (issue #442)", async () => {
    const result = { removed: true };
    fetchMock.mockResolvedValue(jsonResponse(200, result));
    await expect(
      client().resolveRemoveListedWorktree("/x/y", "/x/y/.mullion-worktrees/foo", true),
    ).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-worktree/remove-listed",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        body: JSON.stringify({
          cwd: "/x/y",
          worktreePath: "/x/y/.mullion-worktrees/foo",
          force: true,
        }),
      }),
    );
  });

  it("prunes remote worktree metadata via /internal/git-worktree/prune-metadata (issue #442)", async () => {
    const result = { pruned: true };
    fetchMock.mockResolvedValue(jsonResponse(200, result));
    await expect(client().resolvePruneWorktreeMetadata("/x/y")).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-worktree/prune-metadata",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        body: JSON.stringify({ cwd: "/x/y" }),
      }),
    );
  });

  it("checks out a remote dock-preview branch via /internal/git-worktree/checkout (issue #345)", async () => {
    const result = { path: "/x/y/.mullion-worktrees/dock-preview-main-abc123", branch: "main" };
    fetchMock.mockResolvedValue(jsonResponse(200, result));
    await expect(client().resolveCheckoutBranchWorktree("/x/y", "main")).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-worktree/checkout",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        body: JSON.stringify({ cwd: "/x/y", branch: "main" }),
      }),
    );
  });

  it("returns null when a remote checkout fails for a git-level reason (issue #345)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, null));
    await expect(client().resolveCheckoutBranchWorktree("/x/y", "no-such-branch")).resolves.toBe(
      null,
    );
  });

  it("force-removes a remote dock-preview worktree via /internal/git-worktree/force-remove, unwrapping {removed} (issue #345)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { removed: true }));
    await expect(
      client().resolveRemoveWorktree("/x/y/.mullion-worktrees/foo", "/x/y"),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-worktree/force-remove",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        body: JSON.stringify({
          worktreePath: "/x/y/.mullion-worktrees/foo",
          parentCwd: "/x/y",
        }),
      }),
    );
  });

  it("syncs a remote dock-preview worktree via /internal/git-worktree/sync, unwrapping {synced} (issue #345)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { synced: false }));
    await expect(client().resolveSyncWorktree("/x/y/.mullion-worktrees/foo", "main")).resolves.toBe(
      false,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-worktree/sync",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
        body: JSON.stringify({ worktreePath: "/x/y/.mullion-worktrees/foo", branch: "main" }),
      }),
    );
  });

  it("resolves a remote session's diff stats via /internal/git-diff (issue #202)", async () => {
    const stats = { filesChanged: 2, insertions: 5, deletions: 1 };
    // { isRepo, stats } envelope, same "durable vs. transient" reasoning as
    // resolveGitStatus's own { isRepo, status } above.
    fetchMock.mockResolvedValue(jsonResponse(200, { isRepo: true, stats }));
    await expect(client().resolveGitDiffStats("/x/y")).resolves.toEqual({ isRepo: true, stats });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-diff?cwd=%2Fx%2Fy",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("resolves a remote session's scrollback via /internal/sessions/:id/scrollback, decoding base64 back to a Buffer (Phase 4, #187)", async () => {
    const original = "hello scrollback";
    fetchMock.mockResolvedValue(
      jsonResponse(200, { b64: Buffer.from(original, "utf8").toString("base64") }),
    );
    const result = await client().resolveScrollback("42");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString("utf8")).toBe(original);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/sessions/42/scrollback",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("resolves an empty Buffer for a session id the agent has never tracked", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { b64: "" }));
    const result = await client().resolveScrollback("never-spawned");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("never follows redirects, closing the SSRF bypass a 3xx response would otherwise open (Hermes review, PR #34)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await client().discover();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "manual" }),
    );

    fetchMock.mockClear();
    await client().ping();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("pins every outbound transport to a validated address (issue #250)", async () => {
    // The complement to the redirect test above: `redirect: "manual"` stops
    // a 3xx from moving the target, this stops DNS from moving it. Only the
    // wiring is asserted here — that the guard itself is correct is
    // pinned-connect.test.ts's job, and neither this fetch stub nor undici's
    // MockAgent can exercise a real connect.
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    await client().discover();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ dispatcher: expect.anything() }),
    );

    // ping() builds its own fetch rather than going through rawFetch, so it
    // has to be checked separately or it silently stays unpinned.
    fetchMock.mockClear();
    await client().ping();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ dispatcher: expect.anything() }),
    );

    // ...and a WS upgrade takes an http(s).Agent, which no dispatcher covers.
    client().openAttach({ id: "s1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const [, wsOptions] = wsConstructorCalls[0] as [string, { agent?: unknown }];
    expect(wsOptions.agent).toBeDefined();
  });

  it("openAttach's request target stays well under Node's 16 KB header limit at max-legal env (issue #822)", () => {
    // openAttach() has nowhere to put `env` but the WS upgrade's query
    // string — a GET has no body, and `ws` exposes no custom-body-on-upgrade
    // option — so it shares Node's default --max-http-header-size (16 KB)
    // with the request line, the Bearer token, and the three HMAC signature
    // headers. This pins MAX_SESSION_ENV_ENTRIES/MAX_SESSION_ENV_VALUE_LENGTH
    // (session-lifecycle.ts) as load-bearing: raising either without
    // re-running this test is how the old 64x4096 bound (~263 KB encoded,
    // well past --max-http-header-size) would have shipped a remote
    // reattach whose WS upgrade request target can't fit the limit.
    const worstCaseEnv: Record<string, string> = {};
    for (let i = 0; i < 16; i++) {
      worstCaseEnv[`VAR_${i}`] = "x".repeat(256);
    }
    client().openAttach({
      id: "s1",
      cwd: "/home/bjoern/projects/some-reasonably-long-project-path",
      command: "claude --dangerously-skip-permissions",
      cols: 80,
      rows: 24,
      projectId: 123,
      env: worstCaseEnv,
    });
    const [url] = wsConstructorCalls[0] as [string, unknown];
    const requestTarget = url.slice(url.indexOf("/internal/"));
    // Leaves several KB of headroom for the Bearer token + HMAC headers,
    // which are all short, fixed-shape strings (see signatureHeaders).
    expect(requestTarget.length).toBeLessThan(8 * 1024);
  });

  it("refuses to dial a baseUrl that has since become disallowed (issue #250)", async () => {
    // baseUrl is read from a DB row on every request, so the check that ran
    // when the host was registered isn't a check on what's being dialed now.
    // A lookup would never catch this one — it isn't consulted for a literal.
    const imdsClient = new RemoteHostClient({
      hostId: "h1",
      baseUrl: "http://169.254.169.254",
      token: "tok",
    });
    const err = await imdsClient.discover().catch((e) => e);
    expect(err).toBeInstanceOf(HostUnreachableError);
    expect((err as HostUnreachableError).ssrfBlocked).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws HostUnreachableError on a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const err = await client()
      .discover()
      .catch((e) => e);
    expect(err).toBeInstanceOf(HostUnreachableError);
    // An ordinary failure must NOT be reported as a guard block, or the
    // distinction is worthless.
    expect((err as HostUnreachableError).ssrfBlocked).toBeNull();
  });

  it("throws HostUnreachableError (not HostRequestError) on a 5xx response", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 503 }));
    await expect(client().discover()).rejects.toThrow(HostUnreachableError);
  });

  it("throws HostRequestError, carrying the status, on a 4xx response (Hermes review, PR #34)", async () => {
    fetchMock.mockResolvedValue(new Response("cwd not in roots", { status: 400 }));
    const err = await client()
      .resolveActions("/x")
      .catch((e) => e);
    expect(err).toBeInstanceOf(HostRequestError);
    expect(err).not.toBeInstanceOf(HostUnreachableError);
    expect((err as HostRequestError).statusCode).toBe(400);
  });

  it("returns undefined for a 204 response without attempting to parse a body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client().terminate("1")).resolves.toBeUndefined();
  });

  it("posts a review-gate decision to /internal/sessions/:id/review-gate and returns its ok flag (issue #178)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await expect(client().resolveReviewGate("1", "denied", "looks unsafe")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/sessions/1/review-gate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "denied", reason: "looks unsafe" }),
      }),
    );
  });

  it("resolveReviewGate returns false when the agent reports nothing was pending", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: false }));
    await expect(client().resolveReviewGate("1", "approved")).resolves.toBe(false);
  });

  it("bypasses fetch entirely for an empty ids array", async () => {
    await expect(client().bulkLiveStatus([], 1000)).resolves.toEqual({});
    await expect(client().bulkIsMasterAlive([])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches bulkLiveStatus for the same id set within the TTL window", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { "1": null }));
    const c = client();
    await c.bulkLiveStatus(["1"], 1000);
    await c.bulkLiveStatus(["1"], 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse the cache for a different idleThresholdMs", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, { "1": null })));
    const c = client();
    await c.bulkLiveStatus(["1"], 1000);
    await c.bulkLiveStatus(["1"], 2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight bulkLiveStatus calls for the same key (Hermes review, PR #34)", async () => {
    let resolveFetch: (res: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const c = client();

    const p1 = c.bulkLiveStatus(["1", "2"], 1000);
    const p2 = c.bulkLiveStatus(["2", "1"], 1000); // same key regardless of id order
    resolveFetch(jsonResponse(200, { "1": null, "2": null }));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ "1": null, "2": null });
    expect(r2).toEqual({ "1": null, "2": null });
  });

  it("uploads a raw image body to /internal/uploads with cwd/mime as query params (issue #68)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { path: "/remote/cwd/.mullion-uploads/x.png" }));
    const buffer = Buffer.from("fake png bytes");

    await expect(client().uploadImage("/remote/cwd", buffer, "image/png")).resolves.toEqual({
      path: "/remote/cwd/.mullion-uploads/x.png",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/uploads?cwd=%2Fremote%2Fcwd&mime=image%2Fpng",
      expect.objectContaining({
        method: "POST",
        body: buffer,
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
          "content-type": "image/png",
        }),
      }),
    );
  });

  it("gives uploadImage a longer timeout than an ordinary request (issue #68 — up to 10 MiB over a WAN link)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { path: "/x/.mullion-uploads/y.png" })),
    );

    await client().uploadImage("/x", Buffer.from("a"), "image/png");
    const uploadTimeout = timeoutSpy.mock.calls.at(-1)?.[0] as number;

    timeoutSpy.mockClear();
    await client().discover();
    const defaultTimeout = timeoutSpy.mock.calls.at(-1)?.[0] as number;

    expect(uploadTimeout).toBeGreaterThan(defaultTimeout);
    timeoutSpy.mockRestore();
  });

  it("ping returns true for a reachable agent and false on failure, without throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await client().ping()).toBe(true);

    fetchMock.mockRejectedValueOnce(new Error("refused"));
    expect(await client().ping()).toBe(false);
  });

  // Issue #249 / roadmap 7.5.
  describe("HMAC request signing (session-credentialed hosts only)", () => {
    it("sends no signature headers at all for a static-token (non-session) client", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, []));
      await client().discover();
      const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(init.headers[SIGNATURE_HEADER]).toBeUndefined();
      expect(init.headers[TIMESTAMP_HEADER]).toBeUndefined();
      expect(init.headers[NONCE_HEADER]).toBeUndefined();
    });

    it("sends a signature that verifies against the session secret, plus a fresh timestamp/nonce", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, []));
      await sessionClient("the-secret").discover();

      const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      const signature = init.headers[SIGNATURE_HEADER];
      const timestamp = init.headers[TIMESTAMP_HEADER];
      const nonce = init.headers[NONCE_HEADER];
      expect(signature).toEqual(expect.any(String));
      expect(Number(timestamp)).toBeCloseTo(Date.now(), -2);
      expect(nonce).toEqual(expect.any(String));

      const canonicalString = buildCanonicalString({
        method: "GET",
        requestTarget: "/internal/discover",
        timestamp,
        nonce,
        bodyHashed: true,
        bodyHash: hashBody(""),
      });
      expect(verify("the-secret", canonicalString, signature)).toBe(true);
    });

    it("hashes the actual JSON body for a POST request", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, {}));
      await sessionClient("the-secret").spawn({
        id: "s1",
        cwd: "/x",
        command: "bash",
        cols: 80,
        rows: 24,
      });

      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { headers: Record<string, string>; body: string },
      ];
      const canonicalString = buildCanonicalString({
        method: "POST",
        requestTarget: "/internal/sessions",
        timestamp: init.headers[TIMESTAMP_HEADER],
        nonce: init.headers[NONCE_HEADER],
        bodyHashed: true,
        bodyHash: hashBody(init.body),
      });
      expect(verify("the-secret", canonicalString, init.headers[SIGNATURE_HEADER])).toBe(true);
    });

    it("uses a different nonce on every call", async () => {
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, [])));
      const c = sessionClient();
      await c.discover();
      await c.discover();
      const nonce1 = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers[
        NONCE_HEADER
      ];
      const nonce2 = (fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers[
        NONCE_HEADER
      ];
      expect(nonce1).not.toBe(nonce2);
    });

    it("does not hash the body for an unsigned-body path (uploadImage -> /internal/uploads)", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { path: "/x/y.png" }));
      await sessionClient("the-secret").uploadImage(
        "/x",
        Buffer.from("real-image-bytes"),
        "image/png",
      );

      const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      const canonicalString = buildCanonicalString({
        method: "POST",
        requestTarget: "/internal/uploads?cwd=%2Fx&mime=image%2Fpng",
        timestamp: init.headers[TIMESTAMP_HEADER],
        nonce: init.headers[NONCE_HEADER],
        bodyHashed: false,
        bodyHash: "",
      });
      expect(verify("the-secret", canonicalString, init.headers[SIGNATURE_HEADER])).toBe(true);
    });

    it("re-signs with a fresh nonce and the fresh secret on a 401 retry, not the stale one", async () => {
      const refreshCredentials = vi
        .fn()
        .mockReturnValue({ token: "new-session-id", sessionSecret: "new-secret" }); // pragma: allowlist secret
      const c = new RemoteHostClient({
        hostId: "h1",
        baseUrl: "http://example.invalid:1234",
        token: "old-session-id",
        sessionSecret: "old-secret", // pragma: allowlist secret
        refreshCredentials,
      });
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse(200, []));

      await expect(c.discover()).resolves.toEqual([]);

      const [, firstInit] = fetchMock.mock.calls[0] as [
        string,
        { headers: Record<string, string> },
      ];
      const [, secondInit] = fetchMock.mock.calls[1] as [
        string,
        { headers: Record<string, string> },
      ];
      // Different nonces — the retry is a fresh signing pass, not a replay
      // of the first attempt's headers.
      expect(firstInit.headers[NONCE_HEADER]).not.toBe(secondInit.headers[NONCE_HEADER]);

      // The second attempt's signature verifies against the NEW secret, not
      // the old one (which would make a second consecutive 401 permanent).
      const secondCanonical = buildCanonicalString({
        method: "GET",
        requestTarget: "/internal/discover",
        timestamp: secondInit.headers[TIMESTAMP_HEADER],
        nonce: secondInit.headers[NONCE_HEADER],
        bodyHashed: true,
        bodyHash: hashBody(""),
      });
      expect(verify("new-secret", secondCanonical, secondInit.headers[SIGNATURE_HEADER])).toBe(
        true,
      );
      expect(verify("old-secret", secondCanonical, secondInit.headers[SIGNATURE_HEADER])).toBe(
        false,
      );
    });

    describe("the 5 non-request() sites", () => {
      it("openAttach signs the WS upgrade for a session-credentialed host", () => {
        sessionClient("the-secret").openAttach({
          id: "s1",
          cwd: "/x",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        const [url, options] = wsConstructorCalls[0] as [
          string,
          { headers: Record<string, string> },
        ];
        expect(url).toMatch(/^ws:\/\/example\.invalid:1234\/internal\/ws\/attach\?/);
        const requestTarget = url.replace("ws://example.invalid:1234", "");
        const canonicalString = buildCanonicalString({
          method: "GET",
          requestTarget,
          timestamp: options.headers[TIMESTAMP_HEADER],
          nonce: options.headers[NONCE_HEADER],
          bodyHashed: true,
          bodyHash: hashBody(""),
        });
        expect(verify("the-secret", canonicalString, options.headers[SIGNATURE_HEADER])).toBe(true);
      });

      it("openAttach sends no signature headers for a static-token host", () => {
        client().openAttach({ id: "s1", cwd: "/x", command: "bash", cols: 80, rows: 24 });
        const [, options] = wsConstructorCalls[0] as [string, { headers: Record<string, string> }];
        expect(options.headers[SIGNATURE_HEADER]).toBeUndefined();
      });

      it("openBrowserWs signs the WS upgrade for a session-credentialed host", () => {
        sessionClient("the-secret").openBrowserWs(1, 2);
        const [url, options] = wsConstructorCalls[0] as [
          string,
          { headers: Record<string, string> },
        ];
        const requestTarget = url.replace("ws://example.invalid:1234", "");
        const canonicalString = buildCanonicalString({
          method: "GET",
          requestTarget,
          timestamp: options.headers[TIMESTAMP_HEADER],
          nonce: options.headers[NONCE_HEADER],
          bodyHashed: true,
          bodyHash: hashBody(""),
        });
        expect(verify("the-secret", canonicalString, options.headers[SIGNATURE_HEADER])).toBe(true);
      });

      it("openEventsStream signs the WS upgrade for a session-credentialed host", () => {
        sessionClient("the-secret").openEventsStream();
        const [url, options] = wsConstructorCalls[0] as [
          string,
          { headers: Record<string, string> },
        ];
        expect(url).toBe("ws://example.invalid:1234/internal/ws/events");
        const canonicalString = buildCanonicalString({
          method: "GET",
          requestTarget: "/internal/ws/events",
          timestamp: options.headers[TIMESTAMP_HEADER],
          nonce: options.headers[NONCE_HEADER],
          bodyHashed: true,
          bodyHash: hashBody(""),
        });
        expect(verify("the-secret", canonicalString, options.headers[SIGNATURE_HEADER])).toBe(true);
      });

      // Regression test (Hermes review, PR #564 round 4): without this,
      // `ws`'s 100 MiB default leaves both callers (relayRemoteEventsHost,
      // remote-event-subscriber.ts) exposed to an oversized frame from a
      // buggy or compromised agent.
      it("openEventsStream bounds inbound frames at 1 MiB, matching plugins/websocket.ts's own server-side cap", () => {
        sessionClient("the-secret").openEventsStream();
        const [, options] = wsConstructorCalls[0] as [string, { maxPayload: number }];
        expect(options.maxPayload).toBe(1024 * 1024);
      });

      it("openPreviewWs signs the WS upgrade for a session-credentialed host", () => {
        sessionClient("the-secret").openPreviewWs(5173, "/hmr");
        const [url, options] = wsConstructorCalls[0] as [
          string,
          { headers: Record<string, string> },
        ];
        const requestTarget = url.replace("ws://example.invalid:1234", "");
        const canonicalString = buildCanonicalString({
          method: "GET",
          requestTarget,
          timestamp: options.headers[TIMESTAMP_HEADER],
          nonce: options.headers[NONCE_HEADER],
          bodyHashed: true,
          bodyHash: hashBody(""),
        });
        expect(verify("the-secret", canonicalString, options.headers[SIGNATURE_HEADER])).toBe(true);
      });

      it("openPreviewHttp signs the request and does not hash the (streamed) body", async () => {
        fetchMock.mockResolvedValue(new Response("upstream body", { status: 200 }));
        await sessionClient("the-secret").openPreviewHttp(5173, "/index.html", {
          method: "GET",
          headers: new Headers(),
        });
        const [, init] = fetchMock.mock.calls[0] as [string, { headers: Headers }];
        const canonicalString = buildCanonicalString({
          method: "GET",
          requestTarget: "/internal/preview/5173/index.html",
          timestamp: init.headers.get(TIMESTAMP_HEADER)!,
          nonce: init.headers.get(NONCE_HEADER)!,
          bodyHashed: false,
          bodyHash: "",
        });
        expect(verify("the-secret", canonicalString, init.headers.get(SIGNATURE_HEADER)!)).toBe(
          true,
        );
      });

      // Independent review finding: init.headers here is seeded from a
      // BROWSER-controlled request forwarded through the preview proxy — a
      // browser must not be able to inject its own signature/auth headers
      // and have them survive to the outbound request.
      it("openPreviewHttp strips caller-supplied authorization/signature headers before setting its own", async () => {
        fetchMock.mockResolvedValue(new Response("upstream body", { status: 200 }));
        const maliciousHeaders = new Headers({
          authorization: "Bearer attacker-controlled",
          [SIGNATURE_HEADER]: "attacker-controlled-signature",
          [TIMESTAMP_HEADER]: "attacker-controlled-timestamp",
          [NONCE_HEADER]: "attacker-controlled-nonce",
        });
        await sessionClient("the-secret").openPreviewHttp(5173, "/index.html", {
          method: "GET",
          headers: maliciousHeaders,
        });

        const [, init] = fetchMock.mock.calls[0] as [string, { headers: Headers }];
        expect(init.headers.get("authorization")).toBe("Bearer session-id-as-token");
        expect(init.headers.get(SIGNATURE_HEADER)).not.toBe("attacker-controlled-signature");
        expect(init.headers.get(TIMESTAMP_HEADER)).not.toBe("attacker-controlled-timestamp");
        expect(init.headers.get(NONCE_HEADER)).not.toBe("attacker-controlled-nonce");
      });

      it("openPreviewHttp for a static-token host strips a browser-injected signature header entirely, rather than passing it through unsigned", async () => {
        fetchMock.mockResolvedValue(new Response("upstream body", { status: 200 }));
        const maliciousHeaders = new Headers({
          [SIGNATURE_HEADER]: "attacker-controlled-signature",
          [TIMESTAMP_HEADER]: "attacker-controlled-timestamp",
          [NONCE_HEADER]: "attacker-controlled-nonce",
        });
        await client().openPreviewHttp(5173, "/index.html", {
          method: "GET",
          headers: maliciousHeaders,
        });

        const [, init] = fetchMock.mock.calls[0] as [string, { headers: Headers }];
        expect(init.headers.has(SIGNATURE_HEADER)).toBe(false);
        expect(init.headers.has(TIMESTAMP_HEADER)).toBe(false);
        expect(init.headers.has(NONCE_HEADER)).toBe(false);
      });
    });
  });
});
