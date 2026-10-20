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

// Only the network/host edges are mocked; the route's own session -> project
// -> repo -> PR resolution and error mapping run for real.
const mocks = vi.hoisted(() => ({
  resolveRepoRefResult: vi.fn(),
  resolveGitHubToken: vi.fn(),
  findPullRequestByHead: vi.fn(),
  getPullRequestByNumber: vi.fn(),
  getGitStatus: vi.fn(),
  requestHermesReview: vi.fn(),
  requestRelay: vi.fn(),
  getRelayStatus: vi.fn(),
  getRunForTarget: vi.fn(),
  assertReviewerConfigured: vi.fn(),
  getHermesReviewStatus: vi.fn(),
  getReviewRunForPr: vi.fn(),
  stopHermesReview: vi.fn(),
  listPullRequestReviews: vi.fn(),
  listIssueComments: vi.fn(),
  getIssueState: vi.fn(),
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
  getPullRequestByNumber: mocks.getPullRequestByNumber,
  listPullRequestReviews: mocks.listPullRequestReviews,
  listIssueComments: mocks.listIssueComments,
  getIssueState: mocks.getIssueState,
}));
vi.mock("../../src/services/git-status.js", async (orig) => ({
  ...(await orig<typeof GitStatus>()),
  getGitStatus: mocks.getGitStatus,
}));
vi.mock("../../src/services/hermes-review.js", async (orig) => ({
  ...(await orig<typeof HermesReview>()),
  requestHermesReview: mocks.requestHermesReview,
  requestRelay: mocks.requestRelay,
  getRelayStatus: mocks.getRelayStatus,
  getRunForTarget: mocks.getRunForTarget,
  assertReviewerConfigured: mocks.assertReviewerConfigured,
  getHermesReviewStatus: mocks.getHermesReviewStatus,
  getReviewRunForPr: mocks.getReviewRunForPr,
  stopHermesReview: mocks.stopHermesReview,
}));
vi.mock("../../src/services/remote-host-client.js", async (orig) => ({
  ...(await orig<typeof RemoteHostClient>()),
  getRemoteHostClient: mocks.getRemoteHostClient,
}));

import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { GitHubApiError } from "../../src/services/github-fetch.js";
import { projects, sessions } from "../../src/db/schema.js";
import {
  HermesAuthError,
  HermesNotConfiguredError,
  HermesUnavailableError,
  ReviewConflictError,
  ReviewCooldownError,
  ReviewRunForbiddenError,
  ReviewRunNotFoundError,
} from "../../src/services/hermes-review.js";

const tmpDb = path.join(os.tmpdir(), `review-request-test-${process.pid}.db`);

describe("review-request routes", () => {
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
    mocks.resolveRepoRefResult.mockResolvedValue({
      ok: true,
      value: { owner: "acme", repo: "widgets" },
    });
    mocks.resolveGitHubToken.mockResolvedValue("ghs_token");
    mocks.getGitStatus.mockResolvedValue({ branch: "feat/thing" });
    mocks.findPullRequestByHead.mockResolvedValue({ number: 42 });
    mocks.getPullRequestByNumber.mockImplementation(async (_t, _o, _r, number: number) => ({
      number,
      headSha: `sha${number}`,
    }));
    mocks.requestHermesReview.mockResolvedValue({
      runId: "run_1",
      status: "queued",
      replayed: false,
    });
    mocks.requestRelay.mockResolvedValue({
      runId: "run_triage",
      status: "queued",
      replayed: false,
    });
    mocks.getRelayStatus.mockResolvedValue({
      provider: "hermes",
      runId: "run_triage",
      kind: "issue",
      status: "completed",
    });
    mocks.getRunForTarget.mockReturnValue(null);
    mocks.assertReviewerConfigured.mockReturnValue("key");
    // The duplicate-review check (#1705) reads the PR's reviews on every
    // dispatch — an empty list is the common case.
    mocks.listPullRequestReviews.mockResolvedValue([]);
    mocks.listIssueComments.mockResolvedValue([]);
    mocks.getIssueState.mockResolvedValue({ state: "open", labels: [], isPullRequest: false });
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

  // The triage half of the relay (issue #1629) — its own routes, its own
  // target kind, the same scoping rules.
  const triagePost = (
    id: number | string,
    payload?: Record<string, unknown>,
    remoteAddress = `10.4.0.${nextAddr++}`,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${id}/triage-request`,
      payload,
      remoteAddress,
    });
  const triageGet = (id: number | string, query: string, remoteAddress = `10.5.0.${nextAddr++}`) =>
    app.inject({
      method: "GET",
      url: `/api/sessions/${id}/triage-request${query}`,
      remoteAddress,
    });

  it("detects the PR from the session's branch and dispatches", async () => {
    const res = await post(sessionId, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "dispatched",
      repo: "acme/widgets",
      prNumber: 42,
      runId: "run_1",
      runStatus: "queued",
      replayed: false,
    });
    expect(mocks.findPullRequestByHead).toHaveBeenCalledWith(
      "ghs_token",
      "acme",
      "widgets",
      "acme:feat/thing",
    );
    expect(mocks.getPullRequestByNumber).toHaveBeenCalledWith("ghs_token", "acme", "widgets", 42);
    expect(mocks.requestHermesReview).toHaveBeenCalledWith(expect.anything(), {
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      headSha: "sha42",
      sessionId,
    });
  });

  describe("duplicate-review warning (#1705)", () => {
    it("warns, but still dispatches, when a bot review already landed for the commit", async () => {
      mocks.listPullRequestReviews.mockResolvedValue([
        {
          author: "hermes[bot]",
          authorIsBot: true,
          state: "APPROVED",
          commitId: "sha42",
          submittedAt: new Date().toISOString(),
        },
      ]);
      const res = await post(sessionId, {});
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("dispatched");
      expect(mocks.requestHermesReview).toHaveBeenCalled();
      expect(res.json().warning).toContain("hermes[bot]");
      expect(res.json().warning).toContain("APPROVED");
      // No promise about a second review: on a replay no new run is
      // dispatched, so there is none to promise.
      expect(res.json().warning).not.toContain("second");
    });

    it("says nothing when the commit has no bot review", async () => {
      mocks.listPullRequestReviews.mockResolvedValue([
        {
          author: "hermes[bot]",
          authorIsBot: true,
          state: "APPROVED",
          commitId: "some-other-sha",
          submittedAt: new Date().toISOString(),
        },
        {
          author: "alice",
          authorIsBot: false,
          state: "COMMENTED",
          commitId: "sha42",
          submittedAt: new Date().toISOString(),
        },
      ]);
      const res = await post(sessionId, {});
      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toBeUndefined();
    });

    it("says nothing about a dismissed (retracted) review", async () => {
      mocks.listPullRequestReviews.mockResolvedValue([
        {
          author: "hermes[bot]",
          authorIsBot: true,
          state: "DISMISSED",
          commitId: "sha42",
          submittedAt: new Date().toISOString(),
        },
      ]);
      const res = await post(sessionId, {});
      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toBeUndefined();
    });

    it("dispatches without a warning when the GitHub lookup fails", async () => {
      mocks.listPullRequestReviews.mockRejectedValue(new GitHubApiError("boom", 500));
      const res = await post(sessionId, {});
      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toBeUndefined();
      expect(mocks.requestHermesReview).toHaveBeenCalled();
    });

    it("does not walk the PR's reviews for a request the relay refuses", async () => {
      // The cooldown refuses inside requestHermesReview — the duplicate check
      // runs after the dispatch is admitted, so it must not run at all.
      mocks.requestHermesReview.mockRejectedValue(new ReviewCooldownError(240));
      const res = await post(sessionId, {});
      expect(res.statusCode).toBe(409);
      expect(mocks.listPullRequestReviews).not.toHaveBeenCalled();
    });
  });

  it("404s a detached session's branch, on either host", async () => {
    // `git status` reports a detached checkout as its short commit SHA, not
    // as the "(detached)" sentinel — that is the signal that arrives.
    mocks.getGitStatus.mockResolvedValue({ branch: "abc1234" });
    const res = await post(sessionId, {});
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("pass prNumber");

    mocks.getRemoteHostClient.mockReturnValue({
      resolveGitStatus: vi.fn(async () => ({
        isRepo: true,
        status: { branch: "abc1234" },
      })),
    });
    const remote = await post(remoteSessionId, {});
    expect(remote.statusCode).toBe(404);
    expect(remote.json().message).toContain("pass prNumber");
  });

  it("derives the repo from the session's project, never the body", async () => {
    const res = await post(sessionId, { prNumber: 99 });
    expect(res.statusCode).toBe(200);
    expect(mocks.resolveRepoRefResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: "/tmp/review-local" }),
    );
    expect(mocks.getPullRequestByNumber).toHaveBeenCalledWith("ghs_token", "acme", "widgets", 99);
    expect(mocks.findPullRequestByHead).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ status: "dispatched", repo: "acme/widgets", prNumber: 99 });
  });

  it("ignores an attacker-chosen repo in the body (Fastify strips unknown fields)", async () => {
    const res = await post(sessionId, { prNumber: 99, repo: "evil/repo", owner: "evil" });
    expect(res.statusCode).toBe(200);
    expect(mocks.getPullRequestByNumber).toHaveBeenCalledWith("ghs_token", "acme", "widgets", 99);
    expect(mocks.requestHermesReview).toHaveBeenCalledWith(expect.anything(), {
      owner: "acme",
      repo: "widgets",
      prNumber: 99,
      headSha: "sha99",
      sessionId,
    });
  });

  it("412s an unconfigured reviewer before touching GitHub or the git remote", async () => {
    mocks.assertReviewerConfigured.mockImplementation(() => {
      throw new HermesNotConfiguredError("No reviewer is configured");
    });
    const res = await post(sessionId, {});
    expect(res.statusCode).toBe(412);
    expect(res.json().message).toContain("No reviewer is configured");
    expect(mocks.resolveRepoRefResult).not.toHaveBeenCalled();
    expect(mocks.resolveGitHubToken).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected error from the configuration gate", async () => {
    mocks.assertReviewerConfigured.mockImplementation(() => {
      throw new Error("db down");
    });
    expect((await post(sessionId, {})).statusCode).toBe(500);
  });

  it("rejects a non-positive or non-integer prNumber", async () => {
    expect((await post(sessionId, { prNumber: 0 })).statusCode).toBe(400);
    expect((await post(sessionId, { prNumber: 1.5 })).statusCode).toBe(400);
    expect((await post(sessionId, { prNumber: "abc" })).statusCode).toBe(400);
    expect(mocks.requestHermesReview).not.toHaveBeenCalled();
  });

  it("404s an explicit PR that doesn't exist in the repo", async () => {
    mocks.getPullRequestByNumber.mockRejectedValue(new GitHubApiError("Not Found", 404));
    const res = await post(sessionId, { prNumber: 12345 });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("PR #12345");
    expect(mocks.requestHermesReview).not.toHaveBeenCalled();
  });

  describe("GitHub lookup failures other than 404", () => {
    it.each([
      [401, "HTTP 401"],
      [403, "HTTP 403"],
      [429, "HTTP 429"],
      [500, "HTTP 500"],
      [0, "unreachable"],
    ])("explicit PR: status %i is a 502, never 'not found'", async (status, text) => {
      mocks.getPullRequestByNumber.mockRejectedValue(new GitHubApiError("boom", status));
      const res = await post(sessionId, { prNumber: 5 });
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toContain(text);
      expect(res.json().message).not.toContain("not found");
      expect(mocks.requestHermesReview).not.toHaveBeenCalled();
    });

    it("branch lookup: a 401 is a 502 instead of an unhandled 500", async () => {
      mocks.findPullRequestByHead.mockRejectedValue(new GitHubApiError("Bad credentials", 401));
      const res = await post(sessionId, {});
      expect(res.statusCode).toBe(502);
    });

    it("branch lookup: a 404 means the repo isn't accessible", async () => {
      mocks.findPullRequestByHead.mockRejectedValue(new GitHubApiError("Not Found", 404));
      const res = await post(sessionId, {});
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("acme/widgets");
    });

    it("a non-GitHub error is not swallowed", async () => {
      mocks.getPullRequestByNumber.mockRejectedValue(new Error("kaboom"));
      expect((await post(sessionId, { prNumber: 5 })).statusCode).toBe(500);
    });
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

  it("resolves a remote-host session's branch on its host and dispatches (#1628)", async () => {
    const resolveGitStatus = vi.fn(async () => ({
      isRepo: true,
      status: { branch: "feat/remote" },
    }));
    mocks.getRemoteHostClient.mockReturnValue({ resolveGitStatus });
    const res = await post(remoteSessionId, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "dispatched", repo: "acme/widgets", prNumber: 42 });
    expect(mocks.getRemoteHostClient).toHaveBeenCalledWith(expect.anything(), "some-agent-host");
    // resolveGitStatus, NOT resolveGitBranch: the latter is a bare .git/HEAD
    // read that does not follow a worktree's .git file redirect, and reports
    // a detached HEAD as a short SHA instead of the "(detached)" sentinel.
    expect(resolveGitStatus).toHaveBeenCalledWith("/srv/remote");
    expect(mocks.findPullRequestByHead).toHaveBeenCalledWith(
      "ghs_token",
      "acme",
      "widgets",
      "acme:feat/remote",
    );
    // A local session never asks a host.
    mocks.getRemoteHostClient.mockClear();
    expect((await post(sessionId, {})).statusCode).toBe(200);
    expect(mocks.getRemoteHostClient).not.toHaveBeenCalled();
  });

  it("404s a remote-host session whose cwd is not a repo (#1628)", async () => {
    mocks.getRemoteHostClient.mockReturnValue({
      resolveGitStatus: vi.fn(async () => ({ isRepo: false, status: null })),
    });
    const res = await post(remoteSessionId, {});
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("branch");
  });

  it("404s a remote-host session whose status has no branch (#1628)", async () => {
    mocks.getRemoteHostClient.mockReturnValue({
      resolveGitStatus: vi.fn(async () => ({ isRepo: true, status: null })),
    });
    const res = await post(remoteSessionId, {});
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("branch");
  });

  it("404s a remote-host session whose host cannot resolve a branch (#1628)", async () => {
    mocks.getRemoteHostClient.mockReturnValue({
      resolveGitStatus: vi.fn(async () => {
        throw new Error("host unreachable");
      }),
    });
    const res = await post(remoteSessionId, {});
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("branch");
  });

  it("404s a remote-host session whose host row is gone (#1628)", async () => {
    // getRemoteHostClient() throws SYNCHRONOUSLY for a missing host row.
    mocks.getRemoteHostClient.mockImplementation(() => {
      throw new Error("Host some-agent-host has no baseUrl");
    });
    const res = await post(remoteSessionId, {});
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain("branch");
  });

  it("412s when the project has no GitHub remote", async () => {
    mocks.resolveRepoRefResult.mockResolvedValue({ ok: true, value: null });
    expect((await post(sessionId, {})).statusCode).toBe(412);
  });

  it("503s when the project host is unreachable, rather than blaming the remote (#1628)", async () => {
    // A downed agent is not "this project has no GitHub remote".
    mocks.resolveRepoRefResult.mockResolvedValue({
      ok: false,
      reason: "unreachable",
      detail: "host unreachable",
    });
    const res = await post(remoteSessionId, {});
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toContain("unreachable");
  });

  it("412s when the project host cannot resolve a repo ref at all (#1628)", async () => {
    mocks.resolveRepoRefResult.mockResolvedValue({ ok: false, reason: "unsupported" });
    const res = await post(remoteSessionId, {});
    expect(res.statusCode).toBe(412);
    expect(res.json().message).toContain("host");
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
      ["commit already requested", new ReviewConflictError(), 409],
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

    it("passes Hermes' Retry-After through on a busy gateway", async () => {
      mocks.requestHermesReview.mockRejectedValue(new HermesUnavailableError("busy", "d", 30));
      const res = await post(sessionId, {});
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe("30");
    });

    it("an unexpected error is a 500, not swallowed", async () => {
      mocks.requestHermesReview.mockRejectedValue(new Error("kaboom"));
      expect((await post(sessionId, {})).statusCode).toBe(500);
    });
  });

  describe("GET status", () => {
    const get = (id: number | string, query = "") =>
      app.inject({
        method: "GET",
        url: `/api/sessions/${id}/review-request${query}`,
        remoteAddress: `10.3.0.${nextAddr++}`,
      });

    beforeEach(() => {
      mocks.getHermesReviewStatus.mockResolvedValue({
        provider: "hermes",
        runId: "run_1",
        status: "completed",
      });
      mocks.getReviewRunForPr.mockReturnValue({
        runId: "run_1",
        dispatchedAt: 1_000_000,
        headSha: "ccccccc3",
      });
      mocks.listPullRequestReviews.mockResolvedValue([]);
    });

    it("returns the run status for the branch's PR plus the landed review", async () => {
      mocks.listPullRequestReviews.mockResolvedValue([
        {
          author: "old-bot[bot]",
          authorIsBot: true,
          state: "APPROVED",
          commitId: "aaaaaaa1",
          submittedAt: new Date(100_000).toISOString(), // before dispatch
        },
        {
          author: "alice",
          authorIsBot: false,
          state: "COMMENTED",
          commitId: "bbbbbbb2",
          submittedAt: new Date(1_000_500).toISOString(), // human, ignored
        },
        {
          author: "ci[bot]",
          authorIsBot: true,
          state: "COMMENTED",
          commitId: "ddddddd4", // another commit, ignored
          submittedAt: new Date(1_000_950).toISOString(),
        },
        {
          author: "hermes[bot]",
          authorIsBot: true,
          state: "APPROVED",
          commitId: "ccccccc3",
          submittedAt: new Date(1_000_900).toISOString(),
        },
      ]);
      const res = await get(sessionId);
      expect(res.statusCode).toBe(200);
      expect(mocks.getHermesReviewStatus).toHaveBeenCalledWith(expect.anything(), {
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
      });
      expect(res.json()).toMatchObject({
        runId: "run_1",
        status: "completed",
        github: {
          checked: true,
          review: { author: "hermes[bot]", state: "APPROVED", commitId: "ccccccc3" },
        },
      });
    });

    it("reports a dismissed (retracted) review as not landed", async () => {
      // The same "landed" definition the duplicate-review warning uses: a
      // retracted review did not land, so `review status` must not say it
      // posted.
      mocks.listPullRequestReviews.mockResolvedValue([
        {
          author: "hermes[bot]",
          authorIsBot: true,
          state: "DISMISSED",
          commitId: "ccccccc3",
          submittedAt: new Date(1_000_900).toISOString(),
        },
      ]);
      const res = await get(sessionId);
      expect(res.json().github).toEqual({ checked: true, review: null });
    });

    it("reports that nothing landed when no bot review follows the dispatch", async () => {
      const res = await get(sessionId, "?prNumber=99");
      expect(mocks.getHermesReviewStatus).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ prNumber: 99 }),
      );
      expect(res.json().github).toEqual({ checked: true, review: null });
    });

    it("carries the review's own text and link (#1704)", async () => {
      mocks.listPullRequestReviews.mockResolvedValue([
        {
          author: "hermes[bot]",
          authorIsBot: true,
          state: "CHANGES_REQUESTED",
          commitId: "ccccccc3",
          submittedAt: new Date(1_000_900).toISOString(),
          body: "## Review\n\n**Verdict:** REQUEST_CHANGES",
          htmlUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
        },
      ]);
      const res = await get(sessionId);
      expect(res.json().github.review).toEqual({
        author: "hermes[bot]",
        state: "CHANGES_REQUESTED",
        commitId: "ccccccc3",
        submittedAt: new Date(1_000_900).toISOString(),
        body: "## Review\n\n**Verdict:** REQUEST_CHANGES",
        htmlUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
      });
    });

    it("marks a truncated review body (#1704)", async () => {
      mocks.listPullRequestReviews.mockResolvedValue([
        {
          author: "hermes[bot]",
          authorIsBot: true,
          state: "COMMENTED",
          commitId: "ccccccc3",
          submittedAt: new Date(1_000_900).toISOString(),
          body: "cut short",
          bodyTruncated: true,
        },
      ]);
      const res = await get(sessionId);
      expect(res.json().github.review.bodyTruncated).toBe(true);
    });

    it("skips the GitHub check when no run is tracked here", async () => {
      mocks.getReviewRunForPr.mockReturnValue(null);
      const res = await get(sessionId);
      expect(res.json().github).toEqual({ checked: false });
      expect(mocks.listPullRequestReviews).not.toHaveBeenCalled();
    });

    it("keeps the Hermes status when the GitHub review lookup fails", async () => {
      mocks.listPullRequestReviews.mockRejectedValue(new GitHubApiError("boom", 500));
      const res = await get(sessionId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "completed", github: { checked: false } });
    });

    it("412s an unconfigured reviewer first, and maps service errors", async () => {
      mocks.getHermesReviewStatus.mockRejectedValue(new HermesUnavailableError("down"));
      expect((await get(sessionId)).statusCode).toBe(503);
      mocks.assertReviewerConfigured.mockImplementation(() => {
        throw new HermesNotConfiguredError("No reviewer is configured");
      });
      mocks.resolveRepoRefResult.mockClear();
      expect((await get(sessionId)).statusCode).toBe(412);
      expect(mocks.resolveRepoRefResult).not.toHaveBeenCalled();
    });

    it("404s an unknown session and 400s a malformed id or prNumber", async () => {
      expect((await get(999_999)).statusCode).toBe(404);
      expect((await get("abc")).statusCode).toBe(400);
      expect((await get(sessionId, "?prNumber=0")).statusCode).toBe(400);
    });
  });

  describe("issue triage (#1629)", () => {
    it("dispatches a triage for the given issue in the session's repo", async () => {
      const res = await triagePost(sessionId, { issueNumber: 12 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: "dispatched",
        kind: "issue",
        repo: "acme/widgets",
        issueNumber: 12,
        runId: "run_triage",
        runStatus: "queued",
        replayed: false,
      });
      // The repo comes from the session's project, never from the body.
      expect(mocks.resolveRepoRef).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ cwd: "/tmp/review-local" }),
      );
      expect(mocks.requestRelay).toHaveBeenCalledWith(expect.anything(), {
        kind: "issue",
        owner: "acme",
        repo: "widgets",
        number: 12,
        sessionId,
      });
    });

    it("requires an issue number", async () => {
      expect((await triagePost(sessionId, {})).statusCode).toBe(400);
      expect((await triagePost(sessionId, { issueNumber: 0 })).statusCode).toBe(400);
      expect(mocks.requestRelay).not.toHaveBeenCalled();
    });

    it("404s an issue that does not exist", async () => {
      mocks.getIssueState.mockRejectedValue(new GitHubApiError("not found", 404));
      const res = await triagePost(sessionId, { issueNumber: 12 });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("Issue #12");
      expect(mocks.requestRelay).not.toHaveBeenCalled();
    });

    it("404s a number that is a pull request, not an issue", async () => {
      // GitHub answers /issues/{n} for a pull request too — only the
      // `pull_request` key tells the two apart.
      mocks.getIssueState.mockResolvedValue({
        state: "open",
        labels: [],
        isPullRequest: true,
      });
      const res = await triagePost(sessionId, { issueNumber: 12 });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("pull request");
      expect(mocks.requestRelay).not.toHaveBeenCalled();
    });

    it("404s an unknown session", async () => {
      expect((await triagePost(999_999, { issueNumber: 12 })).statusCode).toBe(404);
    });

    it("412s when no GitHub credentials are available", async () => {
      mocks.resolveGitHubToken.mockResolvedValue(null);
      expect((await triagePost(sessionId, { issueNumber: 12 })).statusCode).toBe(412);
      expect(mocks.requestRelay).not.toHaveBeenCalled();
    });

    it("502s a GitHub failure that is not a 404", async () => {
      mocks.getIssueState.mockRejectedValue(new GitHubApiError("boom", 500));
      const res = await triagePost(sessionId, { issueNumber: 12 });
      expect(res.statusCode).toBe(502);
      expect(mocks.requestRelay).not.toHaveBeenCalled();
    });

    it("502s an unreachable GitHub", async () => {
      mocks.getIssueState.mockRejectedValue(new GitHubApiError("down", 0));
      const res = await triagePost(sessionId, { issueNumber: 12 });
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toContain("unreachable");
    });

    it("maps a relay error (e.g. the cooldown) the same way a review does", async () => {
      mocks.requestRelay.mockRejectedValue(new ReviewCooldownError(240));
      const res = await triagePost(sessionId, { issueNumber: 12 });
      expect(res.statusCode).toBe(409);
      expect(res.headers["retry-after"]).toBe("240");
    });

    it("maps an unreachable Hermes", async () => {
      mocks.requestRelay.mockRejectedValue(new HermesUnavailableError("down"));
      expect((await triagePost(sessionId, { issueNumber: 12 })).statusCode).toBe(503);
    });

    it("412s an unconfigured reviewer before touching GitHub", async () => {
      mocks.assertReviewerConfigured.mockImplementation(() => {
        throw new HermesNotConfiguredError("No reviewer is configured");
      });
      expect((await triagePost(sessionId, { issueNumber: 12 })).statusCode).toBe(412);
      expect(mocks.getIssueState).not.toHaveBeenCalled();
    });

    it("returns the triage status and whether the comment landed", async () => {
      mocks.getRunForTarget.mockReturnValue({ runId: "run_triage", dispatchedAt: 1_000_000 });
      mocks.listIssueComments.mockResolvedValue([
        {
          author: "alice",
          authorIsBot: false,
          body: "hi",
          bodyTruncated: false,
          createdAt: new Date(1_000_500).toISOString(),
        },
        {
          author: "hermes[bot]",
          authorIsBot: true,
          body: "## Triage\n\n**Summary:** a duplicate",
          bodyTruncated: false,
          createdAt: new Date(1_000_900).toISOString(),
          htmlUrl: "https://github.com/acme/widgets/issues/12#issuecomment-1",
        },
      ]);
      const res = await triageGet(sessionId, "?issueNumber=12");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        runId: "run_triage",
        kind: "issue",
        status: "completed",
        github: {
          checked: true,
          comment: {
            author: "hermes[bot]",
            body: "## Triage\n\n**Summary:** a duplicate",
          },
        },
      });
      expect(mocks.getRelayStatus).toHaveBeenCalledWith(expect.anything(), {
        kind: "issue",
        owner: "acme",
        repo: "widgets",
        number: 12,
      });
    });

    it("reports that no triage comment landed yet", async () => {
      mocks.getRunForTarget.mockReturnValue({ runId: "run_triage", dispatchedAt: 1_000_000 });
      const res = await triageGet(sessionId, "?issueNumber=12");
      expect(res.json().github).toEqual({ checked: true, comment: null });
    });

    it("skips the GitHub check when no run is tracked here", async () => {
      mocks.getRunForTarget.mockReturnValue(null);
      const res = await triageGet(sessionId, "?issueNumber=12");
      expect(res.json().github).toEqual({ checked: false });
      expect(mocks.listIssueComments).not.toHaveBeenCalled();
    });

    it("keeps the Hermes status when the comment lookup fails", async () => {
      mocks.getRunForTarget.mockReturnValue({ runId: "run_triage", dispatchedAt: 1_000_000 });
      mocks.listIssueComments.mockRejectedValue(new GitHubApiError("boom", 500));
      const res = await triageGet(sessionId, "?issueNumber=12");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "completed", github: { checked: false } });
    });

    it("requires an issue number on the status route too", async () => {
      expect((await triageGet(sessionId, "")).statusCode).toBe(400);
    });

    it("maps a relay error on the status route", async () => {
      mocks.getRelayStatus.mockRejectedValue(new HermesUnavailableError("down"));
      expect((await triageGet(sessionId, "?issueNumber=12")).statusCode).toBe(503);
    });
  });

  describe("POST review-stop", () => {
    const stop = (id: number | string, payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${id}/review-stop`,
        payload,
        remoteAddress: `10.4.0.${nextAddr++}`,
      });
    it("stops the named run on behalf of the session", async () => {
      mocks.stopHermesReview.mockResolvedValue({ runId: "run_1", status: "stopping" });
      const res = await stop(sessionId, { runId: "run_1" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ runId: "run_1", status: "stopping" });
      expect(mocks.stopHermesReview).toHaveBeenCalledWith(expect.anything(), "run_1", sessionId);
    });

    it.each([
      ["another session's run", new ReviewRunForbiddenError(), 403],
      ["an unknown run", new ReviewRunNotFoundError(), 404],
      ["an unreachable Hermes", new HermesUnavailableError("down"), 503],
    ])("maps %s", async (_label, err, status) => {
      mocks.stopHermesReview.mockRejectedValue(err);
      expect((await stop(sessionId, { runId: "run_1" })).statusCode).toBe(status);
    });

    it("requires a runId, and 412s an unconfigured reviewer", async () => {
      expect((await stop(sessionId, {})).statusCode).toBe(400);
      expect((await stop("abc", { runId: "r" })).statusCode).toBe(400);
      mocks.assertReviewerConfigured.mockImplementation(() => {
        throw new HermesNotConfiguredError("No reviewer is configured");
      });
      expect((await stop(sessionId, { runId: "run_1" })).statusCode).toBe(412);
      expect(mocks.stopHermesReview).not.toHaveBeenCalled();
    });
  });
});
