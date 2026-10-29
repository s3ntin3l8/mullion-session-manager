import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import type * as GithubAppModule from "../../src/services/github-app.js";

// A fake PEM, never a real key.
const FAKE_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----"; // pragma: allowlist secret

const mockGetInstallationToken = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/github-app.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubAppModule>();
  return { ...actual, getInstallationToken: mockGetInstallationToken };
});

// #1672 (a, b) — the GitHub sidebar's writes: reply to / resolve a review
// thread, comment on an issue or PR, submit a PR review. Own file (like
// projects-release.test.ts) rather than growing projects.test.ts; these
// routes never spawn a PTY session.
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { resetGitHubRateLimitForTests } = await import("../../src/services/github-fetch.js");
const { getPrDetail, resetPrDetailCacheForTests } =
  await import("../../src/services/github-pr-detail.js");
const { resetGraphqlBackoffForTests } = await import("../../src/services/github-pr-reviews.js");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const tmpDb = path.join(os.tmpdir(), `project-github-writes-test-${process.pid}.db`);

const gqlPr = {
  number: 7,
  title: "PR 7",
  url: "https://github.com/acme/widgets/pull/7",
  bodyHTML: "",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feat",
  headRefOid: "abc1234",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  author: { login: "me" },
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  commits: { totalCount: 0, nodes: [] },
  reviewRequests: { nodes: [] },
  latestOpinionatedReviews: { nodes: [] },
  latestReviews: { nodes: [] },
  reviews: { nodes: [] },
  reviewThreads: {
    nodes: [
      {
        id: "PRRT_1",
        isResolved: false,
        isOutdated: false,
        path: "a.ts",
        line: 2,
        comments: { nodes: [{ author: { login: "bob" }, bodyHTML: "<p>fix</p>", createdAt: "t" }] },
      },
    ],
  },
  comments: { nodes: [] },
};

describe("GitHub sidebar write routes (#1672)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  let apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  async function makeApp() {
    const app = await buildApp();
    apps.push(app);
    return app;
  }

  let fetchMock: ReturnType<typeof vi.fn>;
  let cwds: string[] = [];

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockGetInstallationToken.mockReset();
    mockGetInstallationToken.mockResolvedValue({ token: null, installationsChecked: 0 });
    resetGitHubRateLimitForTests();
    resetGraphqlBackoffForTests();
    resetPrDetailCacheForTests();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const toClose = apps;
    apps = [];
    await Promise.all(toClose.map((app) => app.close()));
    for (const cwd of cwds) fs.rmSync(cwd, { recursive: true, force: true });
    cwds = [];
    // The `integrations` row is a singleton across this file's DB.
    const app = await buildApp();
    const { disconnect } = await import("../../src/services/github-integration.js");
    disconnect(app);
    await app.close();
  });

  async function connectedProject(app: Awaited<ReturnType<typeof buildApp>>) {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "project-github-writes-"));
    cwds.push(projectCwd);
    fs.mkdirSync(path.join(projectCwd, ".git"));
    fs.writeFileSync(
      path.join(projectCwd, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
    );
    await app.inject({
      method: "PUT",
      url: "/api/integrations/github/token",
      payload: { token: "ghp_connected" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: `writes-${cwds.length}`,
        cwd: projectCwd,
      },
    });
    return created.json().id as number;
  }

  interface Call {
    url: string;
    method: string;
    body: Record<string, unknown> | null;
  }

  /**
   * Routes every GitHub call. GraphQL is dispatched on the query text: the
   * detail read and the two mutations all hit `/graphql`.
   */
  function mockGithub(handlers: {
    mutation?: (body: Record<string, unknown>) => Response;
    rest?: (url: string, method: string) => Response | null;
  }) {
    const calls: Call[] = [];
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method, body });
      if (url === "https://api.github.com/user") {
        return Promise.resolve(jsonResponse(200, { login: "octocat" }));
      }
      if (url.endsWith("/graphql")) {
        if (String(body?.query).trim() === "query { viewer { login } }") {
          return Promise.resolve(
            jsonResponse(200, { data: { viewer: { login: "mullion-session-manager[bot]" } } }),
          );
        }
        if (String(body?.query).trim().startsWith("mutation") && handlers.mutation) {
          return Promise.resolve(handlers.mutation(body));
        }
        return Promise.resolve(jsonResponse(200, { data: { repository: { pullRequest: gqlPr } } }));
      }
      if (url.includes("/files")) return Promise.resolve(jsonResponse(200, []));
      const custom = handlers.rest?.(url, method);
      if (custom) return Promise.resolve(custom);
      return Promise.reject(new Error(`unexpected fetch in test: ${method} ${url}`));
    });
    return calls;
  }

  const detailReads = (calls: Call[]) =>
    calls.filter((c) => c.url.endsWith("/graphql") && String(c.body?.query).includes("query("))
      .length;

  describe("reply to a thread", () => {
    it("posts via addPullRequestReviewThreadReply and drops the cached detail", async () => {
      const calls = mockGithub({
        mutation: () =>
          jsonResponse(200, {
            data: {
              addPullRequestReviewThreadReply: {
                comment: {
                  author: { login: "octocat" },
                  bodyHTML: "<p>done</p>",
                  createdAt: "2026-02-01T00:00:00Z",
                  url: "https://github.com/acme/widgets/pull/7#discussion_r9",
                },
              },
            },
          }),
      });
      const app = await makeApp();
      const id = await connectedProject(app);
      await getPrDetail("ghp_connected", "acme", "widgets", 7);
      expect(detailReads(calls)).toBe(1);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/threads/PRRT_1/reply`,
        payload: { body: "  done  " },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        author: "octocat",
        bodyHtml: "<p>done</p>",
        createdAt: "2026-02-01T00:00:00Z",
        htmlUrl: "https://github.com/acme/widgets/pull/7#discussion_r9",
      });
      const mutation = calls.find((c) => String(c.body?.query).includes("ThreadReply"));
      expect(mutation?.body?.variables).toEqual({ id: "PRRT_1", body: "done" });

      await getPrDetail("ghp_connected", "acme", "widgets", 7);
      expect(detailReads(calls)).toBe(2);
    });

    it("400s a blank body before calling GitHub", async () => {
      const calls = mockGithub({});
      const app = await makeApp();
      const id = await connectedProject(app);
      const before = calls.length;
      const blank = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/threads/PRRT_1/reply`,
        payload: { body: "   " },
      });
      expect(blank.statusCode).toBe(400);
      const missing = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/threads/PRRT_1/reply`,
        payload: {},
      });
      expect(missing.statusCode).toBe(400);
      const badNumber = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/x/threads/PRRT_1/reply`,
        payload: { body: "hi" },
      });
      expect(badNumber.statusCode).toBe(400);
      expect(calls.length).toBe(before);
    });

    it("maps a PAT's GraphQL scope refusals to 403, a GraphQL rate limit to 429, no data to 502", async () => {
      let answer: unknown = {};
      mockGithub({ mutation: () => jsonResponse(200, answer) });
      const app = await makeApp();
      const id = await connectedProject(app);
      const post = () =>
        app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/7/threads/PRRT_1/reply`,
          payload: { body: "hi" },
        });
      for (const message of [
        "Resource not accessible by personal access token",
        "Your token has not been granted the required scopes to execute this query.",
      ]) {
        answer = { errors: [{ message }] };
        expect((await post()).statusCode, message).toBe(403);
      }
      answer = { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] };
      expect((await post()).statusCode).toBe(429);
      answer = {};
      expect((await post()).statusCode).toBe(502);
    });

    it("maps a GraphQL permission error (HTTP 200) to 403", async () => {
      mockGithub({
        mutation: () =>
          jsonResponse(200, { errors: [{ message: "Resource not accessible by integration" }] }),
      });
      const app = await makeApp();
      const id = await connectedProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/threads/PRRT_1/reply`,
        payload: { body: "hi" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toMatch(/write access/);
    });

    it("passes another GraphQL refusal through as 422 with GitHub's reason", async () => {
      mockGithub({
        mutation: () =>
          jsonResponse(200, {
            errors: [{ message: "Could not resolve to a node with the global id of 'nope'" }],
          }),
      });
      const app = await makeApp();
      const id = await connectedProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/threads/nope/reply`,
        payload: { body: "hi" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().message).toMatch(/Could not resolve to a node/);
    });

    it("502s when GitHub returns no comment", async () => {
      mockGithub({
        mutation: () =>
          jsonResponse(200, { data: { addPullRequestReviewThreadReply: { comment: null } } }),
      });
      const app = await makeApp();
      const id = await connectedProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/threads/PRRT_1/reply`,
        payload: { body: "hi" },
      });
      expect(res.statusCode).toBe(502);
    });

    it("502s with a clear message when no write token is available", async () => {
      mockGithub({});
      const app = await makeApp();
      const id = await connectedProject(app);
      await app.inject({ method: "DELETE", url: "/api/integrations/github" });
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/threads/PRRT_1/reply`,
        payload: { body: "hi" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toMatch(/write access/);
    });
  });

  describe("resolve a thread", () => {
    it("resolves via resolveReviewThread", async () => {
      const calls = mockGithub({
        mutation: () =>
          jsonResponse(200, { data: { resolveReviewThread: { thread: { id: "PRRT_1" } } } }),
      });
      const app = await makeApp();
      const id = await connectedProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/threads/PRRT_1/resolve`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ resolved: true });
      const mutation = calls.find((c) => String(c.body?.query).includes("resolveReviewThread"));
      expect(mutation?.body?.variables).toEqual({ id: "PRRT_1" });
    });

    it("maps a 403 to a write-access refusal and an outage to 502", async () => {
      let status = 403;
      mockGithub({ mutation: () => jsonResponse(status, { message: "nope" }) });
      const app = await makeApp();
      const id = await connectedProject(app);
      const url = `/api/projects/${id}/github/prs/7/threads/PRRT_1/resolve`;
      const forbidden = await app.inject({ method: "POST", url });
      expect(forbidden.statusCode).toBe(403);
      status = 500;
      const down = await app.inject({ method: "POST", url });
      expect(down.statusCode).toBe(502);
    });

    it("400s an invalid PR number", async () => {
      mockGithub({});
      const app = await makeApp();
      const id = await connectedProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/0/threads/PRRT_1/resolve`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("comment on an issue or PR", () => {
    it("posts an issue comment", async () => {
      const calls = mockGithub({
        rest: (url, method) =>
          method === "POST" && url.endsWith("/repos/acme/widgets/issues/7/comments")
            ? jsonResponse(201, {
                id: 99,
                html_url: "https://github.com/acme/widgets/issues/7#c99",
              })
            : null,
      });
      const app = await makeApp();
      const id = await connectedProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/issues/7/comments`,
        payload: { body: "Looks good" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: 99,
        htmlUrl: "https://github.com/acme/widgets/issues/7#c99",
      });
      expect(calls.find((c) => c.url.endsWith("/comments"))?.body).toEqual({ body: "Looks good" });
    });

    it("400s a blank comment and an invalid number", async () => {
      mockGithub({});
      const app = await makeApp();
      const id = await connectedProject(app);
      const blank = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/issues/7/comments`,
        payload: { body: " \n " },
      });
      expect(blank.statusCode).toBe(400);
      const bad = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/issues/-1/comments`,
        payload: { body: "hi" },
      });
      expect(bad.statusCode).toBe(400);
    });

    it("maps a write 404 to 404, a 403 to 403 and a rate limit to 429", async () => {
      let status = 404;
      mockGithub({
        rest: () =>
          status === 429
            ? new Response("{}", {
                status: 429,
                headers: { "retry-after": "60", "content-type": "application/json" },
              })
            : jsonResponse(status, { message: "nope" }),
      });
      const app = await makeApp();
      const id = await connectedProject(app);
      const url = `/api/projects/${id}/github/issues/7/comments`;
      const missing = await app.inject({ method: "POST", url, payload: { body: "hi" } });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().message).toMatch(/not found in this repository/);
      status = 403;
      const forbidden = await app.inject({ method: "POST", url, payload: { body: "hi" } });
      expect(forbidden.statusCode).toBe(403);
      status = 429;
      const limited = await app.inject({ method: "POST", url, payload: { body: "hi" } });
      expect(limited.statusCode).toBe(429);
    });
  });

  describe("submit a review", () => {
    function reviewRoute(onPost: (body: Record<string, unknown> | null) => Response) {
      const calls = mockGithub({
        rest: (url, method) =>
          method === "POST" && url.endsWith("/pulls/7/reviews") ? onPost(null) : null,
      });
      return calls;
    }

    // #2049 — the sidebar posts as the connected account, not the App.
    it("posts with the connected account's token even when an App is installed", async () => {
      mockGetInstallationToken.mockResolvedValue({ token: "ghs_app", installationsChecked: null });
      const calls = reviewRoute(() => jsonResponse(200, { id: 5, html_url: "u" }));
      const app = await makeApp();
      const { setGitHubApp } = await import("../../src/services/github-integration.js");
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      const id = await connectedProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/reviews`,
        payload: { event: "APPROVE" },
      });
      expect(res.statusCode).toBe(200);
      // The App is still minted for reads, but never for this write.
      expect(mockGetInstallationToken.mock.calls.some((c) => c[4] === "write")).toBe(false);
      expect(calls.some((c) => c.url.endsWith("/pulls/7/reviews"))).toBe(true);
    });

    // #2283 — the issue detail names the identity a comment from its box posts as.
    it("reports the App, with its login, on the issue detail when no account is connected", async () => {
      mockGetInstallationToken.mockResolvedValue({ token: "ghs_app", installationsChecked: null });
      mockGithub({
        rest: (url) => {
          if (url.includes("/issues/9/comments")) return jsonResponse(200, []);
          if (url.endsWith("/issues/9")) {
            return jsonResponse(200, {
              number: 9,
              title: "issue 9",
              html_url: "https://github.com/acme/widgets/issues/9",
              user: { login: "a" },
              labels: [],
              assignees: [],
              comments: 0,
              milestone: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
              body_html: "<p>b</p>",
              state: "open",
            });
          }
          return null;
        },
      });
      const app = await makeApp();
      const { setGitHubApp, resetSidebarIdentityCache } =
        await import("../../src/services/github-integration.js");
      resetSidebarIdentityCache();
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      const id = await connectedProject(app);
      await app.inject({ method: "DELETE", url: "/api/integrations/github" });
      const res = await app.inject({ method: "GET", url: `/api/projects/${id}/github/issues/9` });
      expect(res.statusCode).toBe(200);
      expect(res.json().writeIdentity).toEqual({
        kind: "app",
        login: "mullion-session-manager",
      });
    });

    it("lets the App comment but refuses its verdicts when no account is connected", async () => {
      mockGetInstallationToken.mockResolvedValue({ token: "ghs_app", installationsChecked: null });
      reviewRoute(() => jsonResponse(200, { id: 5, html_url: "u" }));
      const app = await makeApp();
      const { setGitHubApp } = await import("../../src/services/github-integration.js");
      setGitHubApp(app, "123", FAKE_APP_PRIVATE_KEY);
      const id = await connectedProject(app);
      await app.inject({ method: "DELETE", url: "/api/integrations/github" });
      const url = `/api/projects/${id}/github/prs/7/reviews`;

      const approve = await app.inject({ method: "POST", url, payload: { event: "APPROVE" } });
      expect(approve.statusCode).toBe(409);
      expect(approve.json().message).toMatch(/connect your GitHub account/);
      const changes = await app.inject({
        method: "POST",
        url,
        payload: { event: "REQUEST_CHANGES", body: "x" },
      });
      expect(changes.statusCode).toBe(409);
      const comment = await app.inject({
        method: "POST",
        url,
        payload: { event: "COMMENT", body: "a thought" },
      });
      expect(comment.statusCode).toBe(200);
    });

    it("submits each event, pinned to the head the user saw", async () => {
      const calls = reviewRoute(() =>
        jsonResponse(200, { id: 5, html_url: "https://github.com/acme/widgets/pull/7#r5" }),
      );
      const app = await makeApp();
      const id = await connectedProject(app);
      const url = `/api/projects/${id}/github/prs/7/reviews`;

      const approve = await app.inject({
        method: "POST",
        url,
        payload: { event: "APPROVE", headSha: "abc1234" },
      });
      expect(approve.statusCode).toBe(200);
      expect(approve.json()).toEqual({
        id: 5,
        htmlUrl: "https://github.com/acme/widgets/pull/7#r5",
      });
      const changes = await app.inject({
        method: "POST",
        url,
        payload: { event: "REQUEST_CHANGES", body: "please fix" },
      });
      expect(changes.statusCode).toBe(200);

      const posts = calls.filter((c) => c.url.endsWith("/reviews"));
      expect(posts[0].body).toEqual({ body: "", commit_id: "abc1234", event: "APPROVE" });
      expect(posts[1].body).toEqual({ body: "please fix", event: "REQUEST_CHANGES" });
    });

    it("400s a comment without a body, an unknown event and a malformed sha", async () => {
      const calls = reviewRoute(() => jsonResponse(200, { id: 1, html_url: "x" }));
      const app = await makeApp();
      const id = await connectedProject(app);
      const url = `/api/projects/${id}/github/prs/7/reviews`;
      for (const payload of [
        { event: "COMMENT", body: "  " },
        { event: "REQUEST_CHANGES" },
        { event: "DISMISS", body: "x" },
        { event: "APPROVE", headSha: "not-a-sha" },
      ]) {
        const res = await app.inject({ method: "POST", url, payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
      const bad = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/abc/reviews`,
        payload: { event: "APPROVE" },
      });
      expect(bad.statusCode).toBe(400);
      expect(calls.filter((c) => c.url.endsWith("/reviews"))).toHaveLength(0);
    });

    it("explains GitHub's refusal of a self-approval", async () => {
      reviewRoute(() =>
        jsonResponse(422, {
          message: "Unprocessable Entity",
          errors: ["Can not approve your own pull request"],
        }),
      );
      const app = await makeApp();
      const id = await connectedProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/reviews`,
        payload: { event: "APPROVE" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().message).toMatch(/author approve or request changes/);
    });

    it("reads the reason out of object-shaped 422 errors", async () => {
      reviewRoute(() =>
        jsonResponse(422, {
          message: "Validation Failed",
          errors: [
            { resource: "PullRequestReview", code: "custom", message: "Line is out of range" },
          ],
        }),
      );
      const app = await makeApp();
      const id = await connectedProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/reviews`,
        payload: { event: "COMMENT", body: "x" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().message).toBe("GitHub refused to submit this review: Line is out of range");
    });

    it("passes another 422 through with GitHub's reason", async () => {
      reviewRoute(() =>
        jsonResponse(422, { message: "Unprocessable Entity", errors: ["Review body is too long"] }),
      );
      const app = await makeApp();
      const id = await connectedProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/github/prs/7/reviews`,
        payload: { event: "COMMENT", body: "x" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().message).toBe(
        "GitHub refused to submit this review: Review body is too long",
      );
    });
  });
});
