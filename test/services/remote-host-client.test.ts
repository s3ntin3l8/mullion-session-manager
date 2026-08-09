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

  it("resolves this agent's effective config via /internal/config (issue #247)", async () => {
    const config = {
      role: "agent" as const,
      version: "0.2.20",
      projectsRoots: ["/x"],
      sessionsDir: "/x/sessions",
      crsConfigDir: "/x/.config/crs",
      browserEnabled: false,
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

  it("throws HostUnreachableError on a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(client().discover()).rejects.toThrow(HostUnreachableError);
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
