import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RemoteHostClient,
  HostUnreachableError,
  HostRequestError,
} from "../../src/services/remote-host-client.js";

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
    fetchMock.mockResolvedValue(jsonResponse(200, status));
    await expect(client().resolveGitStatus("/x/y")).resolves.toEqual(status);
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

  it("creates a remote worktree via a JSON-body POST to /internal/git-worktree (issue #100)", async () => {
    const result = { path: "/x/.tessera-worktrees/1", branch: "tessera/x-1" };
    fetchMock.mockResolvedValue(jsonResponse(200, result));
    const opts = {
      cwd: "/x",
      projectName: "x",
      sessionId: "1",
      prefix: "tessera/{project}-{id}",
    };
    await expect(client().createWorktree(opts)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-worktree",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(opts),
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("removes a remote worktree via a JSON-body POST to /internal/git-worktree/remove (issue #100)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const opts = { cwd: "/x", worktreePath: "/x/.tessera-worktrees/1" };
    await expect(client().removeWorktree(opts)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-worktree/remove",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(opts),
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
          "content-type": "application/json",
        }),
      }),
    );
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
    fetchMock.mockResolvedValue(jsonResponse(200, { path: "/remote/cwd/.tessera-uploads/x.png" }));
    const buffer = Buffer.from("fake png bytes");

    await expect(client().uploadImage("/remote/cwd", buffer, "image/png")).resolves.toEqual({
      path: "/remote/cwd/.tessera-uploads/x.png",
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
      Promise.resolve(jsonResponse(200, { path: "/x/.tessera-uploads/y.png" })),
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
});
