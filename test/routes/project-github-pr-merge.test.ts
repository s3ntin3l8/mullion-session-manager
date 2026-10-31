// The PR-detail routes, merge gate.
//
// Moved out of test/routes/projects.test.ts (issue #2399, audit finding F2),
// alongside the routes themselves: src/routes/project-github.ts. The GitHub
// route block left projects.ts, and the test tree mirrors the source tree.
//
// The other half of the PR-detail describe: whether the PR may be merged, and
// the writes that decide it — merge, update-branch and re-review.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty" — see mock-pty.ts's header comment for the empirically
// confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as HermesReview from "../../src/services/hermes-review.js";
import type * as TaskApprove from "../../src/services/task-approve.js";
import type * as TaskReconciler from "../../src/services/task-reconciler.js";
import { assertReviewerConfigured, requestHermesReview } from "../../src/services/hermes-review.js";
import { PR_REVIEW_DEFAULTS } from "../helpers/pr-review-defaults.js";
import { buildTestApp } from "../helpers/app.js";

const { buildApp } = await import("../../src/app.js");

vi.mock("node-pty", () => plainNodePtyMock());

// The review relay's run lookup and dispatch, so a test can hand back a
// result without a real Hermes (#1630, #1790).
vi.mock("../../src/services/hermes-review.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HermesReview>();
  return {
    ...actual,
    assertReviewerConfigured: vi.fn(actual.assertReviewerConfigured),
    requestHermesReview: vi.fn(actual.requestHermesReview),
  };
});

// Passthrough wrapper so a test can assert a merge did not start branch cleanup.
vi.mock("../../src/services/task-approve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TaskApprove>();
  return { ...actual, cleanupMergedTaskBranch: vi.fn(actual.cleanupMergedTaskBranch) };
});

// Passthrough wrapper so a test can make the sidebar merge's task bookkeeping
// throw without touching the real implementation for every other test.
vi.mock("../../src/services/task-reconciler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TaskReconciler>();
  return { ...actual, finishTaskForMergedPr: vi.fn(actual.finishTaskForMergedPr) };
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  // github-integration's `integrations` row is a singleton shared across this
  // file's DB — reset it before every test so a connected token doesn't leak
  // into an unrelated "no token" case (same reasoning as
  // github-integration.test.ts).
  //
  // The reset runs in beforeEach, not afterEach: buildTestApp() closes its
  // app from an onTestFinished callback, which Vitest runs AFTER afterEach —
  // so in an afterEach this reset app would be built while the test's own app
  // is still open, and the two would collide on the shared hooks.sock.
  const resetApp = await buildApp();
  const { disconnect } = await import("../../src/services/github-integration.js");
  disconnect(resetApp);
  await resetApp.close();

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("projects route", () => {
  describe("GET /api/projects/:id/github (issue #27)", () => {
    describe("PR detail routes", () => {
      // The PR-detail fixtures (connectedProject, gqlPr, warmCiCache and
      // mockGithub) — the same four helpers as
      // test/routes/project-github-pr-detail.test.ts, which holds the read
      // side of this describe. They are duplicated rather than shared: a
      // test file in this repo stands alone, and the alternative — a shared
      // fixture module — is more coupling than a duplicated helper is worth
      // here.
      async function connectedProject(app: Awaited<ReturnType<typeof buildApp>>) {
        const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-prdetail-"));
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
          payload: { createDir: true, allowDuplicate: true, name: "pr-detail", cwd: projectCwd },
        });
        return { projectCwd, id: created.json().id as number };
      }

      const gqlPr = (number: number, over: Record<string, unknown> = {}) => ({
        number,
        title: `PR ${number}`,
        url: `https://github.com/acme/widgets/pull/${number}`,
        bodyHTML: "<p>b</p>",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        headRefName: "feat",
        headRefOid: `sha${number}`,
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        author: { login: "me" },
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        commits: { totalCount: 0, nodes: [] },
        reviewRequests: { nodes: [] },
        latestOpinionatedReviews: { nodes: [{ author: { login: "bob" }, state: "APPROVED" }] },
        latestReviews: { nodes: [{ author: { login: "bob" }, state: "APPROVED" }] },
        reviews: { nodes: [] },
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              isOutdated: false,
              path: "a.ts",
              line: 2,
              comments: {
                nodes: [{ author: { login: "bob" }, bodyHTML: "<p>fix</p>", createdAt: "t" }],
              },
            },
          ],
        },
        comments: { nodes: [] },
        ...over,
      });

      // The poller's CI view for a PR; without it the phase can't be "ready".
      async function warmCiCache(
        number: number,
        ciStatus: "success" | "failure" | null,
        // Whether the head-run lookup answered. Independent of ciStatus: an
        // answered-but-empty lookup is { ciStatus: null, ciFetched: true }, and
        // a failed one is { ciStatus: null, ciFetched: false }. Always explicit.
        ciFetched: boolean,
        headSha: string = `sha${number}`,
        actionsRuns: Array<{
          name: string;
          status: string;
          conclusion: string | null;
          htmlUrl: string;
          headSha: string;
        }> = [],
      ) {
        const { setRepoPRsStatus } = await import("../../src/services/github.js");
        setRepoPRsStatus("acme", "widgets", {
          prs: [
            {
              ...PR_REVIEW_DEFAULTS,
              number,
              title: `PR ${number}`,
              htmlUrl: `https://github.com/acme/widgets/pull/${number}`,
              author: "me",
              headSha,
              headBranch: "feat",
              baseBranch: "main",
              ciStatus,
              ciFetched,
              actionsRuns,
            },
          ],
          prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
        });
      }

      function mockGithub(
        pr: Record<string, unknown>,
        extra?: (url: string, init?: RequestInit) => Response | null,
      ) {
        fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const custom = extra?.(url, init);
          if (custom) return Promise.resolve(custom);
          if (url === "https://api.github.com/user") {
            return Promise.resolve(jsonResponse(200, { login: "octocat" }));
          }
          if (url.endsWith("/graphql")) {
            return Promise.resolve(
              jsonResponse(200, { data: { repository: { pullRequest: pr } } }),
            );
          }
          if (url.includes("/pulls/") && url.includes("/files")) {
            return Promise.resolve(jsonResponse(200, []));
          }
          return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
        });
      }

      it("merge: refuses a stale head, an unready PR, and merges a ready one", async () => {
        let merged: unknown = null;
        mockGithub(gqlPr(43), (url, init) => {
          if (url.endsWith("/pulls/43/merge")) {
            merged = JSON.parse(String(init?.body));
            return jsonResponse(200, { merged: true, sha: "mergesha" });
          }
          return null;
        });
        await warmCiCache(43, "success", true);
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const url = `/api/projects/${id}/github/prs/43/merge`;

        const noSha = await app.inject({ method: "POST", url, payload: {} });
        expect(noSha.statusCode).toBe(400);
        const stale = await app.inject({ method: "POST", url, payload: { headSha: "old" } });
        expect(stale.statusCode).toBe(409);
        expect(merged).toBeNull();

        const ok = await app.inject({ method: "POST", url, payload: { headSha: "sha43" } });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toEqual({ merged: true, sha: "mergesha" });
        expect(merged).toMatchObject({ merge_method: "squash", sha: "sha43" });
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      describe("merge finishes the linked task", () => {
        async function mergeSetup(n: number) {
          const { invalidatePrDetail } = await import("../../src/services/github-pr-detail.js");
          invalidatePrDetail("acme", "widgets", n);
          mockGithub(gqlPr(n), (url) =>
            url.endsWith(`/pulls/${n}/merge`)
              ? jsonResponse(200, { merged: true, sha: "m" })
              : null,
          );
          await warmCiCache(n, "success", true);
          const app = await buildTestApp();
          const { projectCwd, id } = await connectedProject(app);
          const merge = () =>
            app.inject({
              method: "POST",
              url: `/api/projects/${id}/github/prs/${n}/merge`,
              payload: { headSha: `sha${n}` },
            });
          return { app, id, projectCwd, merge };
        }
        const readTask = async (app: Awaited<ReturnType<typeof buildTestApp>>, taskId: number) => {
          const { tasks } = await import("../../src/db/schema.js");
          const { eq } = await import("drizzle-orm");
          return app.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
        };

        it("archives a done task, clears its merge state, and is idempotent", async () => {
          const { app, id, projectCwd, merge } = await mergeSetup(81);
          const { tasks } = await import("../../src/db/schema.js");
          const [task] = app.db
            .insert(tasks)
            .values({
              projectId: id,
              title: "d",
              status: "done",
              prNumber: 81,
              mergeRequestedAt: new Date(),
            })
            .returning()
            .all();
          expect((await merge()).statusCode).toBe(200);
          const after = await readTask(app, task.id);
          expect(after.mergedAt).toBeTruthy();
          expect(after.archivedAt).toBeTruthy();
          expect(after.mergeRequestedAt).toBeNull();

          // A second call (or the webhook) finds nothing left to do.
          const { finishTaskForMergedPr } = await import("../../src/services/task-reconciler.js");
          const project = app.db
            .select()
            .from((await import("../../src/db/schema.js")).projects)
            .all()[0]!;
          await finishTaskForMergedPr(app, project, 81);
          const again = await readTask(app, task.id);
          expect(again.mergedAt?.getTime()).toBe(after.mergedAt?.getTime());
          expect(again.archivedAt?.getTime()).toBe(after.archivedAt?.getTime());
          fs.rmSync(projectCwd, { recursive: true, force: true });
        });

        it("ends a reviewing task as done and archived", async () => {
          const { app, id, projectCwd, merge } = await mergeSetup(82);
          const { tasks } = await import("../../src/db/schema.js");
          const [task] = app.db
            .insert(tasks)
            .values({ projectId: id, title: "r", status: "reviewing", prNumber: 82 })
            .returning()
            .all();
          expect((await merge()).statusCode).toBe(200);
          const after = await readTask(app, task.id);
          expect(after.status).toBe("done");
          expect(after.archivedAt).toBeTruthy();
          fs.rmSync(projectCwd, { recursive: true, force: true });
        });

        it("records the merge on an in_progress task without cleaning up its worktree", async () => {
          const { app, id, projectCwd, merge } = await mergeSetup(84);
          const { tasks } = await import("../../src/db/schema.js");
          const { cleanupMergedTaskBranch } = await import("../../src/services/task-approve.js");
          vi.mocked(cleanupMergedTaskBranch).mockClear();
          const [task] = app.db
            .insert(tasks)
            .values({ projectId: id, title: "w", status: "in_progress", prNumber: 84 })
            .returning()
            .all();
          expect((await merge()).statusCode).toBe(200);
          const after = await readTask(app, task.id);
          expect(after.mergedAt).toBeTruthy();
          expect(after.status).toBe("in_progress");
          expect(cleanupMergedTaskBranch).not.toHaveBeenCalled();
          fs.rmSync(projectCwd, { recursive: true, force: true });
        });

        it("leaves the response unchanged when no task is linked", async () => {
          const { projectCwd, merge } = await mergeSetup(83);
          const res = await merge();
          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({ merged: true, sha: "m" });
          fs.rmSync(projectCwd, { recursive: true, force: true });
        });

        it("still returns the merge when the task bookkeeping throws", async () => {
          const { finishTaskForMergedPr } = await import("../../src/services/task-reconciler.js");
          vi.mocked(finishTaskForMergedPr).mockRejectedValueOnce(new Error("boom"));
          const { projectCwd, merge } = await mergeSetup(84);
          const res = await merge();
          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({ merged: true, sha: "m" });
          fs.rmSync(projectCwd, { recursive: true, force: true });
        });
      });

      // Issue #1672 — GitHub's "Update branch", pinned to the head the user saw.
      it("update-branch: requires a head, updates the PR, and maps GitHub's refusal to 409", async () => {
        const sent: unknown[] = [];
        mockGithub(gqlPr(45), (url, init) => {
          if (!url.endsWith("/pulls/45/update-branch")) return null;
          const body = JSON.parse(String(init?.body)) as { expected_head_sha: string };
          sent.push({ method: init?.method, ...body });
          return body.expected_head_sha === "sha45"
            ? jsonResponse(202, { message: "Updating pull request branch." })
            : jsonResponse(422, { message: "expected head sha didn't match current head ref." });
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const url = `/api/projects/${id}/github/prs/45/update-branch`;

        expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(400);
        const bad = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/x/update-branch`,
          payload: { headSha: "sha45" },
        });
        expect(bad.statusCode).toBe(400);

        const ok = await app.inject({ method: "POST", url, payload: { headSha: "sha45" } });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toEqual({ updated: true });

        const stale = await app.inject({ method: "POST", url, payload: { headSha: "old" } });
        expect(stale.statusCode).toBe(409);
        expect(sent).toEqual([
          { method: "PUT", expected_head_sha: "sha45" },
          { method: "PUT", expected_head_sha: "old" },
        ]);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("merge lets GitHub arbitrate a strict-BEHIND PR instead of refusing on the phase", async () => {
        const { invalidatePrDetail } = await import("../../src/services/github-pr-detail.js");
        invalidatePrDetail("acme", "widgets", 47);
        let merged = false;
        mockGithub(gqlPr(47, { mergeStateStatus: "BEHIND" }), (url) => {
          if (!url.endsWith("/pulls/47/merge")) return null;
          merged = true;
          return jsonResponse(200, { merged: true, sha: "mergesha" });
        });
        await warmCiCache(47, "success", true);
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/47/merge`,
          payload: { headSha: "sha47" },
        });
        expect(res.statusCode).toBe(200);
        expect(merged).toBe(true);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("detail re-derives a BEHIND phase when the compare says the head is not behind", async () => {
        // The detail cache is shared across tests: drop what these numbers hold.
        const { invalidatePrDetail } = await import("../../src/services/github-pr-detail.js");
        for (const n of [70, 71, 72]) invalidatePrDetail("acme", "widgets", n);
        mockGithub(
          gqlPr(70, { mergeStateStatus: "BEHIND", reviewThreads: { nodes: [] } }),
          (url) => (url.includes("/compare/") ? jsonResponse(200, { behind_by: 0 }) : null),
        );
        await warmCiCache(70, "success", true);
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const detail = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/70`,
        });
        expect(detail.json()).toMatchObject({ prPhase: "ready_to_merge", behindBy: 0 });

        // An open conversation still blocks, once the BEHIND is set aside.
        mockGithub(gqlPr(72, { mergeStateStatus: "BEHIND" }), (url) =>
          url.includes("/compare/") ? jsonResponse(200, { behind_by: 0 }) : null,
        );
        await warmCiCache(72, "success", true);
        const threads = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/72`,
        });
        expect(threads.json()).toMatchObject({ prPhase: "threads_unresolved" });

        mockGithub(gqlPr(71, { mergeStateStatus: "BEHIND" }), (url) =>
          url.includes("/compare/") ? jsonResponse(200, { behind_by: 2 }) : null,
        );
        await warmCiCache(71, "success", true);
        const behind = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/71`,
        });
        expect(behind.json()).toMatchObject({ prPhase: "behind", behindBy: 2 });
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("merge refuses a PR that is not ready (changes requested)", async () => {
        mockGithub(gqlPr(44, { reviewDecision: "CHANGES_REQUESTED" }));
        await warmCiCache(44, "success", true);
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/44/merge`,
          payload: { headSha: "sha44" },
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().message).toMatch(/changes requested/);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("merge refuses when CI knowledge is cold or mergeability is unconfirmed", async () => {
        mockGithub(gqlPr(48, { mergeStateStatus: "UNSTABLE" }));
        const { setRepoPRsStatus } = await import("../../src/services/github.js");
        setRepoPRsStatus("acme", "widgets", {
          prs: [],
          prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const url = (n: number) => `/api/projects/${id}/github/prs/${n}/merge`;

        const cold = await app.inject({
          method: "POST",
          url: url(48),
          payload: { headSha: "sha48" },
        });
        expect(cold.statusCode).toBe(409);
        expect(cold.json().message).toMatch(/unknown/);

        mockGithub(gqlPr(49, { mergeable: "UNKNOWN" }));
        await warmCiCache(49, "success", true);
        const unconfirmed = await app.inject({
          method: "POST",
          url: url(49),
          payload: { headSha: "sha49" },
        });
        expect(unconfirmed.statusCode).toBe(409);
        expect(unconfirmed.json().message).toMatch(/mergeable/);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("a 403'd runs lookup in the real poller path can't make a PR ready or hide 'unknown'", async () => {
        // Run the real getRepoPRsStatus with /actions/runs answering 403, warm
        // the cache with its result, then read the detail through the route.
        const { getRepoPRsStatus, setRepoPRsStatus } = await import("../../src/services/github.js");
        fetchMock.mockImplementation((input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/actions/runs")) {
            return Promise.resolve(new Response("nope", { status: 403 }));
          }
          if (url.includes("/pulls?")) {
            return Promise.resolve(
              jsonResponse(200, [
                {
                  number: 54,
                  title: "PR 54",
                  html_url: "https://github.com/acme/widgets/pull/54",
                  user: { login: "me" },
                  head: { sha: "sha54", ref: "feat" },
                  base: { ref: "main" },
                },
              ]),
            );
          }
          return Promise.resolve(jsonResponse(200, {}));
        });
        const status = await getRepoPRsStatus("tok", "acme", "widgets");
        expect(status.prs[0]).toMatchObject({ ciStatus: null, ciFetched: false });
        // The 403 above recorded a process-wide backoff; later calls must not inherit it.
        const { resetGitHubRateLimitForTests } = await import("../../src/services/github-fetch.js");
        resetGitHubRateLimitForTests();
        setRepoPRsStatus("acme", "widgets", status);

        mockGithub(gqlPr(54, { mergeStateStatus: "UNSTABLE" }));
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const detail = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/54`,
        });
        expect(detail.json()).toMatchObject({ prPhase: "unknown", ciKnown: false });
        const merge = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/54/merge`,
          payload: { headSha: "sha54" },
        });
        expect(merge.statusCode).toBe(409);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("ignores a poller entry for an older head: no ready, no old runs, merge refused", async () => {
        // The poller last saw sha-old with green CI; the live PR is at sha55
        // (UNSTABLE). The old answer must not vouch for the new commit.
        mockGithub(gqlPr(55, { mergeStateStatus: "UNSTABLE" }));
        await warmCiCache(55, "success", true, "sha-old", [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            htmlUrl: "https://github.com/acme/widgets/actions/runs/1",
            headSha: "sha-old",
          },
        ]);
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const detail = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/55`,
        });
        expect(detail.json()).toMatchObject({
          prPhase: "unknown",
          ciStatus: null,
          ciKnown: false,
          actionsRuns: [],
        });
        const merge = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/55/merge`,
          payload: { headSha: "sha55" },
        });
        expect(merge.statusCode).toBe(409);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("fetches the runs for the detail's own head live when the poller's entry is for an older head", async () => {
        mockGithub(gqlPr(57), (url) =>
          url.includes("/actions/runs?head_sha=sha57")
            ? jsonResponse(200, {
                workflow_runs: [
                  {
                    name: "CI",
                    status: "completed",
                    conclusion: "success",
                    html_url: "https://github.com/acme/widgets/actions/runs/9",
                    head_sha: "sha57",
                  },
                ],
              })
            : null,
        );
        await warmCiCache(57, "failure", true, "sha-old");
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const detail = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/57`,
        });
        expect(detail.json()).toMatchObject({
          ciStatus: "success",
          ciKnown: true,
          prPhase: "ready_to_merge",
        });
        expect(detail.json().actionsRuns).toHaveLength(1);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("shares one live runs lookup between concurrent detail requests and caches a failed one briefly", async () => {
        let runLookups = 0;
        mockGithub(gqlPr(61), (url) => {
          if (!url.includes("/actions/runs?head_sha=sha61")) return null;
          runLookups += 1;
          return jsonResponse(403, {});
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const get = () => app.inject({ method: "GET", url: `/api/projects/${id}/github/prs/61` });
        const [a, b] = await Promise.all([get(), get()]);
        expect(a.json().ciKnown).toBe(false);
        expect(b.json().ciKnown).toBe(false);
        // Even after the detail cache is dropped, the failed answer is remembered.
        const { invalidatePrDetail } = await import("../../src/services/github-pr-detail.js");
        invalidatePrDetail("acme", "widgets", 61);
        await get();
        expect(runLookups).toBe(1);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("surfaces non-Actions checks as otherChecks and counts them in the CI status", async () => {
        mockGithub(
          gqlPr(59, {
            headCommit: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      state: "FAILURE",
                      contexts: {
                        totalCount: 60,
                        nodes: [
                          {
                            __typename: "StatusContext",
                            context: "ci/circle",
                            state: "FAILURE",
                            targetUrl: "https://circle.example/1",
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          }),
          (url) =>
            url.includes("/actions/runs?head_sha=")
              ? jsonResponse(200, { workflow_runs: [] })
              : null,
        );
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const detail = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/59`,
        });
        expect(detail.json()).toMatchObject({
          ciStatus: "failure",
          ciKnown: true,
          checksTruncated: true,
          otherChecks: [{ name: "ci/circle", state: "failure", source: "status" }],
        });
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("flags the PR list as stale (still serving it) once the poller's entry is past its TTL", async () => {
        mockGithub(gqlPr(60));
        await warmCiCache(60, "success", true);
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const fresh = await app.inject({ method: "GET", url: `/api/projects/${id}/github/prs` });
        expect(fresh.json().stale).toBeUndefined();
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(Date.now() + 5 * 60_000);
          const aged = await app.inject({ method: "GET", url: `/api/projects/${id}/github/prs` });
          expect(aged.statusCode).toBe(200);
          expect(aged.json()).toMatchObject({ stale: true });
          expect(aged.json().prs).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("returns a partial detail, not a 502, when GraphQL is unavailable", async () => {
        mockGithub(gqlPr(58), (url) => {
          if (url.endsWith("/graphql")) return jsonResponse(500, {});
          if (url.endsWith("/pulls/58")) {
            return jsonResponse(200, {
              number: 58,
              title: "REST title",
              html_url: "https://github.com/acme/widgets/pull/58",
              state: "open",
              user: { login: "me" },
              base: { ref: "main" },
              head: { ref: "feat", sha: "sha58" },
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            });
          }
          return null;
        });
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const detail = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/58`,
        });
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toMatchObject({ title: "REST title", partial: true, reviews: [] });
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("an answered-but-empty lookup (no runs) is a CI answer and can be ready", async () => {
        mockGithub(gqlPr(56, { mergeStateStatus: "UNSTABLE" }));
        await warmCiCache(56, null, true);
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const detail = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/56`,
        });
        expect(detail.json()).toMatchObject({ prPhase: "ready_to_merge", ciKnown: true });
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("merge says so when no write-scoped token is available", async () => {
        mockGithub(gqlPr(50));
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        await app.inject({ method: "DELETE", url: "/api/integrations/github" });
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/50/merge`,
          payload: { headSha: "sha50" },
        });
        expect(res.statusCode).toBe(502);
        expect(res.json().message).toMatch(/not connected/);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("merge maps a GitHub refusal to 409", async () => {
        await warmCiCache(45, "success", true);
        mockGithub(gqlPr(45), (url) =>
          url.endsWith("/pulls/45/merge") ? jsonResponse(405, { message: "not mergeable" }) : null,
        );
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/45/merge`,
          payload: { headSha: "sha45" },
        });
        expect(res.statusCode).toBe(409);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("re-review reports an unconfigured reviewer as a precondition failure", async () => {
        mockGithub(gqlPr(46));
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/46/re-review`,
        });
        expect(res.statusCode).toBe(412);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("returns the marker result and hands the relay a read token and no write token", async () => {
        vi.mocked(assertReviewerConfigured).mockReturnValueOnce("key");
        vi.mocked(requestHermesReview).mockResolvedValueOnce({
          runId: "run_9",
          status: "queued",
          replayed: false,
          marker: { written: false, reason: "app-not-configured", message: "no GitHub App" },
        });
        mockGithub(gqlPr(47));
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/47/re-review`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
          status: "dispatched",
          runId: "run_9",
          marker: { written: false, reason: "app-not-configured" },
        });
        expect(requestHermesReview).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            markerWriteToken: undefined,
            markerUnavailable: "app-not-configured",
          }),
        );
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("is never refused after an approval: the agent-only guard is not installed", async () => {
        vi.mocked(assertReviewerConfigured).mockReturnValueOnce("key");
        vi.mocked(requestHermesReview).mockResolvedValueOnce({
          runId: "run_10",
          status: "queued",
          replayed: false,
        });
        mockGithub(gqlPr(48));
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/48/re-review`,
        });
        expect(res.statusCode).toBe(200);
        // `beforeDispatch` is how the review-request route refuses after an
        // approval (reviewRelay.reReviewAfterApproval); a human's click must not carry it.
        expect(vi.mocked(requestHermesReview).mock.calls.at(-1)?.[1]).not.toHaveProperty(
          "beforeDispatch",
        );
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });
    });
  });
});
