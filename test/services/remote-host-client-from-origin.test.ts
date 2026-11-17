// Issue #3194 — the agent-side "resume from origin" call.
//
// A retry that was re-placed onto a host the branch has never been on asks
// that host's agent to FETCH the branch from origin and check it out there.
// That is the `fromOrigin` flag on /internal/git-worktree/resume.
//
// The ordinary resume (the branch is already on that host) is covered in
// remote-host-client.test.ts; this file owns the re-placed half.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { RemoteHostClient } = await import("../../src/services/remote-host-client.js");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RemoteHostClient.resolveResumeTaskWorktree from origin (#3194)", () => {
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

  it("asks the agent to fetch the branch from origin when the caller asks for it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        path: "/x/y/.mullion-worktrees/mullion-task-1",
        branch: "mullion/task-1",
      }),
    );
    await expect(
      client().resolveResumeTaskWorktree("/x/y", "mullion/task-1", { fromOrigin: true }),
    ).resolves.toEqual({
      path: "/x/y/.mullion-worktrees/mullion-task-1",
      branch: "mullion/task-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-worktree/resume",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ cwd: "/x/y", branchName: "mullion/task-1", fromOrigin: true }),
      }),
    );
  });

  it("sends fromOrigin: false when the caller does not ask for it", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, null));
    await expect(
      client().resolveResumeTaskWorktree("/x/y", "mullion/task-1", { fromOrigin: false }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/git-worktree/resume",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ cwd: "/x/y", branchName: "mullion/task-1", fromOrigin: false }),
      }),
    );
  });
});
