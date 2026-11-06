import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as HostGit from "../../src/services/host-git.js";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as GithubWrite from "../../src/services/github-write.js";
import type * as GitStatus from "../../src/services/git-status.js";
import type * as GitRefs from "../../src/services/git-refs.js";
import type * as HermesReview from "../../src/services/hermes-review.js";

// #2634 — the route half: GET /api/sessions/:id/review-request for a review the
// repository's own workflow started. (review-relay.test.ts covers the relay's
// own runs; it is kept from growing, so this lives in its own file.) Only the
// network/host edges are mocked, as there.
const mocks = vi.hoisted(() => ({
  resolveRepoRefResult: vi.fn(),
  resolveGitHubToken: vi.fn(),
  resolveMarkerTokens: vi.fn(),
  findPullRequestByHead: vi.fn(),
  getPullRequestByNumber: vi.fn(),
  getGitStatus: vi.fn(),
  resolveRepoRoot: vi.fn(),
  listWorktrees: vi.fn(),
  assertReviewerConfigured: vi.fn(),
  getHermesReviewStatus: vi.fn(),
  getReviewRunForPr: vi.fn(),
  listPullRequestReviews: vi.fn(),
  completeReviewMarkerCheckRun: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (orig) => ({
  ...(await orig<typeof HostGit>()),
  resolveRepoRefResult: mocks.resolveRepoRefResult,
}));
vi.mock("../../src/services/github-integration.js", async (orig) => ({
  ...(await orig<typeof GithubIntegration>()),
  resolveGitHubToken: mocks.resolveGitHubToken,
  resolveMarkerTokens: mocks.resolveMarkerTokens,
}));
vi.mock("../../src/services/github-write.js", async (orig) => ({
  ...(await orig<typeof GithubWrite>()),
  findPullRequestByHead: mocks.findPullRequestByHead,
  getPullRequestByNumber: mocks.getPullRequestByNumber,
  listPullRequestReviews: mocks.listPullRequestReviews,
  completeReviewMarkerCheckRun: mocks.completeReviewMarkerCheckRun,
}));
vi.mock("../../src/services/git-status.js", async (orig) => ({
  ...(await orig<typeof GitStatus>()),
  getGitStatus: mocks.getGitStatus,
}));
vi.mock("../../src/services/git-refs.js", async (orig) => ({
  ...(await orig<typeof GitRefs>()),
  listWorktrees: mocks.listWorktrees,
  resolveRepoRoot: mocks.resolveRepoRoot,
}));
vi.mock("../../src/services/hermes-review.js", async (orig) => ({
  ...(await orig<typeof HermesReview>()),
  assertReviewerConfigured: mocks.assertReviewerConfigured,
  getHermesReviewStatus: mocks.getHermesReviewStatus,
  getReviewRunForPr: mocks.getReviewRunForPr,
}));

import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { resetRepoRefMemo } from "../../src/routes/review-relay.js";
import { projects, sessions } from "../../src/db/schema.js";

const tmpDb = path.join(os.tmpdir(), `review-relay-ledger-test-${process.pid}.db`);

describe("review-request status for a review started outside this Mullion", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sessionId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const [local] = app.db
      .insert(projects)
      .values({ name: "local", cwd: "/tmp/review-local" })
      .returning()
      .all();
    [{ id: sessionId }] = app.db
      .insert(sessions)
      .values({ projectId: local.id, command: "bash" })
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
    resetRepoRefMemo(app);
    mocks.resolveRepoRefResult.mockResolvedValue({
      ok: true,
      value: { owner: "acme", repo: "widgets" },
    });
    mocks.resolveGitHubToken.mockResolvedValue("ghs_token");
    mocks.resolveMarkerTokens.mockResolvedValue({
      markerToken: "ghs_checks",
      markerReadToken: "ghs_checks",
    });
    mocks.getGitStatus.mockResolvedValue({ branch: "feat/thing" });
    mocks.resolveRepoRoot.mockImplementation(async (dir: string) => dir);
    mocks.listWorktrees.mockResolvedValue([
      { path: "/tmp/review-local", branch: "main", isMain: true },
    ]);
    mocks.findPullRequestByHead.mockResolvedValue({ number: 42 });
    mocks.getPullRequestByNumber.mockImplementation(async (_t, _o, _r, number: number) => ({
      number,
      headSha: `sha${number}`,
    }));
    mocks.assertReviewerConfigured.mockReturnValue("key");
    mocks.listPullRequestReviews.mockResolvedValue([]);
  });

  // The route is rate-limited per client IP; a distinct address per request
  // keeps this file's request volume from tripping it.
  let nextAddr = 1;
  const get = (id: number | string, query = "") =>
    app.inject({
      method: "GET",
      url: `/api/sessions/${id}/review-request${query}`,
      remoteAddress: `10.5.0.${nextAddr++}`,
    });

  describe("GET status", () => {
    it("passes the head and a check-run read token to the status read", async () => {
      mocks.getReviewRunForPr.mockReturnValue(null);
      mocks.getHermesReviewStatus.mockResolvedValue({
        provider: "hermes",
        status: "not_found",
        repo: "acme/widgets",
        prNumber: 42,
      });
      await get(sessionId);
      expect(mocks.getHermesReviewStatus).toHaveBeenCalledWith(expect.anything(), {
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        headSha: "sha42",
        readToken: "ghs_checks",
      });
    });

    // #2634 — a review the repository's own workflow started has no relay
    // record; the service finds it through the head's "Hermes review" check and
    // says which marker it read, so the route can settle an orphan.
    describe("a review started outside this Mullion (#2634)", () => {
      const startedAt = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
      const ledgerStatus = (over: Record<string, unknown> = {}) => ({
        provider: "hermes",
        runId: "run_wf",
        status: "running",
        source: "ledger",
        dispatchedAt: startedAt(5 * 60_000),
        ledger: { checkRunId: 77, open: true },
        ...over,
      });

      beforeEach(() => {
        mocks.getReviewRunForPr.mockReturnValue(null);
        mocks.getHermesReviewStatus.mockResolvedValue(ledgerStatus());
      });

      it("reports the workflow's run and the review it posted, without the marker id", async () => {
        mocks.getHermesReviewStatus.mockResolvedValue(
          ledgerStatus({ status: "completed", dispatchedAt: new Date(1_000_000).toISOString() }),
        );
        mocks.listPullRequestReviews.mockResolvedValue([
          {
            author: "s3ntin3l8-hermes[bot]",
            authorIsBot: true,
            state: "APPROVED",
            commitId: "sha42",
            submittedAt: new Date(1_000_900).toISOString(),
          },
        ]);
        const res = await get(sessionId);
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toMatchObject({
          runId: "run_wf",
          status: "completed",
          source: "ledger",
          github: { checked: true, review: { state: "APPROVED" } },
        });
        // The marker id is the route's business, not the caller's.
        expect(body).not.toHaveProperty("ledger");
      });

      it("has no review to show for a run that is still working", async () => {
        const res = await get(sessionId);
        expect(res.json()).toMatchObject({
          status: "running",
          github: { checked: true, review: null },
        });
        expect(mocks.completeReviewMarkerCheckRun).not.toHaveBeenCalled();
      });

      it("closes the orphaned marker of a run that died, and still reports it stuck", async () => {
        mocks.getHermesReviewStatus.mockResolvedValue(
          ledgerStatus({ status: "failed", stuck: true, stuckReason: "dead_run" }),
        );
        const res = await get(sessionId);
        expect(res.statusCode).toBe(200);
        expect(mocks.completeReviewMarkerCheckRun).toHaveBeenCalledWith(
          "ghs_checks",
          "acme",
          "widgets",
          77,
          "failure",
        );
        expect(res.json()).toMatchObject({ stuck: true, stuckReason: "dead_run" });
      });

      it("closes the orphaned marker of a run that completed with success", async () => {
        mocks.getHermesReviewStatus.mockResolvedValue(ledgerStatus({ status: "completed" }));
        await get(sessionId);
        expect(mocks.completeReviewMarkerCheckRun).toHaveBeenCalledWith(
          "ghs_checks",
          "acme",
          "widgets",
          77,
          "success",
        );
      });

      it("closes a lost run's marker neutral, but only past the sweep's two-hour limit", async () => {
        mocks.getHermesReviewStatus.mockResolvedValue(
          ledgerStatus({ status: "not_found", dispatchedAt: startedAt(90 * 60_000) }),
        );
        await get(sessionId);
        expect(mocks.completeReviewMarkerCheckRun).not.toHaveBeenCalled();
        mocks.getHermesReviewStatus.mockResolvedValue(
          ledgerStatus({ status: "not_found", dispatchedAt: startedAt(3 * 3_600_000) }),
        );
        await get(sessionId);
        expect(mocks.completeReviewMarkerCheckRun).toHaveBeenCalledWith(
          "ghs_checks",
          "acme",
          "widgets",
          77,
          "neutral",
        );
      });

      it("leaves a marker that is already closed alone", async () => {
        mocks.getHermesReviewStatus.mockResolvedValue(
          ledgerStatus({ status: "failed", ledger: { checkRunId: 77, open: false } }),
        );
        await get(sessionId);
        expect(mocks.completeReviewMarkerCheckRun).not.toHaveBeenCalled();
      });

      it("does not try to close a marker with a token that cannot write one", async () => {
        mocks.resolveMarkerTokens.mockResolvedValue({
          markerToken: null,
          markerUnavailable: "not-installed",
          markerReadToken: "pat",
        });
        mocks.getHermesReviewStatus.mockResolvedValue(ledgerStatus({ status: "failed" }));
        const res = await get(sessionId);
        expect(res.statusCode).toBe(200);
        expect(mocks.completeReviewMarkerCheckRun).not.toHaveBeenCalled();
        // The read token is still what looks for the marker.
        expect(mocks.getHermesReviewStatus).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ readToken: "pat" }),
        );
      });

      it("is not a failed read when GitHub refuses to close the marker", async () => {
        // A marker written by a different GitHub App cannot be closed by this one.
        mocks.completeReviewMarkerCheckRun.mockRejectedValue(new Error("HTTP 403"));
        mocks.getHermesReviewStatus.mockResolvedValue(ledgerStatus({ status: "failed" }));
        const res = await get(sessionId);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: "failed", source: "ledger" });
      });

      it("keeps the plain not_found shape when the head has no marker either", async () => {
        mocks.getHermesReviewStatus.mockResolvedValue({
          provider: "hermes",
          status: "not_found",
          repo: "acme/widgets",
          prNumber: 42,
        });
        const res = await get(sessionId);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: "not_found", github: { checked: false } });
        expect(mocks.completeReviewMarkerCheckRun).not.toHaveBeenCalled();
      });
    });
  });
});
