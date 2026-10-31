// The PR-detail routes, read side.
//
// Moved out of test/routes/projects.test.ts (issue #2399, audit finding F2),
// alongside the routes themselves: src/routes/project-github.ts. The GitHub
// route block left projects.ts, and the test tree mirrors the source tree.
//
// GET /api/projects/:id/github/prs/:number and the relay's view of the review
// on it: the phase the panel shows, the 404, the hand-off prompt and the branch
// preview.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty" — see mock-pty.ts's header comment for the empirically
// confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { RelayReviewState } from "../../src/shared/types.js";
import type * as HermesReview from "../../src/services/hermes-review.js";
import { getReviewRunForPr } from "../../src/services/hermes-review.js";
import { PR_REVIEW_DEFAULTS } from "../helpers/pr-review-defaults.js";
import { buildTestApp } from "../helpers/app.js";

const { buildApp } = await import("../../src/app.js");

vi.mock("node-pty", () => plainNodePtyMock());

// The same trick for the review relay's run lookup (issue #1630): the route
// asks "does this Mullion know a review run for this PR?", and a test can
// answer that without dispatching a real run.
vi.mock("../../src/services/hermes-review.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HermesReview>();
  return {
    ...actual,
    getReviewRunForPr: vi.fn(actual.getReviewRunForPr),
  };
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

      // The review relay's state for a PR (issue #1630) — what the operator's
      // panel shows: was a review requested, did it land, what did it say.
      describe("the relay's state for a PR (#1630)", () => {
        const relayRun = {
          runId: "run_1",
          kind: "pull_request" as const,
          owner: "acme",
          repo: "widgets",
          prNumber: 41,
          headSha: "sha41",
          dispatchedAt: Date.now(),
        };

        // The landed check is memoized per app (one GitHub call, not one per
        // poll), and each test builds its own app — so every test starts
        // from an empty memo.

        // The run index is mocked per test; reset it afterwards so one
        // test's mock cannot leak into the next.
        afterEach(() => {
          vi.mocked(getReviewRunForPr).mockReturnValue(null);
        });

        it("reports 'none' when this Mullion knows no run for the PR", async () => {
          vi.mocked(getReviewRunForPr).mockReturnValue(null);
          mockGithub(gqlPr(41));
          const app = await buildTestApp();
          const { id } = await connectedProject(app);
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/prs/41/review`,
          });
          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({ state: "none" });
        });

        it("reports the requested state while the review has not landed", async () => {
          vi.mocked(getReviewRunForPr).mockReturnValue(relayRun);
          mockGithub(gqlPr(41), (url) =>
            url.includes("/pulls/41/reviews") ? jsonResponse(200, []) : null,
          );
          const app = await buildTestApp();
          const { id } = await connectedProject(app);
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/prs/41/review`,
          });
          expect(res.statusCode).toBe(200);
          expect(res.json()).toMatchObject({ state: "requested", runId: "run_1" });
        });

        it("re-checks the landed review after the memo window, so a review that lands is seen", async () => {
          // The memo must be a TTL, not a sliding window: the PR list is
          // refreshed on every webhook event, so a reader faster than the
          // window would otherwise pin the cached answer and never see the
          // review land.
          vi.mocked(getReviewRunForPr).mockReturnValue(relayRun);
          let reviews = 0;
          mockGithub(gqlPr(41), (url) => {
            if (!url.includes("/pulls/41/reviews")) return null;
            reviews += 1;
            // The review has not landed on the first check, and has on the
            // ones after it.
            if (reviews === 1) return jsonResponse(200, []);
            return jsonResponse(200, [
              {
                user: { login: "s3ntin3l8-hermes[bot]", type: "Bot" },
                state: "APPROVED",
                commit_id: "sha41",
                submitted_at: new Date().toISOString(),
              },
            ]);
          });
          const app = await buildTestApp();
          const { id } = await connectedProject(app);
          // Reads FASTER than the memo window, the way the PR list is
          // refreshed on every webhook event. A sliding window would keep
          // re-stamping the cached answer and never see the review land.
          vi.useFakeTimers({ toFake: ["Date"] });
          try {
            const base = Date.now();
            let state = "";
            for (let i = 0; i < 5; i += 1) {
              vi.setSystemTime(base + i * 5_000);
              const res = await app.inject({
                method: "GET",
                url: `/api/projects/${id}/github/prs/41/review`,
              });
              state = res.json().state;
              if (state === "landed") break;
            }
            expect(state).toBe("landed");
          } finally {
            vi.useRealTimers();
          }
          expect(reviews).toBeGreaterThan(1);
        });

        it("does not ask Hermes for the run status once the review has landed", async () => {
          // A landed review has nothing left to say — one gateway round-trip
          // per drill-in tick, and a warn per tick while Hermes is down, for
          // an answer nothing renders.
          vi.mocked(getReviewRunForPr).mockReturnValue(relayRun);
          mockGithub(gqlPr(41), (url) =>
            url.includes("/pulls/41/reviews")
              ? jsonResponse(200, [
                  {
                    user: { login: "s3ntin3l8-hermes[bot]", type: "Bot" },
                    state: "APPROVED",
                    commit_id: "sha41",
                    submitted_at: new Date().toISOString(),
                  },
                ])
              : null,
          );
          const app = await buildTestApp();
          const { id } = await connectedProject(app);
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/prs/41/review`,
          });
          expect(res.json()).toMatchObject({ state: "landed" });
          // The Hermes run status was never asked for.
          expect(res.json().status).toBeUndefined();
        });

        it("annotates the PR list with the relay's state", async () => {
          vi.mocked(getReviewRunForPr).mockReturnValue(relayRun);
          const { setRepoPRsStatus } = await import("../../src/services/github.js");
          setRepoPRsStatus("acme", "widgets", {
            prs: [
              {
                number: 41,
                title: "PR 41",
                htmlUrl: "https://github.com/acme/widgets/pull/41",
                author: "me",
                headSha: "sha41",
                headBranch: "feat",
                baseBranch: "main",
                ciStatus: null,
                actionsRuns: [],
                isDraft: false,
                updatedAt: null,
                reviewDecision: null,
                mergeable: null,
                mergeStateStatus: null,
                reviewers: [],
                requestedReviewers: [],
                unresolvedThreads: null,
                commentCount: null,
                reviewStateKnown: false,
                ciFetched: false,
                prPhase: "unknown",
              },
            ],
            prSummary: { total: 1, pass: 0, fail: 0, pending: 0, unknown: 1 },
          });
          mockGithub(gqlPr(41), (url) =>
            url.includes("/pulls/41/reviews") ? jsonResponse(200, []) : null,
          );
          const app = await buildTestApp();
          const { id } = await connectedProject(app);
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/prs`,
          });
          expect(res.statusCode).toBe(200);
          const pr = res.json().prs[0];
          expect(pr.relayReview).toMatchObject({ state: "requested" });
          // The list renders the state, the verdict and the author — not the
          // review's whole text, which the drill-in fetches when it is opened.
          expect(pr.relayReview.body).toBeUndefined();
          expect(pr.relayReview.bodyTruncated).toBeUndefined();
        });

        it("annotates the batch route's PR half too — that is the list a running app shows", async () => {
          // The panel's list comes from the batch route (it feeds the Zustand
          // store, which shadows the per-project fetch), so the relay's state
          // has to be annotated there too — otherwise the list's review
          // marker is dead in the live path.
          vi.mocked(getReviewRunForPr).mockReturnValue(relayRun);
          const { setRepoPRsStatus } = await import("../../src/services/github.js");
          setRepoPRsStatus("acme", "widgets", {
            prs: [
              {
                number: 41,
                title: "PR 41",
                htmlUrl: "https://github.com/acme/widgets/pull/41",
                author: "me",
                headSha: "sha41",
                headBranch: "feat",
                baseBranch: "main",
                ciStatus: null,
                actionsRuns: [],
                isDraft: false,
                updatedAt: null,
                reviewDecision: null,
                mergeable: null,
                mergeStateStatus: null,
                reviewers: [],
                requestedReviewers: [],
                unresolvedThreads: null,
                commentCount: null,
                reviewStateKnown: false,
                ciFetched: false,
                prPhase: "unknown",
              },
            ],
            prSummary: { total: 1, pass: 0, fail: 0, pending: 0, unknown: 1 },
          });
          mockGithub(gqlPr(41), (url) =>
            url.includes("/pulls/41/reviews") ? jsonResponse(200, []) : null,
          );
          const app = await buildTestApp();
          const { id } = await connectedProject(app);
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/git-refs?ids=${id}`,
          });
          expect(res.statusCode).toBe(200);
          const prs = res.json().prs[String(id)].prs as Array<{ relayReview?: unknown }>;
          expect(prs[0].relayReview).toMatchObject({ state: "requested" });
        });

        it("joins each PR to its Task Master task on prNumber, else branchName (A6)", async () => {
          const { setRepoPRsStatus } = await import("../../src/services/github.js");
          const { tasks } = await import("../../src/db/schema.js");
          const listed = (number: number, headBranch: string) => ({
            ...PR_REVIEW_DEFAULTS,
            number,
            title: `PR ${number}`,
            htmlUrl: `https://github.com/acme/widgets/pull/${number}`,
            author: "me",
            headSha: `sha${number}`,
            headBranch,
            baseBranch: "main",
            ciStatus: null,
            ciFetched: false,
            actionsRuns: [],
          });
          setRepoPRsStatus("acme", "widgets", {
            prs: [listed(41, "feat-a"), listed(42, "mullion/task-9-b"), listed(43, "other")],
            prSummary: { total: 3, pass: 0, fail: 0, pending: 0, unknown: 3 },
          });
          mockGithub(gqlPr(41));
          const app = await buildTestApp();
          const { id } = await connectedProject(app);
          const [byNumber] = app.db
            .insert(tasks)
            .values({ projectId: id, title: "t1", status: "reviewing", prNumber: 41 })
            .returning()
            .all();
          const [byBranch] = app.db
            .insert(tasks)
            .values({
              projectId: id,
              title: "t2",
              status: "in_progress",
              branchName: "mullion/task-9-b",
            })
            .returning()
            .all();
          // A promoted task (it has a prNumber) is not matched by branch: its
          // branch name reused by another PR must not claim that PR.
          app.db
            .insert(tasks)
            .values({
              projectId: id,
              title: "t3",
              status: "done",
              prNumber: 99,
              branchName: "other",
            })
            .run();
          type Row = { number: number; taskId?: number; taskStatus?: string };
          const check = (rows: Row[]) => {
            expect(rows.find((r) => r.number === 41)).toMatchObject({
              taskId: byNumber.id,
              taskStatus: "reviewing",
            });
            expect(rows.find((r) => r.number === 42)).toMatchObject({
              taskId: byBranch.id,
              taskStatus: "in_progress",
            });
            expect(rows.find((r) => r.number === 43)?.taskId).toBeUndefined();
          };
          const list = await app.inject({ method: "GET", url: `/api/projects/${id}/github/prs` });
          check(list.json().prs);
          // The rail reads the batched route — the two must agree.
          const batch = await app.inject({
            method: "GET",
            url: `/api/projects/git-refs?ids=${id}`,
          });
          check(batch.json().prs[String(id)].prs);
        });

        describe("the list routes never wait on GitHub for the relay's state (#1744)", () => {
          const listedPr = (relayReview?: RelayReviewState) => ({
            number: 41,
            title: "PR 41",
            htmlUrl: "https://github.com/acme/widgets/pull/41",
            author: "me",
            headSha: "sha41",
            headBranch: "feat",
            baseBranch: "main",
            ciStatus: null,
            actionsRuns: [],
            isDraft: false,
            updatedAt: null,
            reviewDecision: null,
            mergeable: null,
            mergeStateStatus: null,
            reviewers: [],
            requestedReviewers: [],
            unresolvedThreads: null,
            commentCount: null,
            reviewStateKnown: false,
            ciFetched: false,
            prPhase: "unknown" as const,
            ...(relayReview ? { relayReview } : {}),
          });

          async function seed(relayReview?: RelayReviewState) {
            const { setRepoPRsStatus } = await import("../../src/services/github.js");
            setRepoPRsStatus("acme", "widgets", {
              prs: [listedPr(relayReview)],
              prSummary: { total: 1, pass: 0, fail: 0, pending: 0, unknown: 1 },
            });
          }

          async function listBoth() {
            let reviewCalls = 0;
            mockGithub(gqlPr(41), (url) => {
              if (!url.includes("/pulls/41/reviews")) return null;
              reviewCalls += 1;
              return jsonResponse(200, []);
            });
            const app = await buildTestApp();
            const { id } = await connectedProject(app);
            const batch = await app.inject({
              method: "GET",
              url: `/api/projects/git-refs?ids=${id}`,
            });
            const list = await app.inject({ method: "GET", url: `/api/projects/${id}/github/prs` });
            return {
              batchPr: batch.json().prs[String(id)].prs[0],
              listPr: list.json().prs[0],
              reviewCalls: () => reviewCalls,
            };
          }

          it("serves the poller's annotation without a single review lookup", async () => {
            vi.mocked(getReviewRunForPr).mockReturnValue(relayRun);
            const landed = {
              state: "landed" as const,
              runId: "run_1",
              dispatchedAt: new Date(relayRun.dispatchedAt).toISOString(),
              landedChecked: true,
              author: "s3ntin3l8-hermes[bot]",
              verdict: "APPROVED",
            };
            await seed(landed);
            const { batchPr, listPr, reviewCalls } = await listBoth();
            expect(batchPr.relayReview).toMatchObject(landed);
            expect(listPr.relayReview).toMatchObject(landed);
            expect(reviewCalls()).toBe(0);
          });

          it("shows a review requested since the last poll as requested, with no lookup", async () => {
            // The cached annotation describes an older run; the in-memory run
            // index knows better, and the poller's next tick says if it landed.
            vi.mocked(getReviewRunForPr).mockReturnValue({ ...relayRun, runId: "run_2" });
            await seed({
              state: "landed",
              runId: "run_1",
              dispatchedAt: "2026-01-01T00:00:00.000Z",
              landedChecked: true,
              verdict: "APPROVED",
            });
            const { batchPr, listPr, reviewCalls } = await listBoth();
            for (const pr of [batchPr, listPr]) {
              expect(pr.relayReview).toMatchObject({
                state: "requested",
                runId: "run_2",
                landedChecked: false,
              });
              expect(pr.relayReview.verdict).toBeUndefined();
            }
            expect(reviewCalls()).toBe(0);
          });
        });

        it("leaves a PR the relay knows nothing about untouched", async () => {
          // The run index is in-memory: a PR this Mullion never dispatched a
          // review for must come back exactly as it was — no `relayReview`
          // key at all — so the panel has nothing to render for it.
          vi.mocked(getReviewRunForPr).mockImplementation((_owner, _repo, prNumber) =>
            prNumber === 41 ? relayRun : null,
          );
          const { setRepoPRsStatus } = await import("../../src/services/github.js");
          const pr = (number: number) => ({
            number,
            title: `PR ${number}`,
            htmlUrl: `https://github.com/acme/widgets/pull/${number}`,
            author: "me",
            headSha: `sha${number}`,
            headBranch: "feat",
            baseBranch: "main",
            ciStatus: null,
            actionsRuns: [],
            isDraft: false,
            updatedAt: null,
            reviewDecision: null,
            mergeable: null,
            mergeStateStatus: null,
            reviewers: [],
            requestedReviewers: [],
            unresolvedThreads: null,
            commentCount: null,
            reviewStateKnown: false,
            ciFetched: false,
            prPhase: "unknown" as const,
          });
          setRepoPRsStatus("acme", "widgets", {
            prs: [pr(41), pr(42)],
            prSummary: { total: 2, pass: 0, fail: 0, pending: 0, unknown: 2 },
          });
          mockGithub(gqlPr(41), (url) =>
            url.includes("/pulls/41/reviews") ? jsonResponse(200, []) : null,
          );
          const app = await buildTestApp();
          const { id } = await connectedProject(app);
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/prs`,
          });
          expect(res.statusCode).toBe(200);
          const prs = res.json().prs as Array<{ number: number; relayReview?: unknown }>;
          const known = prs.find((p) => p.number === 41);
          const unknown = prs.find((p) => p.number === 42);
          expect(known?.relayReview).toMatchObject({ state: "requested" });
          expect(unknown?.relayReview).toBeUndefined();
        });

        it("says the landed review could not be confirmed when the lookup fails", async () => {
          // A failed lookup is not the same as "no review landed" — the UI
          // has to be able to say so, instead of claiming the review is
          // still pending.
          vi.mocked(getReviewRunForPr).mockReturnValue(relayRun);
          mockGithub(gqlPr(41), (url) =>
            url.includes("/pulls/41/reviews") ? jsonResponse(500, { message: "boom" }) : null,
          );
          const app = await buildTestApp();
          const { id } = await connectedProject(app);
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/prs/41/review`,
          });
          expect(res.statusCode).toBe(200);
          expect(res.json()).toMatchObject({ state: "requested", landedChecked: false });
        });

        it("reports the landed review, with what the bot said", async () => {
          vi.mocked(getReviewRunForPr).mockReturnValue(relayRun);
          mockGithub(gqlPr(41), (url) =>
            url.includes("/pulls/41/reviews")
              ? jsonResponse(200, [
                  {
                    user: { login: "s3ntin3l8-hermes[bot]", type: "Bot" },
                    state: "CHANGES_REQUESTED",
                    commit_id: "sha41",
                    submitted_at: new Date().toISOString(),
                    body: "## Review\n\n**Verdict:** REQUEST_CHANGES",
                    html_url: "https://github.com/acme/widgets/pull/41#pullrequestreview-1",
                  },
                ])
              : null,
          );
          const app = await buildTestApp();
          const { id } = await connectedProject(app);
          const res = await app.inject({
            method: "GET",
            url: `/api/projects/${id}/github/prs/41/review`,
          });
          expect(res.statusCode).toBe(200);
          expect(res.json()).toMatchObject({
            state: "landed",
            verdict: "CHANGES_REQUESTED",
            author: "s3ntin3l8-hermes[bot]",
            body: "## Review\n\n**Verdict:** REQUEST_CHANGES",
            htmlUrl: "https://github.com/acme/widgets/pull/41#pullrequestreview-1",
          });
        });
      });

      it("returns the PR detail with the derived phase", async () => {
        mockGithub(gqlPr(41));
        await warmCiCache(41, "success", true);
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const res = await app.inject({ method: "GET", url: `/api/projects/${id}/github/prs/41` });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
          number: 41,
          headSha: "sha41",
          prPhase: "ready_to_merge",
          threads: [{ path: "a.ts" }],
        });
        const bad = await app.inject({ method: "GET", url: `/api/projects/${id}/github/prs/x` });
        expect(bad.statusCode).toBe(400);

        // Cold poller cache: no CI knowledge, so the phase must not claim "ready".
        const { setRepoPRsStatus } = await import("../../src/services/github.js");
        setRepoPRsStatus("acme", "widgets", {
          prs: [],
          prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
        });
        mockGithub(gqlPr(47, { mergeStateStatus: "UNSTABLE" }));
        const cold = await app.inject({ method: "GET", url: `/api/projects/${id}/github/prs/47` });
        expect(cold.json().prPhase).toBe("unknown");

        expect(cold.json().ciKnown).toBe(false);

        // Review-derived phases don't need CI knowledge, even with a cold cache.
        mockGithub(gqlPr(51, { reviewDecision: "CHANGES_REQUESTED" }));
        const changes = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/51`,
        });
        expect(changes.json().prPhase).toBe("changes_requested");

        // A warm entry with no CI answer (null) is unknown unless GitHub itself
        // calls the PR CLEAN; anything else can't be called ready.
        mockGithub(gqlPr(52, { mergeStateStatus: "UNSTABLE" }));
        await warmCiCache(52, null, false);
        const warmNoCi = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/52`,
        });
        expect(warmNoCi.json()).toMatchObject({ prPhase: "unknown", ciKnown: false });
        const refused = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/52/merge`,
          payload: { headSha: "sha52" },
        });
        expect(refused.statusCode).toBe(409);

        mockGithub(gqlPr(53));
        await warmCiCache(53, null, false);
        const clean = await app.inject({ method: "GET", url: `/api/projects/${id}/github/prs/53` });
        // ciKnown reports the poller's fetch, not GitHub's CLEAN tie-break.
        expect(clean.json()).toMatchObject({ prPhase: "ready_to_merge", ciKnown: false });
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("404s a missing PR", async () => {
        mockGithub(null as unknown as Record<string, unknown>);
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const res = await app.inject({ method: "GET", url: `/api/projects/${id}/github/prs/404` });
        expect(res.statusCode).toBe(404);
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("hand-off returns a prompt built from the open threads, plus the branch", async () => {
        mockGithub(gqlPr(42));
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const res = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/42/handoff`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().branch).toBe("feat");
        expect(res.json().prompt).toContain("a.ts:2");
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("hand-off lists a failing non-Actions check (codecov/patch) so the session is not told nothing is outstanding", async () => {
        mockGithub(
          gqlPr(43, {
            headCommit: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      state: "FAILURE",
                      contexts: {
                        totalCount: 1,
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "codecov/patch",
                            status: "COMPLETED",
                            conclusion: "FAILURE",
                            detailsUrl: "https://codecov.example/43",
                            checkSuite: { app: { slug: "codecov" } },
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
        const res = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/github/prs/43/handoff`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().prompt).toContain("Failing checks: codecov/patch");
        expect(res.json().prompt).not.toContain("nothing outstanding");
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });

      it("PR preview starts the head branch's preview, refusing forks and previews-off (#2018)", async () => {
        const branchPreview = await import("../../src/services/branch-preview.js");
        const start = vi.spyOn(branchPreview, "getOrCreateBranchPreview").mockResolvedValue({
          slug: "s1",
          kind: "project",
          projectId: 1,
          externalUrl: null,
          sessionId: 9,
          upstreamPort: 4321,
          createdAt: new Date(0),
          branch: "feat",
        });
        mockGithub(gqlPr(61));
        const app = await buildTestApp();
        const { projectCwd, id } = await connectedProject(app);
        const url = `/api/projects/${id}/github/prs/61/preview`;

        app.config.PREVIEW_BASE_HOST = "";
        expect((await app.inject({ method: "POST", url })).statusCode).toBe(404);

        app.config.PREVIEW_BASE_HOST = "preview.example.com";
        const bad = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/x/preview`,
        });
        expect(bad.statusCode).toBe(400);
        const ok = await app.inject({ method: "POST", url });
        expect(ok.statusCode).toBe(201);
        expect(ok.json()).toMatchObject({ slug: "s1", branch: "feat" });
        expect(start.mock.calls[0].slice(1)).toEqual([id, "feat", { fastForward: true }]);

        start.mockRejectedValueOnce(
          new branchPreview.BranchPreviewError("no_preview_control", "configure one"),
        );
        const refused = await app.inject({ method: "POST", url });
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({ code: "no_preview_control" });

        mockGithub(gqlPr(62, { isCrossRepository: true }));
        const fork = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/62/preview`,
        });
        expect(fork.statusCode).toBe(409);
        expect(fork.json()).toMatchObject({ code: "fork_unsupported" });
        expect(start).toHaveBeenCalledTimes(2);

        mockGithub(null as unknown as Record<string, unknown>);
        const missing = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/github/prs/404/preview`,
        });
        expect(missing.statusCode).toBe(404);
        start.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
      });
    });
  });
});
