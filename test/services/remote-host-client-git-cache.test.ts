// Issue #2991: RemoteHostClient shares identical git-status / git-diff reads.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { RemoteHostClient, HostUnreachableError } =
  await import("../../src/services/remote-host-client.js");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RemoteHostClient git read sharing", () => {
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

  afterEach(() => vi.useRealTimers());

  const status = { isRepo: true, status: { branch: "main", files: [], isClean: true } };
  const diff = { isRepo: true, stats: { filesChanged: 1, insertions: 2, deletions: 3 } };

  it("concurrent status reads for one cwd share a single request", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, status));
    const c = client();
    const results = await Promise.all([
      c.resolveGitStatus("/x/y"),
      c.resolveGitStatus("/x/y"),
      c.resolveGitStatus("/x/y"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[2]).toEqual(status);
  });

  it("a read inside the TTL is served from cache, one after it refetches", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, status)));
    const c = client();
    await c.resolveGitStatus("/x/y");
    await c.resolveGitStatus("/x/y");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_001);
    await c.resolveGitStatus("/x/y");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("different cwds and different bases are separate reads", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, diff)));
    const c = client();
    await c.resolveGitDiffStats("/a", "AUTO");
    await c.resolveGitDiffStats("/a", "AUTO");
    await c.resolveGitDiffStats("/b", "AUTO");
    await c.resolveGitDiffStats("/a", "origin/main");
    await c.resolveGitDiffStats("/a");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a fresh read always reaches the agent and never poisons the cache", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, status)));
    const c = client();
    await c.resolveGitStatus("/x/y");
    await c.resolveGitStatus("/x/y", { fresh: true });
    await c.resolveGitStatus("/x/y", { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("fresh=1");

    // Concurrent fresh reads do not join one another either.
    fetchMock.mockClear();
    await Promise.all([
      c.resolveGitDiffStats("/x/y", "AUTO", { fresh: true }),
      c.resolveGitDiffStats("/x/y", "AUTO", { fresh: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A fresh read leaves a cached non-fresh result untouched.
    fetchMock.mockClear();
    await c.resolveGitStatus("/x/y");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never caches a failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const c = client();
    await expect(c.resolveGitStatus("/x/y")).rejects.toBeInstanceOf(HostUnreachableError);
    fetchMock.mockResolvedValue(jsonResponse(200, status));
    await expect(c.resolveGitStatus("/x/y")).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
