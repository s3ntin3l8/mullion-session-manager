// The GitHub + release routes of the projects API, moved out of
// src/routes/projects.ts (issue #2399, audit finding F2).
//
// This file is a MOVE, not a rewrite: the routes, their schemas, their status
// codes and their error mapping are exactly what they were. It exists because
// src/routes/projects.ts was one 3,987-code-line function holding four
// unrelated surfaces, and the file-size guardrail turns over one ceiling at a
// time.
//
// projectsRoute() calls projectGitHubRoute() at the position this block used
// to occupy, so Fastify's registration ORDER — and the plugin encapsulation
// context the routes are registered in — are unchanged. It is a plain call,
// not an app.register(): a registered plugin is deferred to the end of the
// enclosing plugin, which would reorder the routes.
//
// loadProjectRepoContext lives here because the /api/projects/:id/github*
// routes are its only callers in projects.ts, and project-github-writes.ts
// (the sidebar's own GitHub writes) is its other. Keeping it in projects.ts
// would make projects.ts -> project-github.ts -> projects.ts an import cycle.

import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";
import { getStoredSettings } from "../services/settings.js";
import type { GitHubRepoRef } from "../services/git-remote.js";
import { resolveRepoRefResult } from "../services/host-git.js";
import {
  getToken,
  resolveChecksReadToken,
  resolveGitHubToken,
  describeSidebarWriteIdentity,
  resolveMarkerTokens,
} from "../services/github-integration.js";
import { maybeAutoEnableConventionalTitles } from "../services/project-release-please.js";
import {
  GitHubApiError,
  getRepoStatus,
  getPRsStatus,
  computePRSummary,
  computeCiStatus,
  combineCiStatus,
  fetchRunsForHeadChecked,
  getWorkflowRunJobs,
  getJobLogs,
  getDefaultBranch,
  detectReleasePleaseConfig,
} from "../services/github.js";
import {
  addLabels,
  detectReleaseWorkflow,
  invalidateReleaseWorkflowCache,
  dispatchWorkflow,
  getCachedReleasePullRequestStatus,
  GitHubWriteScopeError,
  invalidateReleaseCache,
  mergePullRequest,
  updatePullRequestBranch,
} from "../services/github-write.js";
import { getPrDetail, invalidatePrDetail } from "../services/github-pr-detail.js";
import {
  BranchPreviewError,
  getOrCreateBranchPreview,
  sendBranchPreviewError,
} from "../services/branch-preview.js";
import { withRelay } from "../services/review-summary.js";
import { derivePrPhase } from "../services/github-pr-phase.js";
import { buildHandoffPrompt } from "../services/pr-handoff.js";
import {
  assertReviewerConfigured,
  getHermesReviewStatus,
  requestHermesReview,
} from "../services/hermes-review.js";
import { getRelayReviewState, overlayRelayRuns } from "../services/relay-review-state.js";
import { annotatePrTasks, issueTriageFor } from "../services/mullion-links.js";
import { replyReviewError, reviewReader } from "./review-relay.js";
import { getIssueDetail, listIssues } from "../services/github-issues.js";
import { resolveTaskMasterConfig } from "../services/task-config.js";
import { resolveReleaseMerge } from "../services/release-merge.js";
import { finishTaskForMergedPr } from "../services/task-reconciler.js";
import type {
  ProjectReleaseStatus,
  ReleaseDetectionResult,
  ReleasePullRequestStatus,
  ReleaseRunResult,
} from "../shared/types.js";

interface ProjectRepoContext {
  project: typeof projects.$inferSelect;
  repoRef: GitHubRepoRef;
  token: string;
}

interface LoadProjectRepoContextOptions {
  /** Folded into the "host unreachable"/"agent rejected" log messages
   * below, e.g. "github status", "jobs", "logs" — mirrors each route's own
   * previous per-site wording. */
  unavailableLabel: string;
  /** How to turn a resolved `repoRef` into a token. Defaults to the
   * `resolveGitHubToken(app, repoRef, "read")` (#489) App-token-with-PAT-
   * fallback path every GitHub route below uses — except `/github/prs`,
   * which has always read the shared PAT directly via `getToken(app)`
   * instead (no `#489 remaining scope` comment ever covered it). That's a
   * pre-existing inconsistency, not something this refactor fixes — it's
   * preserved as-is via this override rather than silently normalized. */
  resolveToken?: (repoRef: GitHubRepoRef) => Promise<string | null>;
  /** When set, a missing token is answered with this 502 message instead of
   * the silent 204 — for actions the user explicitly clicked, where "nothing
   * happened" would be a worse answer than "no token". */
  noTokenMessage?: string;
}

/**
 * The ~28-line preamble every `/api/projects/:id/github*` route below
 * shared verbatim (project lookup, host-aware repo-ref resolution, token
 * resolution), each with its own 400/404/503/204 short-circuits. Sends the
 * appropriate reply and returns `null` the moment any step comes up short;
 * returns the fully-resolved `{ project, repoRef, token }` otherwise.
 *
 * Repo-ref resolution goes through `resolveRepoRefResult` (host-git.ts) —
 * NOT the null-collapsing `resolveRepoRef` used elsewhere — because these
 * routes are the one place that needs to tell "host unreachable" (503)
 * apart from "no github.com remote configured" (204); see host-git.ts's
 * own doc comments on both functions.
 */
export async function loadProjectRepoContext(
  app: FastifyInstance,
  reply: FastifyReply,
  projectId: number,
  options: LoadProjectRepoContextOptions,
): Promise<ProjectRepoContext | null> {
  if (!Number.isInteger(projectId)) {
    reply.badRequest("Invalid project id");
    return null;
  }

  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  if (!project) {
    reply.notFound();
    return null;
  }

  const result = await resolveRepoRefResult(app, project);
  if (!result.ok) {
    // "unsupported" (an old agent build predating the resolveGitHubRepo
    // route — a bare 404) vs. "unreachable" (anything else: a real
    // transport failure, or the agent responding with a non-404 rejection)
    // — both were collapsed into a single unconditional "host unreachable"
    // 503 by every one of these routes before this refactor except
    // `/github/prs` (Hermes review, PR #244), which alone distinguished
    // *any* agent-level rejection (`HostRequestError`, any status) from a
    // real connectivity failure. That's narrower than what `/github/prs`
    // used to do — a non-404 rejection now logs as "unreachable" rather
    // than "agent rejected" — but the debugging value survives: `detail`
    // carries the agent's own `HTTP <status>` message either way (see
    // `HostRequestError`'s constructor, remote-host-client.ts), and every
    // site now gets the 404-vs-everything-else split in its log message,
    // not just `/github/prs`. The 503 response itself is unchanged either
    // way, for every reason.
    const message =
      result.reason === "unsupported"
        ? `agent rejected github-repo request, ${options.unavailableLabel} unavailable`
        : `host unreachable, ${options.unavailableLabel} unavailable`;
    app.log.warn(
      {
        hostId: project.hostId,
        reason: result.reason,
        detail: result.reason === "unreachable" ? result.detail : undefined,
      },
      message,
    );
    reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
    return null;
  }

  const repoRef = result.value;
  if (!repoRef) {
    reply.code(204);
    return null;
  }

  const resolveToken = options.resolveToken ?? ((ref) => resolveGitHubToken(app, ref, "read"));
  const token = await resolveToken(repoRef);
  if (!token) {
    if (options.noTokenMessage) {
      reply.badGateway(options.noTokenMessage);
      return null;
    }
    reply.code(204);
    return null;
  }

  return { project, repoRef, token };
}

/**
 * The GitHub + release routes, moved verbatim out of projectsRoute() in
 * projects.ts (issue #2399).
 *
 * The two locals below were projectsRoute()'s own, and this block was their
 * only consumer: accountToken is the shared-PAT getter every route here
 * hands to loadProjectRepoContext as its token resolver, and NOT_CONNECTED
 * is the 502 message the routes that must fail loudly use when no token is
 * connected.
 */
export async function projectGitHubRoute(app: FastifyInstance): Promise<void> {
  const accountToken = (): Promise<string | null> => Promise.resolve(getToken(app));
  const NOT_CONNECTED = "GitHub is not connected — connect your account in Settings → Integrations";
  // Per-project GitHub status: open issue/PR counts + lists for whatever
  // repo this project's `origin` remote points at (issue #27). Degrades to
  // a bare 204 rather than erroring in every "not applicable" case — no
  // github.com remote, no GitHub account connected, or GitHub itself
  // rejecting the request (private repo without scope, rate limited, ...)
  // — see the plan's "widget just doesn't render" rule. A host that's
  // unreachable is the one case this treats as a real failure (503),
  // consistent with the actions/dock routes above.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/github",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "github status",
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;

      try {
        // The read-scoped App token has no Issues permission; list issues with
        // the dedicated "issues" scope (PAT fallback if it can't be minted).
        // The issue list is what the user sees, so it uses their account when
        // one is connected (#2321); the read token only backs the PR half.
        const issuesToken = getToken(app) ?? token;
        return await getRepoStatus(token, repoRef.owner, repoRef.repo, issuesToken);
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err;
        app.log.warn(
          { owner: repoRef.owner, repo: repoRef.repo, statusCode: err.statusCode },
          "github status unavailable",
        );
        reply.code(204);
        return;
      }
    },
  );

  // Per-PR CI/CD status (issue #102) — reads from the warm cache populated
  // by the server-side background poller (github-pr-poller.ts). Returns 204
  // when the poller hasn't run yet or the repo has no open PRs (same
  // degradation pattern as the /github endpoint above). Rate-limited the
  // same as /github since this is still a per-project GitHub endpoint.
  //
  // Optional `?branch=<name>` (issue #202): filters the cached PR list down
  // to whichever PR (if any) has that branch as its head — a session row
  // wants only its own worktree's PR, not every open PR in the repo. The
  // frontend's sidebar doesn't actually call this per-session (fetching the
  // unfiltered list once per project and matching `headBranch` client-side
  // is cheaper), but the filter is a real, independently useful capability
  // of this route either way.
  app.get<{ Params: { id: string }; Querystring: { branch?: string } }>(
    "/api/projects/:id/github/prs",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { branch: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      // Remote-hosted projects (issue #222, follow-up to #102): repoRef
      // resolution goes via the agent, same as the /github endpoint above.
      // The per-PR cache is still keyed by owner/repo and populated by the
      // primary-side poller — this route only needs the ref to look it up.
      //
      // Token: deliberately `getToken(app)` (the shared PAT), NOT
      // `resolveGitHubToken(app, repoRef, "read")` like every other route
      // here — a pre-existing inconsistency (no `#489 remaining scope`
      // comment ever covered this route), preserved as-is rather than
      // silently normalized by this refactor.
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "github prs status",
        resolveToken: accountToken,
      });
      if (!ctx) return;
      const { repoRef } = ctx;

      const status = getPRsStatus(repoRef.owner, repoRef.repo);
      if (!status || status.prs.length === 0) {
        reply.code(204);
        return;
      }

      const { branch } = request.query;
      const prs =
        branch === undefined ? status.prs : status.prs.filter((pr) => pr.headBranch === branch);
      if (prs.length === 0) {
        reply.code(204);
        return;
      }
      // The review relay's state per PR (issues #1630, #1744) — the panel shows
      // a "review requested" marker on a PR a review was asked for. The poller
      // annotates the cache with the landed check; this only overlays the
      // in-memory run index, so the request never waits on GitHub.
      const annotated = annotatePrTasks(app, projectId, overlayRelayRuns(prs, repoRef));
      return {
        prs: annotated,
        prSummary: computePRSummary(annotated),
        // Served past its TTL while the poller refreshes it.
        ...(status.stale ? { stale: true } : {}),
      };
    },
  );

  // Issues view — filterable open-issue list (labels, assignee, sort, title
  // query, paging), each item annotated with its Task Master task status when
  // one exists. Uses the "issues" token scope (an App token without Issues
  // access only ever sees PRs), falling back like /github does.
  app.get<{
    Params: { id: string };
    Querystring: {
      labels?: string;
      assignee?: string;
      sort?: string;
      q?: string;
      page?: string;
    };
  }>(
    "/api/projects/:id/github/issues",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "issues",
        resolveToken: accountToken,
        noTokenMessage: NOT_CONNECTED,
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;
      const { labels, assignee, sort, q, page } = request.query;
      if (sort !== undefined && sort !== "updated" && sort !== "created" && sort !== "comments") {
        return reply.badRequest("sort must be updated, created or comments");
      }
      const pageNum = page === undefined ? 1 : Number(page);
      if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > 50) {
        return reply.badRequest("page must be an integer between 1 and 50");
      }
      try {
        const result = await listIssues(token, repoRef.owner, repoRef.repo, {
          labels,
          assignee,
          sort,
          q,
          page: pageNum,
        });
        const numbers = result.issues.map((i) => i.number);
        const taskRows =
          numbers.length === 0
            ? []
            : app.db
                .select({ issueNumber: tasks.issueNumber, status: tasks.status })
                .from(tasks)
                .where(and(eq(tasks.projectId, projectId), inArray(tasks.issueNumber, numbers)))
                .all();
        const taskStatus = new Map(taskRows.map((t) => [t.issueNumber, t.status]));
        return {
          ...result,
          issues: result.issues.map((i) => ({
            ...i,
            taskStatus: taskStatus.get(i.number) ?? null,
            triage: issueTriageFor(repoRef.owner, repoRef.repo, i.number),
          })),
          taskMasterEnabled: resolveTaskMasterConfig(app).enabled,
          taskLabel: app.config.MULLION_TASK_LABEL,
        };
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err;
        app.log.warn({ statusCode: err.statusCode, projectId }, "github issues unavailable");
        return reply.code(502).send({ message: "GitHub issues unavailable", statusCode: 502 });
      }
    },
  );

  app.get<{ Params: { id: string; number: string } }>(
    "/api/projects/:id/github/issues/:number",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "issue detail",
        resolveToken: accountToken,
        noTokenMessage: NOT_CONNECTED,
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;
      const number = Number(request.params.number);
      if (!Number.isInteger(number) || number < 1) return reply.badRequest("Invalid issue number");
      try {
        const detail = await getIssueDetail(token, repoRef.owner, repoRef.repo, number);
        const taskRow = app.db
          .select({ status: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, number)))
          .get();
        return {
          ...detail,
          taskStatus: taskRow?.status ?? null,
          triage: issueTriageFor(repoRef.owner, repoRef.repo, number),
          // #2049 — who a comment from the box posts as.
          writeIdentity: await describeSidebarWriteIdentity(app, repoRef),
        };
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err;
        if (err.statusCode === 404) return reply.notFound("Issue not found");
        app.log.warn({ statusCode: err.statusCode, projectId, number }, "github issue unavailable");
        return reply.code(502).send({ message: "GitHub issue unavailable", statusCode: 502 });
      }
    },
  );

  // Queue an issue for Task Master by adding its watch label — the task
  // watcher (or the label webhook) then ingests it. Needs write access and
  // Task Master switched on; otherwise there is nothing that would pick the
  // label up.
  app.post<{ Params: { id: string; number: string } }>(
    "/api/projects/:id/github/issues/:number/queue",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!resolveTaskMasterConfig(app).enabled) {
        return reply.forbidden(
          "Task Master is disabled (deploy-time default or a Settings → Task Master override)",
        );
      }
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "issue queue",
        resolveToken: accountToken,
        noTokenMessage: NOT_CONNECTED,
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;
      const number = Number(request.params.number);
      if (!Number.isInteger(number) || number < 1) return reply.badRequest("Invalid issue number");
      try {
        await addLabels(token, repoRef.owner, repoRef.repo, number, [
          app.config.MULLION_TASK_LABEL,
        ]);
        return { queued: true, label: app.config.MULLION_TASK_LABEL };
      } catch (err) {
        if (err instanceof GitHubWriteScopeError) {
          return reply.code(403).send({ message: err.message, statusCode: 403 });
        }
        if (err instanceof GitHubApiError) {
          app.log.warn({ statusCode: err.statusCode, projectId, number }, "issue queue failed");
          return reply.code(502).send({ message: "Could not label the issue", statusCode: 502 });
        }
        throw err;
      }
    },
  );

  // PR drill-in: one PR's header, reviews, threads, conversation and files
  // (GraphQL, 30s cached), merged with the poller's CI view so the sidebar
  // shows one coherent status.
  const LIVE_RUNS_TTL_MS = 15_000;
  const LIVE_RUNS_FAILED_TTL_MS = 5_000;
  type LiveRunsMemo = {
    expiresAt: number;
    promise: ReturnType<typeof fetchRunsForHeadChecked>;
  };
  const liveRunsMemo = new Map<string, LiveRunsMemo>();
  async function loadPrDetail(
    projectId: number,
    number: number,
    ctx: { repoRef: GitHubRepoRef; token: string },
  ) {
    // The detail selects the head commit's statusCheckRollup: read it with a
    // token that sees non-Actions checks too, when the App has that grant.
    const detailToken = (await resolveChecksReadToken(app, ctx.repoRef)) ?? ctx.token;
    const detail = await getPrDetail(detailToken, ctx.repoRef.owner, ctx.repoRef.repo, number);
    // The poller's entry is keyed by PR number; trust it only if it describes
    // the head the user is looking at — after a push, its CI answer and runs
    // belong to the old commit.
    const entry = getPRsStatus(ctx.repoRef.owner, ctx.repoRef.repo)?.prs.find(
      (p) => p.number === number,
    );
    const cached = entry?.headSha === detail.headSha ? entry : undefined;
    // No usable poller entry (the PR is new, or a push moved the head past the
    // poller's last look): ask GitHub for this head's runs directly — one REST
    // call — instead of dropping them and reporting "Checks unknown".
    let runs = cached?.actionsRuns ?? [];
    let runsAnswered = cached?.ciFetched === true;
    let actionsStatus = cached?.ciStatus ?? null;
    if (!cached) {
      // Memoized briefly per head: the detail itself is cached 30s but this
      // lookup is not, and the poller may not know this head for a while.
      const memoKey = `${ctx.repoRef.owner}/${ctx.repoRef.repo}@${detail.headSha}`;
      let memo = liveRunsMemo.get(memoKey);
      if (!memo || Date.now() >= memo.expiresAt) {
        // The promise is stored before it settles, so concurrent requests for
        // the same head share one GitHub call; a failed answer (rate limit,
        // network) is only remembered for a few seconds.
        const entry: LiveRunsMemo = {
          expiresAt: Date.now() + LIVE_RUNS_TTL_MS,
          promise: fetchRunsForHeadChecked(
            ctx.token,
            ctx.repoRef.owner,
            ctx.repoRef.repo,
            detail.headSha,
          ).then((r) => {
            if (!r.ok) entry.expiresAt = Date.now() + LIVE_RUNS_FAILED_TTL_MS;
            return r;
          }),
        };
        if (liveRunsMemo.size >= 100) liveRunsMemo.delete(liveRunsMemo.keys().next().value!);
        liveRunsMemo.set(memoKey, entry);
        memo = entry;
      }
      const live = await memo.promise;
      runs = live.runs;
      runsAnswered = live.ok;
      actionsStatus = computeCiStatus(live.runs, { approvalPending: true });
    }
    // Checks that are not Actions runs only show up in the head commit's rollup.
    const ciStatus = combineCiStatus(actionsStatus, detail.checksRollup);
    // "Ready" needs a real CI answer: either this PR's head runs were fetched
    // (even if there are none), the rollup spoke, or GitHub's own merge state
    // is CLEAN — the same rule the poller's list pill uses (derivePrPhase).
    // Review and conflict phases don't depend on CI knowledge.
    const ciKnown = runsAnswered || detail.checksRollup !== null;
    const phaseInput = {
      // A partial detail has no review data, so its review phase is unknown.
      reviewStateKnown: detail.partial !== true,
      ciFetched: ciKnown,
      isDraft: detail.isDraft,
      mergeable: detail.mergeable,
      mergeStateStatus: detail.mergeStateStatus,
      reviewDecision: detail.reviewDecision,
      requestedReviewers: detail.requestedReviewers,
      reviewers: detail.reviewers,
      hasCommentedReview: detail.reviewSummary.commented.length > 0,
      unresolvedThreads: detail.reviewSummary.unresolvedThreads,
      ciStatus,
      // GitHub's BEHIND can disagree with ancestry; the compare overrules it.
      behindBy: detail.behindBy,
    };
    const prPhase = derivePrPhase(phaseInput);
    // Fold the relay's state into the review summary so the Reviews row is the
    // one place it shows. Best effort: the relay is decorative next to the
    // reviews themselves, so a failed lookup leaves the summary as it is.
    let reviewSummary = detail.reviewSummary;
    if (detail.partial !== true) {
      try {
        const relay = await getRelayReviewState(app, {
          owner: ctx.repoRef.owner,
          repo: ctx.repoRef.repo,
          prNumber: number,
          token: ctx.token,
        });
        reviewSummary = withRelay(reviewSummary, relay);
      } catch (err) {
        app.log.warn({ err, projectId, number }, "pr detail: relay state unavailable");
      }
    }
    return {
      detail: { ...detail, reviewSummary },
      ciStatus,
      ciKnown,
      actionsRuns: runs,
      prPhase,
      projectId,
    };
  }

  // The review relay's state for one pull request (issue #1630) — was a
  // review requested, is it still in flight, did the bot's review land, and
  // what did it say. This is the operator's view of the same relay the
  // agent-facing `reviews.status` op reports (routes/review-relay.ts), for a
  // PR of a *project* rather than of a session.
  app.get<{ Params: { id: string; number: string } }>(
    "/api/projects/:id/github/prs/:number/review",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "pr review state",
      });
      if (!ctx) return;
      const number = Number(request.params.number);
      if (!Number.isInteger(number) || number < 1) return reply.badRequest("Invalid PR number");
      const { owner, repo } = ctx.repoRef;
      try {
        // `ctx.token` is already the read-scoped token (the context resolves
        // it with the same "read" scope) — resolving it a second time would
        // mint a second installation token for the same call.
        const state = await getRelayReviewState(app, {
          owner,
          repo,
          prNumber: number,
          token: ctx.token,
        });
        // The Hermes run's own status, when a run is known: it tells the
        // operator whether a review that has not landed yet is still on its
        // way or has failed outright. A landed review has nothing left to
        // say, so it is not fetched.
        if (state.runId && state.state !== "landed") {
          try {
            const run = await getHermesReviewStatus(app, { owner, repo, prNumber: number });
            if (typeof run.status === "string") state.status = run.status;
          } catch (err) {
            // The run's status is a nicety — the request/landed state is the
            // answer, and a Hermes hiccup must not fail the whole read.
            app.log.warn(
              { detail: (err as Error).message, projectId, number },
              "pr review state: Hermes status unavailable",
            );
          }
        }
        return state;
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err;
        app.log.warn({ statusCode: err.statusCode, projectId, number }, "github pr unavailable");
        return reply
          .code(502)
          .send({ message: "GitHub pull request unavailable", statusCode: 502 });
      }
    },
  );

  app.get<{ Params: { id: string; number: string } }>(
    "/api/projects/:id/github/prs/:number",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "pr detail",
      });
      if (!ctx) return;
      const number = Number(request.params.number);
      if (!Number.isInteger(number) || number < 1) return reply.badRequest("Invalid PR number");
      try {
        const { detail, ciStatus, ciKnown, actionsRuns, prPhase } = await loadPrDetail(
          projectId,
          number,
          ctx,
        );
        // #2049 — who a sidebar write on this PR would post as, so the composer
        // can say so and offer a verdict only to the human's own account.
        // Per repo, not per PR, so it stays out of the cached detail.
        const writeIdentity = await describeSidebarWriteIdentity(app, ctx.repoRef);
        return { ...detail, ciStatus, ciKnown, actionsRuns, prPhase, writeIdentity };
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err;
        if (err.statusCode === 404) return reply.notFound("Pull request not found");
        app.log.warn({ statusCode: err.statusCode, projectId, number }, "github pr unavailable");
        return reply
          .code(502)
          .send({ message: "GitHub pull request unavailable", statusCode: 502 });
      }
    },
  );

  // Ask the review bot for another pass on this PR's current head.
  app.post<{ Params: { id: string; number: string } }>(
    "/api/projects/:id/github/prs/:number/re-review",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "pr re-review",
      });
      if (!ctx) return;
      const number = Number(request.params.number);
      if (!Number.isInteger(number) || number < 1) return reply.badRequest("Invalid PR number");
      try {
        assertReviewerConfigured(app);
        const { detail } = await loadPrDetail(projectId, number, ctx);
        // The base of the review's range: the commit the previous round
        // covered. Without it the key was always the first round's key, so a
        // second click replayed that run instead of reviewing anything (and
        // once the agent's own round had used the same key, the two bodies
        // differed and Hermes answered a conflict).
        const markerTokens = await resolveMarkerTokens(app, ctx.repoRef, ctx.token);
        const { reviewerBotLogin, ledgerName } = getStoredSettings(app.db).reviewRelay;
        const reader = reviewReader(
          ctx.token,
          ctx.repoRef.owner,
          ctx.repoRef.repo,
          number,
          reviewerBotLogin,
          // The ledger markers are check runs: any token that can read them. No name = ledger off.
          ledgerName === ""
            ? undefined
            : { token: markerTokens.markerReadToken ?? ctx.token, name: ledgerName },
          (detail) =>
            app.log.warn(
              { detail, owner: ctx.repoRef.owner, repo: ctx.repoRef.repo, prNumber: number },
              "review-base: degraded",
            ),
        );
        const run = await requestHermesReview(app, {
          owner: ctx.repoRef.owner,
          repo: ctx.repoRef.repo,
          prNumber: number,
          headSha: detail.headSha,
          resolveBase: reader.base,
          sameContent: reader.sameContent,
          // The in-flight marker is a check run: it needs a GitHub App token
          // with `checks: write` (no user-token fallback, #1790). Reading the
          // remembered session works with any token.
          githubToken: markerTokens.markerReadToken ?? ctx.token,
          markerWriteToken: markerTokens.markerToken ?? undefined,
          markerUnavailable: markerTokens.markerUnavailable,
        });
        return {
          status: "dispatched",
          runId: run.runId,
          replayed: run.replayed,
          ...(run.marker ? { marker: run.marker } : {}),
        };
      } catch (err) {
        if (err instanceof GitHubApiError) {
          return reply
            .code(502)
            .send({ message: "GitHub pull request unavailable", statusCode: 502 });
        }
        return replyReviewError(reply, err);
      }
    },
  );

  // Squash-merge — only when the PR is ready (nothing left to wait for), and
  // pinned to the head SHA the user was looking at so a push in between makes
  // GitHub refuse rather than merge unseen code.
  app.post<{ Params: { id: string; number: string }; Body: { headSha?: string } }>(
    "/api/projects/:id/github/prs/:number/merge",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "pr merge",
        resolveToken: accountToken,
        noTokenMessage: NOT_CONNECTED,
      });
      if (!ctx) return;
      const number = Number(request.params.number);
      if (!Number.isInteger(number) || number < 1) return reply.badRequest("Invalid PR number");
      const expectedSha = request.body?.headSha;
      if (!expectedSha) return reply.badRequest("headSha is required");
      try {
        // Read with the read-scoped token, as the sidebar did.
        const readToken = (await resolveGitHubToken(app, ctx.repoRef, "read")) ?? ctx.token;
        invalidatePrDetail(ctx.repoRef.owner, ctx.repoRef.repo, number);
        const { detail, prPhase } = await loadPrDetail(projectId, number, {
          repoRef: ctx.repoRef,
          token: readToken,
        });
        if (detail.state !== "OPEN") return reply.conflict("This pull request is not open");
        if (detail.headSha !== expectedSha) {
          return reply.conflict("The pull request changed since you loaded it — reload and retry");
        }
        if (detail.mergeable !== "MERGEABLE") {
          return reply.conflict("GitHub has not confirmed this pull request is mergeable yet");
        }
        // `behind` rides on GitHub's collapsed mergeStateStatus, which can say
        // BEHIND for a head that is not (behind_by 0): don't refuse on it. The
        // merge is pinned to headSha and a 422 maps to "GitHub refused", so
        // GitHub arbitrates.
        if (prPhase !== "ready_to_merge" && prPhase !== "behind") {
          return reply.conflict(`Not ready to merge (${prPhase.replace(/_/g, " ")})`);
        }
        const result = await mergePullRequest(
          ctx.token,
          ctx.repoRef.owner,
          ctx.repoRef.repo,
          number,
          { sha: detail.headSha, commitTitle: `${detail.title} (#${number})` },
        );
        invalidatePrDetail(ctx.repoRef.owner, ctx.repoRef.repo, number);
        // The merge already happened: finishing the linked task must never
        // turn it into an error response. Not gated on Task Master being
        // enabled, same as the webhook.
        try {
          await finishTaskForMergedPr(app, ctx.project, number);
        } catch (finishErr) {
          app.log.warn(
            { err: finishErr, projectId, prNumber: number },
            "pr merge: finishing the linked task failed",
          );
        }
        return result;
      } catch (err) {
        if (err instanceof GitHubWriteScopeError) {
          return reply.code(403).send({ message: err.message, statusCode: 403 });
        }
        if (err instanceof GitHubApiError) {
          if (err.statusCode === 405 || err.statusCode === 409 || err.statusCode === 422) {
            return reply.conflict("GitHub refused the merge — the PR is not mergeable right now");
          }
          return reply.code(502).send({ message: "GitHub merge failed", statusCode: 502 });
        }
        throw err;
      }
    },
  );

  // GitHub's "Update branch" (issue #1672): merges the base into a PR that
  // has fallen behind it. Pinned to the head SHA the user was looking at,
  // like the merge above, so a push in between makes GitHub refuse.
  app.post<{ Params: { id: string; number: string }; Body: { headSha?: string } }>(
    "/api/projects/:id/github/prs/:number/update-branch",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "pr update branch",
        resolveToken: accountToken,
        noTokenMessage: NOT_CONNECTED,
      });
      if (!ctx) return;
      const number = Number(request.params.number);
      if (!Number.isInteger(number) || number < 1) return reply.badRequest("Invalid PR number");
      const expectedSha = request.body?.headSha;
      if (!expectedSha) return reply.badRequest("headSha is required");
      try {
        await updatePullRequestBranch(
          ctx.token,
          ctx.repoRef.owner,
          ctx.repoRef.repo,
          number,
          expectedSha,
        );
        invalidatePrDetail(ctx.repoRef.owner, ctx.repoRef.repo, number);
        return { updated: true };
      } catch (err) {
        if (err instanceof GitHubWriteScopeError) {
          return reply.code(403).send({ message: err.message, statusCode: 403 });
        }
        if (err instanceof GitHubApiError) {
          // 422: the head moved, the branch is already up to date, or the
          // merge of the base conflicts — GitHub does not say which.
          if (err.statusCode === 409 || err.statusCode === 422) {
            return reply.conflict(
              "GitHub refused to update the branch — it may have changed, be up to date, or conflict with the base",
            );
          }
          return reply.code(502).send({ message: "GitHub branch update failed", statusCode: 502 });
        }
        throw err;
      }
    },
  );

  // The text a session should be given to work through this PR's open
  // feedback; the sidebar starts (or copies it for) a session on the branch.
  app.get<{ Params: { id: string; number: string } }>(
    "/api/projects/:id/github/prs/:number/handoff",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "pr handoff",
      });
      if (!ctx) return;
      const number = Number(request.params.number);
      if (!Number.isInteger(number) || number < 1) return reply.badRequest("Invalid PR number");
      try {
        const { detail, actionsRuns } = await loadPrDetail(projectId, number, ctx);
        // Actions runs AND the head's other checks (codecov/patch, ...): a
        // non-Actions check is only in the rollup, and leaving it out told the
        // session "nothing is outstanding" on a PR whose merge it blocks.
        const failing = [
          ...new Set([
            ...actionsRuns
              .filter((r) => r.status === "completed" && r.conclusion === "failure")
              .map((r) => r.name),
            ...(detail.otherChecks ?? []).filter((c) => c.state === "failure").map((c) => c.name),
          ]),
        ];
        return { prompt: buildHandoffPrompt(detail, failing), branch: detail.headBranch };
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err;
        if (err.statusCode === 404) return reply.notFound("Pull request not found");
        return reply
          .code(502)
          .send({ message: "GitHub pull request unavailable", statusCode: 502 });
      }
    },
  );

  // Issue #2018 — starts (or reuses) the branch preview of a PR's head branch,
  // resolved the way /handoff above resolves it. A fork's head branch is not
  // on `origin`, so it is refused rather than half-fetched. 404 with previews
  // off (no PREVIEW_BASE_HOST), same as POST /api/previews itself.
  app.post<{ Params: { id: string; number: string } }>(
    "/api/projects/:id/github/prs/:number/preview",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (app.config.PREVIEW_BASE_HOST.trim() === "") return reply.notFound();
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "pr preview",
      });
      if (!ctx) return;
      const number = Number(request.params.number);
      if (!Number.isInteger(number) || number < 1) return reply.badRequest("Invalid PR number");
      let detail;
      try {
        detail = await getPrDetail(ctx.token, ctx.repoRef.owner, ctx.repoRef.repo, number);
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err;
        if (err.statusCode === 404) return reply.notFound("Pull request not found");
        return reply
          .code(502)
          .send({ message: "GitHub pull request unavailable", statusCode: 502 });
      }
      if (detail.isCrossRepository === true) {
        return reply.code(409).send({
          statusCode: 409,
          code: "fork_unsupported",
          message: "Previewing a pull request from a fork is not supported yet",
        });
      }
      try {
        const preview = await getOrCreateBranchPreview(app, projectId, detail.headBranch, {
          fastForward: true,
        });
        reply.code(201);
        return preview;
      } catch (err) {
        if (err instanceof BranchPreviewError) return sendBranchPreviewError(reply, err);
        throw err;
      }
    },
  );

  // Jobs for a specific workflow run (issue #221 Phase 2) — returns the list
  // of jobs from the GitHub Actions API. Rate-limited like the other GitHub
  // endpoints (30/min).
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/projects/:id/github/actions/:runId/jobs",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "jobs",
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;

      const runId = Number(request.params.runId);
      if (!Number.isInteger(runId)) return reply.badRequest("runId must be an integer");

      const jobs = await getWorkflowRunJobs(token, repoRef.owner, repoRef.repo, runId);
      return jobs;
    },
  );

  // REST-style log route (issue #221 Phase 2) — mirrors the /logs endpoint
  // but with path params matching the frontend's expected URL pattern.
  app.get<{
    Params: { id: string; runId: string; jobId: string };
    Querystring: { lines?: string };
  }>(
    "/api/projects/:id/github/actions/:runId/jobs/:jobId/logs",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "logs",
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;

      const runId = Number(request.params.runId);
      const jobId = Number(request.params.jobId);
      const lines = request.query.lines ? Number(request.query.lines) : 50;

      if (!Number.isInteger(runId) || !Number.isInteger(jobId)) {
        return reply.badRequest("runId and jobId must be integers");
      }

      const logText = await getJobLogs(token, repoRef.owner, repoRef.repo, jobId, lines);
      if (logText !== null) {
        return { log: logText, truncated: true, lineCount: lines };
      }

      const jobs = await getWorkflowRunJobs(token, repoRef.owner, repoRef.repo, runId);
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        reply.code(204);
        return;
      }
      return { log: null, job, truncated: false, lineCount: 0 };
    },
  );

  // Job logs for a specific workflow run job (issue #221 Phase 2) — fetches
  // truncated log output from the GitHub Actions API. The frontend controls
  // truncation via ?lines=N (default 50). Rate-limited like the other GitHub
  // endpoints (30/min).
  app.get<{
    Params: { id: string };
    Querystring: { runId: string; jobId: string; lines?: string };
  }>(
    "/api/projects/:id/github/logs",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          required: ["runId", "jobId"],
          additionalProperties: false,
          properties: {
            runId: { type: "string" },
            jobId: { type: "string" },
            lines: { type: "string", pattern: "^\\d+$" },
          },
        },
      },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "logs",
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;

      const runId = Number(request.query.runId);
      const jobId = Number(request.query.jobId);
      const lines = request.query.lines ? Number(request.query.lines) : 50;

      if (!Number.isInteger(runId) || !Number.isInteger(jobId)) {
        return reply.badRequest("runId and jobId must be integers");
      }

      // First try fetching the log directly (REST API is simpler, just raw
      // plaintext). If that returns nothing, fall back to job details.
      const logText = await getJobLogs(token, repoRef.owner, repoRef.repo, jobId, lines);
      if (logText !== null) {
        return { log: logText, truncated: true, lineCount: lines };
      }

      // Fall back to return job details only.
      const jobs = await getWorkflowRunJobs(token, repoRef.owner, repoRef.repo, runId);
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        reply.code(204);
        return;
      }
      return { log: null, job, truncated: false, lineCount: 0 };
    },
  );

  // #744 — release-please detection + the open release PR's status, for the
  // GitHubPanel "Release" section. Uses the same 204-degrades-gracefully
  // preamble as the other GitHub routes above; unlike them, `detection`
  // itself is a discriminated result rather than a 204 (see
  // ReleaseDetectionResult's own doc comment for why "not configured" and
  // "token can't list workflows" must not collapse into the same shape).
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/release",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "release status",
      });
      if (!ctx) return;
      const { project, repoRef, token } = ctx;

      let detection: ReleaseDetectionResult;
      try {
        detection = await detectReleaseWorkflow(token, repoRef.owner, repoRef.repo);
      } catch (err) {
        // detectReleaseWorkflow only ever throws a NON-scope failure now
        // (a scope problem resolves to `no-actions-scope` instead) — a rate
        // limit, a transient 5xx, a network error. Same degrade-to-204
        // posture as GET .../github above for exactly that class of
        // failure, rather than a 500.
        if (!(err instanceof GitHubApiError)) throw err;
        app.log.warn(
          { err, owner: repoRef.owner, repo: repoRef.repo },
          "release workflow detection unavailable",
        );
        reply.code(204);
        return;
      }

      let pr: ReleasePullRequestStatus | null = null;
      if (detection.kind === "found") {
        try {
          // Cached (getCachedReleasePullRequestStatus, github-write.ts) —
          // the frontend refetches this route on every /ws/github frame
          // (pr/issue/ci/push/release, not just release-relevant ones), so
          // an uncached assembly here would spend 3 live calls per frame
          // against the process-wide rate-limit budget the PR poller and
          // every Task Master write also share.
          pr = await getCachedReleasePullRequestStatus(token, repoRef.owner, repoRef.repo);
        } catch (err) {
          if (!(err instanceof GitHubApiError)) throw err;
          app.log.warn(
            { err, owner: repoRef.owner, repo: repoRef.repo },
            "release PR status unavailable",
          );
        }
      }

      // Short-circuits to `false` with zero extra API calls once the flag is
      // already on — the common case for any project this feature has
      // touched at all (auto-enabled at create, by the reconciler sweep, or
      // by a human) — so this costs a GitHub round trip only for the
      // projects that could actually still need the warning.
      // detectReleasePleaseConfig never throws (returns `null` for
      // "couldn't tell" — see its own doc comment), so no try/catch needed
      // here; `null` and `false` both collapse to "no warning."
      const conventionalTitlesWarning =
        project.conventionalCommitTitles !== true &&
        (await detectReleasePleaseConfig(token, repoRef.owner, repoRef.repo)) === true;

      const result: ProjectReleaseStatus = { detection, pr, conventionalTitlesWarning };
      return result;
    },
  );

  // #744 — dispatches the repo's release-please workflow (the "Run" button).
  // A domain refusal (no workflow, no workflow_dispatch trigger, or the
  // dispatch call itself failing) is a normal 200 with `{dispatched: false,
  // reason}`, same "refusal is 200, only a real HTTP error throws" contract
  // as POST .../git-pull — see frontend/src/api/git.ts's doc comment on
  // that convention. Needs a `"dispatch"`-scoped token (`actions: write`),
  // which the read-scoped token from loadProjectRepoContext's default does
  // NOT carry — resolved separately below.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/release/run",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "release run",
        resolveToken: accountToken,
        noTokenMessage: NOT_CONNECTED,
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;

      // Detection lives in the same try as the dispatch itself now — a
      // transient detectReleaseWorkflow failure (a rate limit, a 5xx) is a
      // "couldn't start a release run" outcome exactly like a dispatch
      // failure is, not a 500. Only "found"/"not-configured" (i.e. the
      // call actually succeeded) get a meaningful reason distinct from
      // dispatch-failed; see the loop-relative comment below.
      try {
        const detection = await detectReleaseWorkflow(token, repoRef.owner, repoRef.repo);
        if (detection.kind !== "found") {
          const result: ReleaseRunResult = { dispatched: false, reason: "no-workflow" };
          return result;
        }

        const defaultBranch = await getDefaultBranch(token, repoRef.owner, repoRef.repo);
        await dispatchWorkflow(
          token,
          repoRef.owner,
          repoRef.repo,
          detection.workflow.id,
          defaultBranch,
        );
        // Best-effort freshness: a dispatched run typically takes a while
        // to open its PR, so this rarely has anything new to show yet, but
        // it costs nothing and covers the fast case.
        invalidateReleaseCache(repoRef.owner, repoRef.repo);
        const result: ReleaseRunResult = { dispatched: true };
        return result;
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err;
        const detail = err.message;
        // GitHub 422s a workflow with no workflow_dispatch trigger — worth
        // its own reason so the UI can say "add workflow_dispatch: to your
        // release workflow" rather than a generic failure.
        const reason = err.statusCode === 422 ? "no-dispatch-trigger" : "dispatch-failed";
        if (reason === "no-dispatch-trigger") {
          invalidateReleaseWorkflowCache(repoRef.owner, repoRef.repo);
        }
        app.log.warn(
          { err, owner: repoRef.owner, repo: repoRef.repo },
          "release-please run failed",
        );
        const result: ReleaseRunResult = { dispatched: false, reason, detail };
        return result;
      }
    },
  );

  // #744 — merges the open release-please PR (the "Merge" button). The
  // decision logic (gated hard on GitHub's own mergeability verdict, never a
  // force/override path; why "behind"/"dirty" refuse rather than
  // update-branch/auto-rebase like the task-PR merge-on-approve sweep does)
  // lives in resolveReleaseMerge (services/release-merge.ts) — see that
  // file's own doc comment. This route is a thin HTTP wrapper around it.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/release/merge",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      // Deliberately the default "read"-scoped token (loadProjectRepoContext
      // falls back to resolveGitHubToken(..., "read") when no override is
      // given) — every call below except the merge itself is a read, and
      // WRITE_PERMISSIONS (github-app.ts) doesn't grant `metadata`, which
      // GET /repos/{o}/{r} (getDefaultBranch) needs. A separate write-scoped
      // token is resolved right before the one call that needs it.
      const ctx = await loadProjectRepoContext(app, reply, projectId, {
        unavailableLabel: "release merge",
      });
      if (!ctx) return;
      const { repoRef, token } = ctx;

      // The decision itself — including the write-token mint, the draft
      // check, every MergeReadiness branch, and clearing any outstanding
      // per-task autorelease intent on this project once merged — lives in
      // resolveReleaseMerge (services/release-merge.ts), shared with
      // task-reconciler.ts's processReleaseRequests sweep (#744's automatic
      // half). This route's own contribution is just resolving repoRef/token
      // and returning the result as-is.
      const result = await resolveReleaseMerge(app, repoRef, token, projectId);
      return result;
    },
  );

  // Issue #1034 — manual re-check of the release-please auto-enable sweep
  // for one project, bypassing the one-shot `conventionalCommitTitlesResolvedAt`
  // gate. The auto-enable sweep is intentionally one-shot (a project costs at
  // most one real detection attempt — see project-release-please.ts), so a
  // repo that adopts release-please AFTER its first detection never gets
  // re-probed by the reconciler tick. The standing warning in the GitHub
  // panel still surfaces the gap, but a human asking "did this repo just add
  // release-please?" had no way to force a fresh probe — this route is that
  // affordance. Pairs with the "Re-check now" button in the project edit
  // modal (CreateProjectModal.tsx). On a positive detection the re-check's
  // write intentionally overwrites a human's mid-flight PATCH; the
  // narrower negative/no-remote case still preserves the human's value
  // (commitResolution touches only the stamp then).
  //
  // Same rate-limit bucket as the two release POSTs above (10/min) — every
  // call here costs at least one GitHub contents-API round trip, and the
  // button is a deliberate human click rather than a polled UI affordance.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/release-please/recheck",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [existing] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!existing) return reply.notFound();

      const updated = await maybeAutoEnableConventionalTitles(app, existing, {
        ignoreStamp: true,
      });
      // The fresh stamp is what the client needs to refetch the project —
      // any definite outcome (positive detection, negative detection,
      // durable-no-remote) stamps it, so a non-null value here is exactly
      // "we reached a definite conclusion this round." Returns ISO 8601
      // rather than a numeric epoch ms so the JS Date round-trip is
      // unambiguous in the frontend.
      return {
        ok: true,
        conventionalCommitTitlesResolvedAt:
          updated.conventionalCommitTitlesResolvedAt?.toISOString() ?? null,
      };
    },
  );
}
