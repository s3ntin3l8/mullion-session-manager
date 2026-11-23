// #3416 — a review request reads the session's branch on the SESSION's host, at
// the project's checkout on that host (`hostCwds`), not on the project's host at
// the project's own path. Its own file: review-relay.test.ts is at its size
// ceiling. Only the network/host edges are mocked; the session -> project ->
// repo -> branch resolution runs for real, and the lookup of the PR by branch
// is where each case stops, since that call carries the resolved branch.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as HostGit from "../../src/services/host-git.js";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as GithubWrite from "../../src/services/github-write.js";
import type * as GitStatus from "../../src/services/git-status.js";
import type * as HermesReview from "../../src/services/hermes-review.js";
import type * as RemoteHostClient from "../../src/services/remote-host-client.js";

const mocks = vi.hoisted(() => ({
  resolveRepoRefResult: vi.fn(),
  resolveGitHubToken: vi.fn(),
  findPullRequestByHead: vi.fn(),
  getGitStatus: vi.fn(),
  assertReviewerConfigured: vi.fn(),
  getRemoteHostClient: vi.fn(),
}));
vi.mock("../../src/services/host-git.js", async (orig) => ({
  ...(await orig<typeof HostGit>()),
  resolveRepoRefResult: mocks.resolveRepoRefResult,
}));
vi.mock("../../src/services/github-integration.js", async (orig) => ({
  ...(await orig<typeof GithubIntegration>()),
  resolveGitHubToken: mocks.resolveGitHubToken,
}));
vi.mock("../../src/services/github-write.js", async (orig) => ({
  ...(await orig<typeof GithubWrite>()),
  findPullRequestByHead: mocks.findPullRequestByHead,
}));
vi.mock("../../src/services/git-status.js", async (orig) => ({
  ...(await orig<typeof GitStatus>()),
  getGitStatus: mocks.getGitStatus,
}));
vi.mock("../../src/services/hermes-review.js", async (orig) => ({
  ...(await orig<typeof HermesReview>()),
  assertReviewerConfigured: mocks.assertReviewerConfigured,
}));
vi.mock("../../src/services/remote-host-client.js", async (orig) => ({
  ...(await orig<typeof RemoteHostClient>()),
  getRemoteHostClient: mocks.getRemoteHostClient,
}));

import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { projects, sessions } from "../../src/db/schema.js";
import { resetRepoRefMemo } from "../../src/routes/review-relay.js";

const tmpDb = path.join(os.tmpdir(), `review-relay-session-host-${process.pid}.db`);
const PROJECT_CWD = "/tmp/review-session-host";

describe("review-request: the session's branch is read on the session's host (#3416)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let nextAddr = 1;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    resetRepoRefMemo(app);
    mocks.resolveRepoRefResult.mockResolvedValue({
      ok: true,
      value: { owner: "acme", repo: "widgets" },
    });
    mocks.resolveGitHubToken.mockResolvedValue("ghs_token");
    mocks.assertReviewerConfigured.mockReturnValue("key");
    mocks.getGitStatus.mockResolvedValue({ branch: "feat/local" });
    // No open PR: the 404 ends the request right after the branch is resolved.
    mocks.findPullRequestByHead.mockResolvedValue(null);
  });

  // A project on `projectHostId` (its own path PROJECT_CWD there, `hostCwds`
  // elsewhere), with one session placed on `sessionHostId`.
  function placed(
    projectHostId: string,
    hostCwds: Record<string, string> | null,
    sessionHostId: string,
    sessionCwd: string | null = null,
  ) {
    const [proj] = app.db
      .insert(projects)
      .values({
        name: `p-${projectHostId}-${sessionHostId}`,
        cwd: PROJECT_CWD,
        hostId: projectHostId,
        hostCwds: hostCwds ? JSON.stringify(hostCwds) : null,
      })
      .returning()
      .all();
    const [sess] = app.db
      .insert(sessions)
      .values({ projectId: proj.id, command: "bash", hostId: sessionHostId, cwd: sessionCwd })
      .returning()
      .all();
    return sess.id;
  }

  const post = (id: number) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${id}/review-request`,
      payload: {},
      remoteAddress: `10.2.0.${nextAddr++}`,
    });

  it("reads a local project's session branch on the remote host, at the mapped path", async () => {
    const resolveGitStatus = vi.fn(async () => ({
      isRepo: true,
      status: { branch: "feat/placed" },
    }));
    mocks.getRemoteHostClient.mockReturnValue({ resolveGitStatus });
    const id = placed("local", { "mac-agent": "/Users/me/Projects/app" }, "mac-agent");
    const res = await post(id);
    expect(res.statusCode).toBe(404);
    expect(mocks.getRemoteHostClient).toHaveBeenCalledWith(expect.anything(), "mac-agent");
    expect(resolveGitStatus).toHaveBeenCalledWith("/Users/me/Projects/app");
    expect(mocks.getGitStatus).not.toHaveBeenCalled();
    expect(mocks.findPullRequestByHead).toHaveBeenCalledWith(
      "ghs_token",
      "acme",
      "widgets",
      "acme:feat/placed",
    );
  });

  it("prefers the session's own cwd over the project's mapped path on the remote host", async () => {
    const resolveGitStatus = vi.fn(async () => ({
      isRepo: true,
      status: { branch: "feat/worktree" },
    }));
    mocks.getRemoteHostClient.mockReturnValue({ resolveGitStatus });
    const id = placed(
      "local",
      { "mac-agent": "/Users/me/Projects/app" },
      "mac-agent",
      "/Users/me/Projects/app/.mullion-worktrees/session-7",
    );
    const res = await post(id);
    expect(res.statusCode).toBe(404);
    expect(resolveGitStatus).toHaveBeenCalledWith(
      "/Users/me/Projects/app/.mullion-worktrees/session-7",
    );
    expect(mocks.findPullRequestByHead).toHaveBeenCalledWith(
      "ghs_token",
      "acme",
      "widgets",
      "acme:feat/worktree",
    );
  });

  it("asks no host, and finds no branch, when the project has no path on the session's host", async () => {
    const id = placed("local", { "mac-agent": "/Users/me/Projects/app" }, "other-agent");
    const res = await post(id);
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("Could not determine this session's branch");
    expect(mocks.getRemoteHostClient).not.toHaveBeenCalled();
    expect(mocks.getGitStatus).not.toHaveBeenCalled();
    expect(mocks.findPullRequestByHead).not.toHaveBeenCalled();
  });

  it("reads a remote project's session branch locally when the session was placed on this host", async () => {
    const id = placed("some-agent-host", { local: "/tmp/review-local" }, "local");
    const res = await post(id);
    expect(res.statusCode).toBe(404);
    expect(mocks.getRemoteHostClient).not.toHaveBeenCalled();
    expect(mocks.getGitStatus).toHaveBeenCalledWith("/tmp/review-local");
    expect(mocks.findPullRequestByHead).toHaveBeenCalledWith(
      "ghs_token",
      "acme",
      "widgets",
      "acme:feat/local",
    );
  });
});
