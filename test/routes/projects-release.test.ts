import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// #744 — release-please detection/run/merge routes. Kept in its own file
// (the same split test/routes/projects-docker.test.ts and
// test/routes/projects-dev-server-detect.test.ts already use) rather than
// growing the already-huge projects.test.ts, and because these routes never
// spawn a PTY session — no node-pty/child_process mocking needed at all,
// same posture as test/routes/ws-github.test.ts.
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { setRepoPRsStatus, invalidatePRsCache, computePRSummary } =
  await import("../../src/services/github.js");
const { clearReleaseWorkflowCacheForTests, clearReleasePrCacheForTests } =
  await import("../../src/services/github-write.js");
const { resetGitHubRateLimitForTests } = await import("../../src/services/github-fetch.js");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RELEASE_WORKFLOW = {
  id: 2,
  name: "Release Please",
  path: ".github/workflows/release-please.yml",
};
const CI_WORKFLOW = { id: 1, name: "CI/CD", path: ".github/workflows/ci-cd.yml" };
const RELEASE_HEAD_REF = "release-please--branches--main--components--widgets";

function releasePr(
  overrides: Partial<{
    number: number;
    mergeable: boolean | null;
    mergeableState: string;
    merged: boolean;
    state: "open" | "closed";
    draft: boolean;
  }> = {},
) {
  return {
    number: overrides.number ?? 12,
    html_url: `https://github.com/acme/widgets/pull/${overrides.number ?? 12}`,
    node_id: "PR_release",
    draft: overrides.draft ?? false,
    head: { sha: "deadbeef", ref: RELEASE_HEAD_REF },
    base: { ref: "main" },
    title: "chore(main): release 0.2.46",
    state: overrides.state ?? "open",
    merged: overrides.merged ?? false,
    mergeable: overrides.mergeable === undefined ? true : overrides.mergeable,
    mergeable_state: overrides.mergeableState ?? "clean",
  };
}

const tmpDb = path.join(os.tmpdir(), `projects-release-test-${process.pid}.db`);

describe("release-please routes (#744)", () => {
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
  async function makeApp(): Promise<Awaited<ReturnType<typeof buildApp>>> {
    const app = await buildApp();
    apps.push(app);
    return app;
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // detectReleaseWorkflow's own 1h cache and getCachedReleasePullRequestStatus's
    // own 60s cache are both process-wide module state — every test in this
    // file reuses "acme/widgets", so a result cached by one test would
    // otherwise silently answer a later, differently-mocked test too.
    clearReleaseWorkflowCacheForTests();
    clearReleasePrCacheForTests();
    // Same reasoning for #759's own rate-limit budget — also process-wide
    // module state, and a test in this file deliberately trips it.
    resetGitHubRateLimitForTests();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const toClose = apps;
    apps = [];
    await Promise.all(toClose.map((app) => app.close()));

    // The `integrations` row is a singleton across this file's whole DB —
    // reset it after every test so a connected token doesn't leak into an
    // unrelated "no token" case (same reasoning as
    // test/routes/projects.test.ts's "github" describe block).
    const app = await buildApp();
    const { disconnect } = await import("../../src/services/github-integration.js");
    disconnect(app);
    await app.close();

    invalidatePRsCache("acme", "widgets");
    clearReleaseWorkflowCacheForTests();
    clearReleasePrCacheForTests();
    resetGitHubRateLimitForTests();
  });

  async function createConnectedProject(
    app: Awaited<ReturnType<typeof buildApp>>,
  ): Promise<{ projectId: number; projectCwd: string }> {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-release-"));
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
      payload: { createDir: true, name: "release-widgets", cwd: projectCwd },
    });
    return { projectId: created.json().id as number, projectCwd };
  }

  // Routes every api.github.com call this describe block's routes can make.
  // `overrides` lets a test replace/add specific endpoints; anything not
  // covered rejects loudly rather than hanging, same convention
  // test/routes/projects.test.ts's own github describe block uses.
  function githubApiRouter(overrides: {
    defaultBranch?: () => Response;
    workflows?: () => Response;
    releasePrs?: () => Response;
    releasePrsAll?: () => Response;
    prDetail?: (number: number) => Response;
    dispatch?: () => Response;
    merge?: () => Response;
  }) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "https://api.github.com/user") {
        return Promise.resolve(jsonResponse(200, { login: "octocat" }));
      }
      if (url === "https://api.github.com/repos/acme/widgets" && method === "GET") {
        return Promise.resolve(
          (overrides.defaultBranch ?? (() => jsonResponse(200, { default_branch: "main" })))(),
        );
      }
      if (url === "https://api.github.com/repos/acme/widgets/actions/workflows?per_page=100") {
        return Promise.resolve(
          (overrides.workflows ?? (() => jsonResponse(200, { workflows: [RELEASE_WORKFLOW] })))(),
        );
      }
      if (
        url ===
        "https://api.github.com/repos/acme/widgets/pulls?state=open&base=main&sort=created&direction=desc"
      ) {
        return Promise.resolve(
          (overrides.releasePrs ?? (() => jsonResponse(200, [releasePr()])))(),
        );
      }
      // #818 — resolveReleaseMerge's own out-of-band-merge fallback, only
      // ever reached when the state=open lookup above found nothing.
      // Defaults to "nothing there either," matching the pre-#818 behavior
      // of every existing test in this file that doesn't override it.
      if (
        url ===
        "https://api.github.com/repos/acme/widgets/pulls?state=all&base=main&sort=created&direction=desc"
      ) {
        return Promise.resolve((overrides.releasePrsAll ?? (() => jsonResponse(200, [])))());
      }
      const prDetailMatch = url.match(/\/repos\/acme\/widgets\/pulls\/(\d+)$/);
      if (prDetailMatch && method === "GET") {
        const number = Number(prDetailMatch[1]);
        return Promise.resolve(
          (overrides.prDetail ?? ((n: number) => jsonResponse(200, releasePr({ number: n }))))(
            number,
          ),
        );
      }
      if (url === "https://api.github.com/repos/acme/widgets/actions/workflows/2/dispatches") {
        return Promise.resolve(
          (overrides.dispatch ?? (() => new Response(null, { status: 204 })))(),
        );
      }
      if (url === "https://api.github.com/repos/acme/widgets/pulls/12/merge") {
        return Promise.resolve(
          (overrides.merge ?? (() => jsonResponse(200, { merged: true, sha: "merged-sha" })))(),
        );
      }
      return Promise.reject(new Error(`unexpected fetch in test: ${method} ${url}`));
    });
  }

  describe("GET /api/projects/:id/release", () => {
    it("400s for a non-integer project id", async () => {
      const app = await makeApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/not-a-number/release" });
      expect(res.statusCode).toBe(400);
    });

    it("404s for an unknown project", async () => {
      const app = await makeApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/release" });
      expect(res.statusCode).toBe(404);
    });

    it("204s for a project with no GitHub account connected", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-release-no-token-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
      );
      const app = await makeApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "no-token", cwd: projectCwd },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/release`,
      });
      expect(res.statusCode).toBe(204);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns detection: found and the full PR status, including cached ciStatus", async () => {
      fetchMock.mockImplementation(githubApiRouter({}));
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      setRepoPRsStatus("acme", "widgets", {
        prs: [
          {
            number: 12,
            title: "chore(main): release 0.2.46",
            htmlUrl: "https://github.com/acme/widgets/pull/12",
            author: null,
            headSha: "deadbeef",
            headBranch: RELEASE_HEAD_REF,
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: computePRSummary([
          {
            number: 12,
            title: "chore(main): release 0.2.46",
            htmlUrl: "https://github.com/acme/widgets/pull/12",
            author: null,
            headSha: "deadbeef",
            headBranch: RELEASE_HEAD_REF,
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ]),
      });

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/release` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        detection: { kind: "found", workflow: RELEASE_WORKFLOW },
        pr: {
          number: 12,
          htmlUrl: "https://github.com/acme/widgets/pull/12",
          title: "chore(main): release 0.2.46",
          headRef: RELEASE_HEAD_REF,
          headSha: "deadbeef",
          draft: false,
          mergeable: true,
          mergeableState: "clean",
          ciStatus: "success",
        },
      });
    });

    it("returns detection: found and pr: null when no release PR is open", async () => {
      fetchMock.mockImplementation(githubApiRouter({ releasePrs: () => jsonResponse(200, []) }));
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/release` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        detection: { kind: "found", workflow: RELEASE_WORKFLOW },
        pr: null,
      });
    });

    it("returns detection: not-configured when the repo has no release-please workflow", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({ workflows: () => jsonResponse(200, { workflows: [CI_WORKFLOW] }) }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/release` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ detection: { kind: "not-configured" }, pr: null });
    });

    it("returns detection: no-actions-scope, distinct from not-configured, when the token can't list workflows", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({
          workflows: () => new Response("nope", { status: 403 }),
        }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/release` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ detection: { kind: "no-actions-scope" }, pr: null });
    });

    // Regression: detectReleaseWorkflow now rethrows a rate limit instead of
    // collapsing it into "no-actions-scope" — this route must in turn
    // degrade to 204 (same posture as GET .../github), not a 500.
    it("204s, does not 500, when workflow detection hits a rate limit", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({
          workflows: () =>
            new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }),
        }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/release` });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /api/projects/:id/release/run", () => {
    it("dispatches the detected workflow against the default branch", async () => {
      const dispatchSpy = vi.fn(() => new Response(null, { status: 204 }));
      fetchMock.mockImplementation(githubApiRouter({ dispatch: dispatchSpy }));
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/run`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dispatched: true });
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/widgets/actions/workflows/2/dispatches",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ ref: "main" }) }),
      );
    });

    it("refuses with reason: no-workflow when the repo isn't a release-please repo", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({ workflows: () => jsonResponse(200, { workflows: [CI_WORKFLOW] }) }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/run`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dispatched: false, reason: "no-workflow" });
    });

    it("refuses with reason: no-dispatch-trigger on a 422 (workflow has no workflow_dispatch trigger)", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({
          dispatch: () =>
            new Response("Workflow does not have 'workflow_dispatch' trigger", { status: 422 }),
        }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/run`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ dispatched: false, reason: "no-dispatch-trigger" });
    });

    it("refuses with reason: dispatch-failed on any other dispatch error", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({ dispatch: () => new Response("server error", { status: 500 }) }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/run`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ dispatched: false, reason: "dispatch-failed" });
    });
  });

  describe("POST /api/projects/:id/release/merge", () => {
    it("merges a clean release PR", async () => {
      const mergeSpy = vi.fn(() => jsonResponse(200, { merged: true, sha: "merged-sha" }));
      fetchMock.mockImplementation(githubApiRouter({ merge: mergeSpy }));
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/merge`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: true });
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/widgets/pulls/12/merge",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            merge_method: "squash",
            sha: "deadbeef",
            commit_title: "chore(main): release 0.2.46",
          }),
        }),
      );
    });

    // GitHub can report mergeableState: "clean" on a draft PR — it only
    // refuses the merge call itself. Assert the route catches this before
    // ever attempting the merge, rather than surfacing GitHub's 405 as an
    // opaque merge-failed.
    it("refuses with reason: draft and does NOT attempt the merge", async () => {
      const mergeSpy = vi.fn(() => jsonResponse(200, { merged: true, sha: "merged-sha" }));
      fetchMock.mockImplementation(
        githubApiRouter({
          prDetail: (n) => jsonResponse(200, releasePr({ number: n, draft: true })),
          merge: mergeSpy,
        }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/merge`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: false, reason: "draft" });
      expect(mergeSpy).not.toHaveBeenCalled();
    });

    it("refuses with reason: no-release-pr when nothing is open", async () => {
      fetchMock.mockImplementation(githubApiRouter({ releasePrs: () => jsonResponse(200, []) }));
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/merge`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: false, reason: "no-release-pr" });
    });

    // Regression: getDefaultBranch/findReleasePullRequest used to sit
    // OUTSIDE this route's try/catch — a failure there (e.g. a token
    // missing the `metadata` scope GET /repos/{o}/{r} needs) escaped as an
    // uncaught 500 instead of the route's own `{merged:false, reason}`
    // refusal contract every other failure here follows.
    it("returns a merge-failed refusal, not a 500, when resolving the default branch fails", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({ defaultBranch: () => new Response("nope", { status: 403 }) }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/merge`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ merged: false, reason: "merge-failed" });
    });

    // The regression this test guards against: unlike the task-PR
    // merge-on-approve sweep, "behind" here must NOT call
    // updatePullRequestBranch (see the route's own doc comment for why —
    // release-please owns and force-pushes this branch, and updating it
    // would tag a release with a stale CHANGELOG). Asserted as a negative
    // — no PUT .../update-branch call — not just a response-shape check.
    it("refuses with reason: behind and does NOT call update-branch", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({
          prDetail: (n) => jsonResponse(200, releasePr({ number: n, mergeableState: "behind" })),
        }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/merge`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: false, reason: "behind" });
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("update-branch"),
        expect.anything(),
      );
    });

    it("refuses with reason: unstable and does not merge", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({
          prDetail: (n) => jsonResponse(200, releasePr({ number: n, mergeableState: "unstable" })),
        }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/merge`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: false, reason: "unstable" });
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/merge"),
        expect.objectContaining({ method: "PUT" }),
      );
    });

    it("treats an already-merged PR as merged: true, idempotently", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({
          prDetail: (n) =>
            jsonResponse(200, releasePr({ number: n, merged: true, state: "closed" })),
        }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/merge`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: true });
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/merge"),
        expect.objectContaining({ method: "PUT" }),
      );
    });

    // #818 Hermes review — a human merging the release PR directly on
    // GitHub, bypassing this route/the autorelease sweep entirely, used to
    // report merged: false, reason: "no-release-pr" forever (the state=open
    // lookup finds nothing once the PR is closed). The fallback lookup
    // below distinguishes this from the ordinary "not generated yet" case.
    it("treats a release PR merged out-of-band (no longer open) as merged: true", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({
          releasePrs: () => jsonResponse(200, []),
          releasePrsAll: () => jsonResponse(200, [releasePr({ number: 12 })]),
          prDetail: (n) =>
            jsonResponse(200, releasePr({ number: n, merged: true, state: "closed" })),
        }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/merge`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: true });
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/merge"),
        expect.objectContaining({ method: "PUT" }),
      );
    });

    // Same fallback lookup, but the most recent PR was closed WITHOUT
    // merging (a deliberate "skip this cycle," not a shipped release) — must
    // NOT be treated as merged: true, unlike the out-of-band-merge case
    // above. The underlying commits are still unreleased.
    it("does not treat a release PR closed without merging as merged: true", async () => {
      fetchMock.mockImplementation(
        githubApiRouter({
          releasePrs: () => jsonResponse(200, []),
          releasePrsAll: () => jsonResponse(200, [releasePr({ number: 12 })]),
          prDetail: (n) =>
            jsonResponse(200, releasePr({ number: n, merged: false, state: "closed" })),
        }),
      );
      const app = await makeApp();
      const { projectId } = await createConnectedProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/release/merge`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: false, reason: "no-release-pr" });
    });
  });
});
