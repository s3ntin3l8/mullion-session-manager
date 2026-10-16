import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as HostGit from "../../src/services/host-git.js";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as GithubWrite from "../../src/services/github-write.js";
import type * as GitStatus from "../../src/services/git-status.js";
import type * as HermesReview from "../../src/services/hermes-review.js";

// Only the network/host edges are mocked; the route's own session -> project
// -> repo -> PR resolution and error mapping run for real.
const mocks = vi.hoisted(() => ({
  resolveRepoRef: vi.fn(),
  resolveGitHubToken: vi.fn(),
  findPullRequestByHead: vi.fn(),
  getPullRequestByNumber: vi.fn(),
  getGitStatus: vi.fn(),
  requestHermesReview: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (orig) => ({
  ...(await orig<typeof HostGit>()),
  resolveRepoRef: mocks.resolveRepoRef,
}));
vi.mock("../../src/services/github-integration.js", async (orig) => ({
  ...(await orig<typeof GithubIntegration>()),
  resolveGitHubToken: mocks.resolveGitHubToken,
}));
vi.mock("../../src/services/github-write.js", async (orig) => ({
  ...(await orig<typeof GithubWrite>()),
  findPullRequestByHead: mocks.findPullRequestByHead,
  getPullRequestByNumber: mocks.getPullRequestByNumber,
}));
vi.mock("../../src/services/git-status.js", async (orig) => ({
  ...(await orig<typeof GitStatus>()),
  getGitStatus: mocks.getGitStatus,
}));
vi.mock("../../src/services/hermes-review.js", async (orig) => ({
  ...(await orig<typeof HermesReview>()),
  requestHermesReview: mocks.requestHermesReview,
}));

import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { projects, sessions } from "../../src/db/schema.js";
import {
  HermesAuthError,
  HermesNotConfiguredError,
  HermesUnavailableError,
  ReviewCooldownError,
} from "../../src/services/hermes-review.js";

const tmpDb = path.join(os.tmpdir(), `review-request-test-${process.pid}.db`);

describe("POST /api/sessions/:id/review-request", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sessionId: number;
  let remoteSessionId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const [local] = app.db
      .insert(projects)
      .values({ name: "local", cwd: "/tmp/review-local" })
      .returning()
      .all();
    const [remote] = app.db
      .insert(projects)
      .values({ name: "remote", cwd: "/srv/remote", hostId: "some-agent-host" })
      .returning()
      .all();
    [{ id: sessionId }] = app.db
      .insert(sessions)
      .values({ projectId: local.id, command: "bash" })
      .returning()
      .all();
    [{ id: remoteSessionId }] = app.db
      .insert(sessions)
      .values({ projectId: remote.id, command: "bash" })
      .returning()
      .all();
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRepoRef.mockResolvedValue({ owner: "acme", repo: "widgets" });
    mocks.resolveGitHubToken.mockResolvedValue("ghs_token");
    mocks.getGitStatus.mockResolvedValue({ branch: "feat/thing" });
    mocks.findPullRequestByHead.mockResolvedValue({ number: 42 });
    mocks.getPullRequestByNumber.mockResolvedValue({ number: 99 });
    mocks.requestHermesReview.mockResolvedValue(undefined);
  });

  // The route is rate-limited per client IP (10/min); a distinct address per
  // request keeps this file's request volume from tripping it unrelatedly —
  // the limit itself is exercised explicitly below.
  let nextAddr = 1;
  const post = (
    id: number | string,
    payload?: Record<string, unknown>,
    remoteAddress = `10.1.0.${nextAddr++}`,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${id}/review-request`,
      payload,
      remoteAddress,
    });

  it("detects the PR from the session's branch and dispatches", async () => {
    const res = await post(sessionId, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "dispatched", repo: "acme/widgets", prNumber: 42 });
    expect(mocks.findPullRequestByHead).toHaveBeenCalledWith(
      "ghs_token",
      "acme",
      "widgets",
      "acme:feat/thing",
    );
    expect(mocks.requestHermesReview).toHaveBeenCalledWith(expect.anything(), {
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
    });
  });

  it("derives the repo from the session's project, never the body", async () => {
    const res = await post(sessionId, { prNumber: 99 });
    expect(res.statusCode).toBe(200);
    expect(mocks.resolveRepoRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: "/tmp/review-local" }),
    );
    expect(mocks.getPullRequestByNumber).toHaveBeenCalledWith("ghs_token", "acme", "widgets", 99);
    expect(mocks.findPullRequestByHead).not.toHaveBeenCalled();
    expect(res.json()).toEqual({ status: "dispatched", repo: "acme/widgets", prNumber: 99 });
  });

  it("ignores an attacker-chosen repo in the body (Fastify strips unknown fields)", async () => {
    const res = await post(sessionId, { prNumber: 99, repo: "evil/repo", owner: "evil" });
    expect(res.statusCode).toBe(200);
    expect(mocks.getPullRequestByNumber).toHaveBeenCalledWith("ghs_token", "acme", "widgets", 99);
    expect(mocks.requestHermesReview).toHaveBeenCalledWith(expect.anything(), {
      owner: "acme",
      repo: "widgets",
      prNumber: 99,
    });
  });

  it("rejects a non-positive or non-integer prNumber", async () => {
    expect((await post(sessionId, { prNumber: 0 })).statusCode).toBe(400);
    expect((await post(sessionId, { prNumber: 1.5 })).statusCode).toBe(400);
    expect((await post(sessionId, { prNumber: "abc" })).statusCode).toBe(400);
    expect(mocks.requestHermesReview).not.toHaveBeenCalled();
  });

  it("404s an explicit PR that doesn't exist in the repo", async () => {
    mocks.getPullRequestByNumber.mockRejectedValue(new Error("Not Found"));
    const res = await post(sessionId, { prNumber: 12345 });
    expect(res.statusCode).toBe(404);
    expect(mocks.requestHermesReview).not.toHaveBeenCalled();
  });

  it("404s when the branch has no open PR", async () => {
    mocks.findPullRequestByHead.mockResolvedValue(null);
    const res = await post(sessionId, {});
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("feat/thing");
  });

  it("404s when the branch can't be determined", async () => {
    mocks.getGitStatus.mockResolvedValue(null);
    expect((await post(sessionId, {})).statusCode).toBe(404);
    mocks.getGitStatus.mockResolvedValue({ branch: "(detached)" });
    expect((await post(sessionId, {})).statusCode).toBe(404);
    expect(mocks.findPullRequestByHead).not.toHaveBeenCalled();
  });

  it("prefers the live branch reported by the running session", async () => {
    const spy = vi
      .spyOn(app.pty, "get")
      .mockReturnValue({ liveBranch: "live/branch" } as unknown as ReturnType<typeof app.pty.get>);
    try {
      await post(sessionId, {});
    } finally {
      spy.mockRestore();
    }
    expect(mocks.getGitStatus).not.toHaveBeenCalled();
    expect(mocks.findPullRequestByHead).toHaveBeenCalledWith(
      "ghs_token",
      "acme",
      "widgets",
      "acme:live/branch",
    );
  });

  it("412s for a remote-host project (v1 is local-host only)", async () => {
    const res = await post(remoteSessionId, {});
    expect(res.statusCode).toBe(412);
    expect(res.json().message).toContain("local");
    expect(mocks.resolveRepoRef).not.toHaveBeenCalled();
  });

  it("412s when the project has no GitHub remote", async () => {
    mocks.resolveRepoRef.mockResolvedValue(null);
    expect((await post(sessionId, {})).statusCode).toBe(412);
  });

  it("412s when no GitHub credentials are available", async () => {
    mocks.resolveGitHubToken.mockResolvedValue(null);
    expect((await post(sessionId, {})).statusCode).toBe(412);
  });

  it("404s an unknown session and 400s a malformed id", async () => {
    expect((await post(999_999, {})).statusCode).toBe(404);
    expect((await post("abc", {})).statusCode).toBe(400);
  });

  it("is rate-limited per client", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await post(sessionId, {}, "10.2.0.1")).statusCode);
    }
    expect(statuses.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  describe("relay error mapping", () => {
    it.each([
      ["not configured", new HermesNotConfiguredError("not set up"), 412],
      ["bad key", new HermesAuthError(401), 502],
      ["unreachable", new HermesUnavailableError("down"), 503],
    ])("%s", async (_label, err, status) => {
      mocks.requestHermesReview.mockRejectedValue(err);
      const res = await post(sessionId, {});
      expect(res.statusCode).toBe(status);
    });

    it("cooldown -> 409 with Retry-After", async () => {
      mocks.requestHermesReview.mockRejectedValue(new ReviewCooldownError(240));
      const res = await post(sessionId, {});
      expect(res.statusCode).toBe(409);
      expect(res.headers["retry-after"]).toBe("240");
    });

    it("an unexpected error is a 500, not swallowed", async () => {
      mocks.requestHermesReview.mockRejectedValue(new Error("kaboom"));
      expect((await post(sessionId, {})).statusCode).toBe(500);
    });
  });
});
