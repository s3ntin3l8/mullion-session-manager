import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, inArray, or } from "drizzle-orm";
import { projects, sessions, tasks } from "../db/schema.js";
import { ACTIVE_TASK_STATUSES } from "../services/task-state.js";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import type { RelayReviewState } from "../shared/types.js";
import { getGitStatus } from "../services/git-status.js";
import { resolveRepoRefResult } from "../services/host-git.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { resolveGitHubToken } from "../services/github-integration.js";
import { getStoredSettings } from "../services/settings.js";
import {
  completeReviewMarkerCheckRun,
  findPullRequestByHead,
  getIssueState,
  getPullRequestByNumber,
  listIssueComments,
  listPullRequestReviews,
} from "../services/github-write.js";
import { GitHubApiError } from "../services/github-fetch.js";
import {
  TRIAGE_COMMENT_MARKER,
  HermesAuthError,
  HermesNotConfiguredError,
  HermesUnavailableError,
  ReviewAlreadyLandedError,
  ReviewConflictError,
  ReviewCooldownError,
  ReviewInFlightError,
  ReviewSessionRefusedError,
  ReviewRunForbiddenError,
  ReviewRunNotFoundError,
  assertReviewerConfigured,
  getHermesReviewStatus,
  getReviewRunForPr,
  getRelayStatus,
  getRunForTarget,
  requestHermesReview,
  requestRelay,
  stopHermesReview,
} from "../services/hermes-review.js";

// An agent's `request_review` / `review_status` / `stop_review` (MCP) and
// `mullion review [status|stop]` (CLI) land here via the control socket's
// `reviews.*` ops (plugins/control-socket.ts), which pin a session-scope
// caller to its OWN session id. The repo defaults to the one the session's
// project is in. A caller working in ANOTHER repo (a session in one project
// that also edits a sibling repo) names it with `repo`; that is honoured only
// when it is a repo registered as a Mullion project on this instance
// (selectRelayRepo below), so the request body can widen the target to repos
// the operator set up, never to an arbitrary one. A session can only stop
// runs it dispatched itself. The Hermes URL/key never leave the server
// (services/hermes-integration.ts).
//
// The same relay also serves issue triage (issue #1629): `triage.request` /
// `triage_status` (MCP) and `mullion triage` (CLI) reach the routes below.
// A triage's target is an issue *number* — there is no "current issue" to
// infer, so the number always comes from the caller — and the same repo
// scoping rules apply.

interface ReviewRequestBody {
  prNumber?: number;
  repo?: string;
  branch?: string;
}

interface TriageRequestBody {
  issueNumber: number;
  repo?: string;
}

// `owner/name`, as GitHub spells them.
const repoProperty = {
  type: "string",
  pattern: "^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$",
  maxLength: 200,
} as const;
const branchProperty = { type: "string", minLength: 1, maxLength: 250 } as const;

const triageRequestSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["issueNumber"],
    properties: { issueNumber: { type: "integer", minimum: 1 }, repo: repoProperty },
  },
};

const triageStatusSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    required: ["issueNumber"],
    properties: { issueNumber: { type: "integer", minimum: 1 }, repo: repoProperty },
  },
};

const reviewRequestSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      prNumber: { type: "integer", minimum: 1 },
      repo: repoProperty,
      branch: branchProperty,
    },
  },
};

const reviewStatusSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      prNumber: { type: "integer", minimum: 1 },
      repo: repoProperty,
      branch: branchProperty,
    },
  },
};

const reviewStopSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: { runId: { type: "string", minLength: 1, maxLength: 200 } },
  },
};

interface ReviewTarget {
  owner: string;
  repo: string;
  /** The PR is in a repo other than the session's project's. */
  foreign: boolean;
  prNumber: number;
  headSha: string;
  token: string;
  /**
   * The token for the in-flight marker (a check run). It needs
   * `checks: write`, which the read token does not have — absent when no
   * such token could be resolved, in which case the relay simply keeps no
   * marker.
   */
  markerToken?: string | null;
}

interface TriageTarget {
  owner: string;
  repo: string;
  issueNumber: number;
  token: string;
  /** Whether the issue is open or closed — a triage of a closed issue still
   * goes out, but the caller is told (issue #1629). */
  issueState: "open" | "closed";
}

// Maps the service's errors to HTTP. Anything unexpected is rethrown (500).
export function replyReviewError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HermesNotConfiguredError) return reply.preconditionFailed(err.message);
  if (err instanceof ReviewCooldownError) {
    reply.header("Retry-After", String(err.retryAfterSeconds));
    return reply.conflict(err.message);
  }
  if (err instanceof ReviewConflictError) return reply.conflict(err.message);
  // The commit has already been reviewed: there is nothing new to review.
  if (err instanceof ReviewAlreadyLandedError) return reply.conflict(err.message);
  // A review of this PR is already running: the answer is the run id, not a
  // second review queued behind it.
  if (err instanceof ReviewInFlightError) {
    reply.header("Retry-After", "60");
    return reply.conflict(err.message);
  }
  if (err instanceof ReviewRunNotFoundError) return reply.notFound(err.message);
  if (err instanceof ReviewRunForbiddenError) return reply.forbidden(err.message);
  // The pull request's review session is stuck: Hermes refuses every turn
  // into it. The relay retries in a fresh session — this is the case where
  // that did not get through either.
  if (err instanceof ReviewSessionRefusedError) return reply.serviceUnavailable(err.message);
  if (err instanceof HermesAuthError) return reply.badGateway(err.message);
  if (err instanceof HermesUnavailableError) {
    if (err.retryAfterSeconds !== undefined) {
      reply.header("Retry-After", String(err.retryAfterSeconds));
    }
    return reply.serviceUnavailable(err.message);
  }
  throw err;
}

/**
 * The branch a session is working on, resolved on the host that owns it
 * (issue #1628).
 *
 * A local session's branch comes from the live PTY first (the hook adapter
 * reports it, so it survives a commit the agent made between polls) and from
 * `git status` as the fallback. A remote-hosted session has **no local PTY** —
 * the PTY lives on the agent host — so its branch is resolved through
 * `RemoteHostClient.resolveGitStatus`, the same call the project list makes
 * for a remote **session**'s cwd (routes/projects.ts).
 *
 * `resolveGitStatus`, not `resolveGitBranch`: the latter is a bare
 * `<cwd>/.git/HEAD` read that deliberately does not follow a worktree's
 * `.git` *file* redirect (a session's cwd is often a worktree), and it
 * reports a detached HEAD as a short SHA rather than the `"(detached)"`
 * sentinel the caller checks for. `git status` — which is what
 * `resolveGitStatus` runs on the agent — follows worktree redirects and
 * normalizes a detached HEAD the same way the local path does, so the two
 * hosts behave the same.
 *
 * A host that is unreachable degrades to "no branch" (null), which the caller
 * turns into the same 404 an undeterminable local branch produces.
 */
async function resolveSessionBranch(
  app: FastifyInstance,
  project: { id: number; cwd: string; hostId: string },
  session: { id: number; cwd: string | null },
): Promise<string | null> {
  const cwd = session.cwd ?? project.cwd;
  if (project.hostId !== LOCAL_HOST_ID) {
    try {
      const client = getRemoteHostClient(app, project.hostId);
      const result = await client.resolveGitStatus(cwd);
      // Not a repo (or a repo whose status could not be read) — no branch.
      if (!result.isRepo) return null;
      return result.status?.branch ?? null;
    } catch (err) {
      // getRemoteHostClient() throws SYNCHRONOUSLY for a missing host row or a
      // null baseUrl, so it needs its own catch, not just the await's. A
      // worktree cwd outside the agent's own PROJECTS_ROOTS surfaces here as
      // a 4xx HostRequestError — same "no branch" outcome.
      app.log.warn(
        { hostId: project.hostId, projectId: project.id, err },
        "review-request: could not resolve the session branch on its host",
      );
      return null;
    }
  }
  return app.pty.get(String(session.id))?.liveBranch ?? (await getGitStatus(cwd))?.branch ?? null;
}

/**
 * Whether a branch name is really a detached HEAD.
 *
 * `git status` reports a detached checkout as its short commit SHA (7 hex
 * characters — git-status.ts's own `oid.slice(0, 7)`), not as the
 * `"(detached)"` sentinel the porcelain output starts with: git-status.ts
 * rewrites the sentinel to that short SHA before returning it. So the
 * sentinel never reaches this route, on either host, and a short SHA is the
 * signal that actually arrives.
 *
 * A branch genuinely named like a 7-character hex string is misread as
 * detached — vanishingly rare, and the 404 tells the caller to pass
 * `prNumber`, which works either way.
 */
function isDetachedBranch(branch: string): boolean {
  return /^[0-9a-f]{7}$/i.test(branch);
}

// The other projects' repo refs, for "is this repo registered". Each lookup is a
// git-config read (local) or a remote-host RPC, and the relay routes are
// rate-limited per client, not per project, so without this a request naming a
// repo costs N-1 lookups every time. A project's remote changes rarely, so a
// short TTL bounds the staleness; the key carries cwd and host so editing a
// project invalidates its entry, and only a lookup that ANSWERED is kept — an
// unreachable host must stay a 503 on the next request, not a cached miss.
const REPO_REF_TTL_MS = 60_000;
type RepoRefResult = Awaited<ReturnType<typeof resolveRepoRefResult>>;
// Keyed by the database handle, not the FastifyInstance: a route plugin runs on
// an encapsulated child instance, but `db` is the one object every instance of
// one app shares.
const repoRefMemos = new WeakMap<
  object,
  Map<number, { key: string; at: number; result: RepoRefResult }>
>();

/** Forgets the memoized repo refs (tests change what a project resolves to). */
export function resetRepoRefMemo(app: FastifyInstance): void {
  repoRefMemos.delete(app.db);
}

async function resolveOtherProjectRef(
  app: FastifyInstance,
  project: typeof projects.$inferSelect,
): Promise<RepoRefResult> {
  let memo = repoRefMemos.get(app.db);
  if (!memo) repoRefMemos.set(app.db, (memo = new Map()));
  const key = `${project.hostId}\0${project.cwd}`;
  const hit = memo.get(project.id);
  if (hit && hit.key === key && Date.now() - hit.at < REPO_REF_TTL_MS) return hit.result;
  const result = await resolveRepoRefResult(app, project);
  if (result.ok) memo.set(project.id, { key, at: Date.now(), result });
  else memo.delete(project.id);
  return result;
}

interface RelayRepo {
  owner: string;
  repo: string;
  /** True when the caller named a repo other than the session's project's. */
  foreign: boolean;
}

/**
 * Which repo a relay request is about. Sends the error reply itself and
 * returns null when it can't be resolved.
 *
 * Without `requested` it is the repo of the session's project, exactly as
 * before. With it, the caller says the work is in a repo other than that
 * (a session in one project that also edits a sibling repo): honoured only
 * when it is the project's own repo or another repo registered as a Mullion
 * project here — a 403 otherwise, so the body can widen the target to repos
 * the operator set up, never to an arbitrary one.
 *
 * The project's own repo is read from the project's cwd, not the session's:
 * parseGitRemote reads `<cwd>/.git/config` directly, which doesn't exist for
 * a worktree (where `.git` is a file). resolveRepoRefResult already proxies
 * to the agent for a remote-hosted project (services/host-git.ts), so the
 * ref is host-agnostic (issue #1628). It is the Result variant because the
 * collapsing one answers "no GitHub remote" for a remote host that is DOWN or
 * too old for this route, a wrong (and unlogged) cause: unreachable answers
 * 503, version skew 412.
 */
async function selectRelayRepo(
  app: FastifyInstance,
  reply: FastifyReply,
  project: typeof projects.$inferSelect,
  requested: string | undefined,
  logLabel: "review-request" | "triage-request",
): Promise<RelayRepo | null> {
  const repoResult = await resolveRepoRefResult(app, project);
  if (!repoResult.ok) {
    // Logged like routes/projects.ts does — an unreachable host and an agent
    // build that predates the route are two different problems, and the
    // difference must not be visible only in the answer.
    app.log.warn(
      {
        hostId: project.hostId,
        projectId: project.id,
        reason: repoResult.reason,
        detail: repoResult.reason === "unreachable" ? repoResult.detail : undefined,
      },
      `${logLabel}: could not resolve the project host's GitHub remote`,
    );
    if (repoResult.reason === "unreachable") {
      reply.serviceUnavailable("The project host is unreachable — try again shortly");
      return null;
    }
    // "unsupported": the agent build predates the repo-ref route.
    reply.preconditionFailed("This project's host cannot resolve its GitHub remote");
    return null;
  }
  const own = repoResult.value;
  if (requested === undefined) {
    if (!own) {
      reply.preconditionFailed("This project has no GitHub remote");
      return null;
    }
    return { owner: own.owner, repo: own.repo, foreign: false };
  }

  // GitHub treats owner/name case-insensitively.
  const wanted = requested.toLowerCase();
  const matches = (ref: { owner: string; repo: string }) =>
    `${ref.owner}/${ref.repo}`.toLowerCase() === wanted;
  if (own && matches(own)) return { owner: own.owner, repo: own.repo, foreign: false };

  const others = app.db
    .select()
    .from(projects)
    .all()
    .filter((p) => p.id !== project.id);
  const results = await Promise.all(others.map((p) => resolveOtherProjectRef(app, p)));
  const registered = results
    .map((result) => (result.ok ? result.value : null))
    .find((ref) => ref && matches(ref));
  if (!registered) {
    // A registered project whose host is DOWN might be the very repo asked
    // for, so "not registered" would be a wrong answer — and the CLI treats a
    // 403 for a repo it merely inferred as "a fork checkout" and retries
    // against the session's own project, which would review the wrong
    // repository's PR. Say so instead (a 503 is never retried that way). A
    // host that is merely too old ("unsupported") can't be told apart from
    // not registered and stays a 403.
    if (results.some((result) => !result.ok && result.reason === "unreachable")) {
      reply.serviceUnavailable(
        `Could not check whether ${requested} is registered: a registered project's host is unreachable — try again shortly`,
      );
      return null;
    }
    reply.forbidden(
      `${requested} is not a repository registered as a Mullion project — a session can only ask about its own project's repository or another registered one`,
    );
    return null;
  }
  return { owner: registered.owner, repo: registered.repo, foreign: true };
}

/**
 * Session → repo + PR (+ head SHA and a read token). Sends the error reply
 * itself and returns null when the target can't be resolved.
 */
async function resolveReviewTarget(
  app: FastifyInstance,
  reply: FastifyReply,
  sessionId: number,
  requested: { prNumber?: number; repo?: string; branch?: string },
  { taskMasterGuard = false }: { taskMasterGuard?: boolean } = {},
): Promise<ReviewTarget | null> {
  const requestedPr = requested.prNumber;
  const [session] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  if (!session) {
    reply.notFound("Session not found");
    return null;
  }
  const [project] = app.db.select().from(projects).where(eq(projects.id, session.projectId)).all();
  if (!project) {
    reply.notFound("Project not found");
    return null;
  }

  const target = await selectRelayRepo(app, reply, project, requested.repo, "review-request");
  if (!target) return null;
  const { owner, repo, foreign } = target;
  // A PR number in ANOTHER repo is not the task's PR, so the guard needs the
  // resolved repo; it still runs before any token or GitHub lookup, so the
  // refusal stays the answer a task session gets.
  if (taskMasterGuard && !foreign && isTaskMasterReviewRequest(app, sessionId, requestedPr)) {
    reply.conflict(TASK_MASTER_REFUSAL);
    return null;
  }
  // The session's own branch says nothing about a PR in another repo: the
  // caller has to name the PR (or the branch it is on there).
  if (foreign && requestedPr === undefined && requested.branch === undefined) {
    reply.badRequest(`${owner}/${repo} is not this session's project — pass prNumber or branch`);
    return null;
  }

  const token = await resolveGitHubToken(app, { owner, repo }, "read");
  if (!token) {
    reply.preconditionFailed("No GitHub credentials are configured");
    return null;
  }

  let prNumber = requestedPr;
  try {
    if (prNumber === undefined) {
      // A branch the caller reports (the CLI reads it from its own cwd, which
      // is where the agent actually is) beats the session's launch cwd.
      const branch = requested.branch ?? (await resolveSessionBranch(app, project, session));
      if (!branch || branch === "(detached)" || isDetachedBranch(branch)) {
        reply.notFound("Could not determine this session's branch — pass prNumber");
        return null;
      }
      const pr = await findPullRequestByHead(token, owner, repo, `${owner}:${branch}`);
      if (!pr) {
        reply.notFound(`No open PR found for branch ${branch}`);
        return null;
      }
      prNumber = pr.number;
    }
    // Always read the PR itself: it confirms the number exists and carries the
    // head SHA the review's idempotency key is built from.
    const pr = await getPullRequestByNumber(token, owner, repo, prNumber);
    return {
      owner,
      repo,
      foreign,
      prNumber,
      headSha: pr.headSha,
      token,
      // The in-flight marker is a check run, and writing one needs
      // `checks: write` — a scope the read token does not have. The App
      // install usually has not been approved for it either, so this falls
      // back to the PAT/OAuth token (a `repo`-scoped user token covers check
      // runs). Without it the marker write 403s and the cross-entry-point
      // session sharing never happens.
      markerToken: await resolveGitHubToken(app, { owner, repo }, "checks"),
    };
  } catch (err) {
    // Only a genuine 404 means "no such PR". An expired token, a rate
    // limit or an unreachable GitHub (statusCode 0) must not tell the
    // agent the PR doesn't exist — that sends it retrying the wrong way.
    if (!(err instanceof GitHubApiError)) throw err;
    if (err.statusCode === 404) {
      reply.notFound(
        requestedPr !== undefined
          ? `PR #${requestedPr} was not found in ${owner}/${repo}`
          : `${owner}/${repo} was not found or is not accessible`,
      );
      return null;
    }
    app.log.warn(
      { status: err.statusCode, detail: err.message },
      "review-request: GitHub lookup failed",
    );
    reply.badGateway(
      err.statusCode === 0
        ? "GitHub is unreachable — try again shortly"
        : `GitHub rejected the PR lookup (HTTP ${err.statusCode})`,
    );
    return null;
  }
}

// Cheapest gate first, so an unconfigured install isn't told about remotes or
// GitHub credentials it can't use anyway.
function gateReviewer(app: FastifyInstance, reply: FastifyReply): boolean {
  try {
    assertReviewerConfigured(app);
    return true;
  } catch (err) {
    replyReviewError(reply, err);
    return false;
  }
}

const TASK_MASTER_REFUSAL =
  "This session works an active Task Master task, and Task Master runs that task's review — do not request one";

/**
 * Whether this session belongs to an ACTIVE Task Master task whose own pull
 * request is the one being asked about. Task Master pushes the branch, opens
 * the pull request and runs the task's review, so such a session has no
 * review of its own to ask for — a Hermes round dispatched for it would be a
 * second review the board never reads.
 *
 * Scoped, because nothing clears `tasks.sessionId` when a task finishes: a
 * finished (`done`/`failed`) task no longer owns its session, and a request
 * naming a DIFFERENT pull request is not about the task's review at all. With
 * no explicit pull request the target is the session's own branch, i.e. the
 * task's.
 */
function isTaskMasterReviewRequest(
  app: FastifyInstance,
  sessionId: number,
  requestedPr: number | undefined,
): boolean {
  const rows = app.db
    .select({ prNumber: tasks.prNumber })
    .from(tasks)
    .where(
      and(
        or(eq(tasks.sessionId, sessionId), eq(tasks.reviewSessionId, sessionId)),
        inArray(tasks.status, [...ACTIVE_TASK_STATUSES]),
      ),
    )
    .all();
  return rows.some((row) => requestedPr === undefined || row.prNumber === requestedPr);
}

/**
 * Session → repo + issue number (+ a read token), for the triage relay
 * (issue #1629). The repo is chosen exactly as the review path does
 * (selectRelayRepo): the session's project's, or another registered project's
 * when the caller names it. The issue *number* always
 * comes from the caller: there is no "current issue" to infer from a
 * session's branch.
 */
async function resolveTriageTarget(
  app: FastifyInstance,
  reply: FastifyReply,
  sessionId: number,
  issueNumber: number,
  requestedRepo: string | undefined,
): Promise<TriageTarget | null> {
  const [session] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  if (!session) {
    reply.notFound("Session not found");
    return null;
  }
  const [project] = app.db.select().from(projects).where(eq(projects.id, session.projectId)).all();
  if (!project) {
    reply.notFound("Project not found");
    return null;
  }

  // The same host-aware, scoped resolution the review path uses.
  const target = await selectRelayRepo(app, reply, project, requestedRepo, "triage-request");
  if (!target) return null;
  const { owner, repo } = target;

  const token = await resolveGitHubToken(app, { owner, repo }, "read");
  if (!token) {
    reply.preconditionFailed("No GitHub credentials are configured");
    return null;
  }

  // Confirm the issue exists before dispatching: a triage of a number that
  // is not an issue would send Hermes off to triage nothing. A pull request
  // shares the numbering namespace and GitHub answers `/issues/{n}` for a
  // PR too, so the `pull_request` key is what tells the two apart (the same
  // check github-issues.ts's own detail fetch makes).
  let issueState: "open" | "closed";
  try {
    const issue = await getIssueState(token, owner, repo, issueNumber);
    if (issue.isPullRequest) {
      reply.notFound(`#${issueNumber} is a pull request, not an issue`);
      return null;
    }
    issueState = issue.state;
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    if (err.statusCode === 404) {
      reply.notFound(`Issue #${issueNumber} was not found in ${owner}/${repo}`);
      return null;
    }
    app.log.warn(
      { status: err.statusCode, detail: err.message },
      "triage-request: GitHub lookup failed",
    );
    reply.badGateway(
      err.statusCode === 0
        ? "GitHub is unreachable — try again shortly"
        : `GitHub rejected the issue lookup (HTTP ${err.statusCode})`,
    );
    return null;
  }

  return { owner, repo, issueNumber, token, issueState };
}

export async function reviewRequestRoute(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: ReviewRequestBody }>(
    "/api/sessions/:id/review-request",
    { schema: reviewRequestSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");
      if (!gateReviewer(app, reply)) return reply;
      // A refusal like the in-flight one: the answer, not an error to retry.
      // Without a named repo it runs first, before any lookup; with one,
      // resolveReviewTarget runs it once the repo is known.
      if (
        request.body.repo === undefined &&
        isTaskMasterReviewRequest(app, sessionId, request.body.prNumber)
      ) {
        return reply.conflict(TASK_MASTER_REFUSAL);
      }

      const target = await resolveReviewTarget(app, reply, sessionId, request.body, {
        taskMasterGuard: request.body.repo !== undefined,
      });
      if (!target) return reply;
      const { owner, repo, prNumber, headSha } = target;

      try {
        const reader = reviewReader(
          target.token,
          owner,
          repo,
          prNumber,
          getStoredSettings(app.db).reviewRelay.reviewerBotLogin,
        );
        const run = await requestHermesReview(app, {
          owner,
          repo,
          prNumber,
          headSha,
          resolveBase: reader.base,
          sessionId,
          // The token lets the relay read and write the in-flight marker: the
          // session the previous round ran in, and one for this round. It
          // needs `checks: write` — the read token does not have it.
          githubToken: target.markerToken ?? undefined,
        });
        // The PR's reviews are read once per request: the delta base and the
        // duplicate-review warning need the same list, and it is a walk of up
        // to ten pages.
        return {
          status: "dispatched",
          repo: `${owner}/${repo}`,
          prNumber,
          runId: run.runId,
          runStatus: run.status,
          replayed: run.replayed,
          // A bot review for this commit may already exist — the repository
          // reviews new PRs on its own, so this fires routinely and is NOT an
          // error (issue #1705). Warn, never refuse.
          //
          // Computed AFTER the dispatch, not before: a request the cooldown
          // refuses would otherwise pay a full `/pulls/{n}/reviews` walk (up
          // to 10 pages) for a warning it never returns. The wording makes no
          // promise about a second review — on a replay no new run is
          // dispatched, so there is no second review to promise.
          ...(await existingBotReviewWarning(target, reader)),
        };
      } catch (err) {
        return replyReviewError(reply, err);
      }
    },
  );

  // Status of the latest review run for the session's PR, plus whether the
  // review bot's verdict actually landed on GitHub — Hermes can report
  // "completed" for a run that posted nothing (e.g. it had no App credentials).
  app.get<{
    Params: { id: string };
    Querystring: { prNumber?: number; repo?: string; branch?: string };
  }>(
    "/api/sessions/:id/review-request",
    { schema: reviewStatusSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");
      if (!gateReviewer(app, reply)) return reply;

      const target = await resolveReviewTarget(app, reply, sessionId, request.query);
      if (!target) return reply;
      const { owner, repo, prNumber, token } = target;

      try {
        const status = await getHermesReviewStatus(app, { owner, repo, prNumber });
        const record = getReviewRunForPr(owner, repo, prNumber);
        // Close the in-flight marker once the run it names has finished, so a
        // later request does not mistake a finished review for a live one.
        // The shared workflow closes its own marker the same way.
        if (record?.markerCheckRunId) {
          const conclusion =
            status.status === "completed"
              ? "success"
              : status.status === "failed" ||
                  status.status === "cancelled" ||
                  status.status === "interrupted"
                ? "failure"
                : null;
          if (conclusion) {
            try {
              await completeReviewMarkerCheckRun(
                target.markerToken ?? token,
                owner,
                repo,
                record.markerCheckRunId,
                conclusion,
              );
              record.markerCheckRunId = undefined;
            } catch {
              // A marker that cannot be closed is not a failed status read: the
              // ledger step treats a marker whose run is terminal as stale.
            }
          }
        }
        return {
          ...status,
          github: await findLandedReview(app, token, target, record),
        };
      } catch (err) {
        return replyReviewError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { runId: string } }>(
    "/api/sessions/:id/review-stop",
    { schema: reviewStopSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");
      if (!gateReviewer(app, reply)) return reply;
      try {
        return await stopHermesReview(app, request.body.runId, sessionId);
      } catch (err) {
        return replyReviewError(reply, err);
      }
    },
  );

  // Issue triage (issue #1629): the same relay, aimed at an issue instead of
  // a pull request. The run posts its findings as a comment on the issue.
  app.post<{ Params: { id: string }; Body: TriageRequestBody }>(
    "/api/sessions/:id/triage-request",
    { schema: triageRequestSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");
      if (!gateReviewer(app, reply)) return reply;

      // The schema requires issueNumber, so Fastify has already refused a
      // request without one.
      const issueNumber = request.body.issueNumber;
      const target = await resolveTriageTarget(
        app,
        reply,
        sessionId,
        issueNumber,
        request.body.repo,
      );
      if (!target) return reply;
      const { owner, repo } = target;

      try {
        const run = await requestRelay(app, {
          kind: "issue",
          owner,
          repo,
          number: issueNumber,
          sessionId,
        });
        return {
          status: "dispatched",
          kind: "issue",
          repo: `${owner}/${repo}`,
          issueNumber,
          runId: run.runId,
          runStatus: run.status,
          replayed: run.replayed,
          // A triage of a closed issue still goes out — the caller may want
          // exactly that — but the caller is told (issue #1629).
          ...(target.issueState === "closed" ? { warning: `Issue #${issueNumber} is closed` } : {}),
        };
      } catch (err) {
        return replyReviewError(reply, err);
      }
    },
  );

  // Status of the latest triage run for an issue, plus whether the triage
  // comment actually landed on it.
  app.get<{ Params: { id: string }; Querystring: { issueNumber: number; repo?: string } }>(
    "/api/sessions/:id/triage-request",
    { schema: triageStatusSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");
      if (!gateReviewer(app, reply)) return reply;

      // The schema requires issueNumber, so Fastify has already refused a
      // request without one.
      const issueNumber = request.query.issueNumber;
      const target = await resolveTriageTarget(
        app,
        reply,
        sessionId,
        issueNumber,
        request.query.repo,
      );
      if (!target) return reply;
      const { owner, repo, token } = target;

      try {
        const status = await getRelayStatus(app, {
          kind: "issue",
          owner,
          repo,
          number: issueNumber,
        });
        const record = getRunForTarget("issue", owner, repo, issueNumber);
        return {
          ...status,
          github: await findLandedComment(app, token, target, record),
        };
      } catch (err) {
        return replyReviewError(reply, err);
      }
    },
  );
}

type LandedReview =
  | {
      checked: true;
      review: {
        author: string;
        state: string;
        commitId: string;
        submittedAt: string;
        /** The review's own text (issue #1704), bounded on the way in. */
        body?: string;
        bodyTruncated?: boolean;
        /** The review's page on GitHub. */
        htmlUrl?: string;
      } | null;
    }
  | { checked: false };

/**
 * The review states that count as "a review landed": the ones a bot actually
 * submits. A DISMISSED review was retracted, so it did not land. Both the
 * landed-review check and the duplicate-review warning use this one
 * definition, so `review status` and the warning never disagree.
 */
const LANDED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);

// Best effort: the newest review by a bot account submitted after the run was
// dispatched and pinned to the commit it was dispatched for. A GitHub failure
// must not hide the Hermes status.
async function findLandedReview(
  app: FastifyInstance,
  token: string,
  t: Omit<ReviewTarget, "foreign">,
  record: { dispatchedAt: number; headSha: string } | null,
): Promise<LandedReview> {
  if (!record) return { checked: false };
  const { dispatchedAt, headSha } = record;
  try {
    const reviews = await listPullRequestReviews(token, t.owner, t.repo, t.prNumber);
    const landed = reviews
      .filter(
        (r) =>
          r.authorIsBot &&
          r.commitId === headSha &&
          // The same "landed" definition the duplicate-review warning uses
          // (LANDED_REVIEW_STATES) — a DISMISSED review was retracted, so
          // it did not land, and "posted: <author> DISMISSED" would say
          // otherwise.
          LANDED_REVIEW_STATES.has(r.state) &&
          r.submittedAt &&
          Date.parse(r.submittedAt) >= dispatchedAt - 60_000,
      )
      .at(-1);
    return {
      checked: true,
      review: landed
        ? {
            author: landed.author,
            state: landed.state,
            commitId: landed.commitId,
            submittedAt: landed.submittedAt as string,
            // The reviewer's actual words — the one thing an agent that asked
            // for a review came for (issue #1704).
            ...(landed.body !== undefined ? { body: landed.body } : {}),
            ...(landed.bodyTruncated ? { bodyTruncated: true } : {}),
            ...(landed.htmlUrl !== undefined ? { htmlUrl: landed.htmlUrl } : {}),
          }
        : null,
    };
  } catch (err) {
    app.log.warn({ detail: (err as Error).message }, "review-status: GitHub review lookup failed");
    return { checked: false };
  }
}

/**
 * The relay's state for one pull request (issue #1630) — the state the
 * operator needs to see: was a review requested, is it still in flight, did
 * the bot's review land, and what did it say.
 *
 * The shape lives in src/shared/types.ts so the frontend cannot drift from
 * it; the doc there says what `"none"` does and does not mean.
 */
export type { RelayReviewState } from "../shared/types.js";

// The landed check costs a GitHub call, and the UI polls while a review is
// pending — so the answer is memoized per run for a short while. The window
// is well under the PR drill-in's own poll interval (30s), so a review that
// lands now is never hidden for more than one poll cycle.
//
// The memo lives on the app (a WeakMap keyed by it), not in a module-level
// map: a second buildApp() in the same process must not inherit the first
// one's answers.
const LANDED_MEMO_TTL_MS = 10_000;
const MAX_LANDED_MEMO_ENTRIES = 500;
const landedMemos = new WeakMap<
  FastifyInstance,
  Map<string, { landed: LandedReview; at: number }>
>();

function landedMemoFor(app: FastifyInstance): Map<string, { landed: LandedReview; at: number }> {
  let memo = landedMemos.get(app);
  if (!memo) {
    memo = new Map();
    landedMemos.set(app, memo);
  }
  return memo;
}

/**
 * Keeps the landed-review memo within its cap.
 *
 * The age sweep first: an entry past its TTL is worthless anyway. When that
 * frees nothing — a burst of *fresh* entries, which is exactly what a burst
 * of re-reviews is, since the key is per (PR, runId) — the oldest entries
 * are evicted instead, so the map cannot grow past the cap.
 */
export function pruneLandedMemo(
  memo: Map<string, { at: number }>,
  now: number,
  max: number = MAX_LANDED_MEMO_ENTRIES,
): void {
  if (memo.size <= max) return;
  for (const [key, entry] of memo) {
    if (now - entry.at >= LANDED_MEMO_TTL_MS) memo.delete(key);
  }
  if (memo.size <= max) return;
  const oldest = [...memo.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of oldest) {
    memo.delete(key);
    if (memo.size <= max) break;
  }
}

/**
 * The relay's state for a pull request, as the operator's UI sees it
 * (issue #1630). Needs a GitHub token to look for the landed review; without
 * one it still reports the request itself.
 */
export async function getRelayReviewState(
  app: FastifyInstance,
  opts: { owner: string; repo: string; prNumber: number; token?: string | null },
): Promise<RelayReviewState> {
  const { owner, repo, prNumber } = opts;
  const record = getReviewRunForPr(owner, repo, prNumber);
  if (!record) return { state: "none" };

  const base: RelayReviewState = {
    state: "requested",
    runId: record.runId,
    dispatchedAt: new Date(record.dispatchedAt).toISOString(),
  };
  if (!opts.token) {
    // No token means the landed-review lookup cannot run at all — so the
    // review is *unconfirmed*, not "not landed".
    return { ...base, landedChecked: false };
  }

  // The memo is keyed by the run, so a new dispatch re-checks immediately.
  const memo = landedMemoFor(app);
  const memoKey = `${owner}/${repo}#${prNumber}@${record.runId}`;
  const cached = memo.get(memoKey);
  const now = Date.now();
  let landed: LandedReview;
  if (cached && now - cached.at < LANDED_MEMO_TTL_MS) {
    // A HIT does NOT re-stamp the entry: a sliding window would let any
    // reader faster than the TTL pin the cached answer indefinitely — and
    // the PR list is refreshed on every webhook event, so a CI-active PR
    // would never see a review land.
    landed = cached.landed;
  } else {
    landed = await findLandedReview(
      app,
      opts.token,
      { owner, repo, prNumber, headSha: record.headSha, token: opts.token },
      record,
    );
    memo.set(memoKey, { landed, at: now });
    // The memo holds a review body per PR; drop the entries that can no
    // longer be hit, so it cannot grow with the process.
    pruneLandedMemo(memo, now);
  }

  if (landed.checked && landed.review) {
    return {
      ...base,
      state: "landed",
      landedChecked: true,
      author: landed.review.author,
      verdict: landed.review.state,
      ...(landed.review.body !== undefined ? { body: landed.review.body } : {}),
      ...(landed.review.bodyTruncated ? { bodyTruncated: true } : {}),
      ...(landed.review.htmlUrl !== undefined ? { htmlUrl: landed.review.htmlUrl } : {}),
    };
  }
  // `landedChecked: false` means the lookup itself failed — the UI can say
  // "could not confirm" instead of claiming the review is simply not there.
  return { ...base, landedChecked: landed.checked };
}

type LandedComment =
  | {
      checked: true;
      comment: {
        author: string;
        body: string;
        bodyTruncated: boolean;
        createdAt: string;
        htmlUrl?: string;
        /**
         * How the comment was attributed (issue #1629): "marked" when it
         * carries the triage marker Mullion's own prompt asks for,
         * "fallback" when it is the newest bot comment after the dispatch
         * (a custom triage prompt may not use the marker).
         */
        attribution: "marked" | "fallback";
      } | null;
    }
  | { checked: false };

// Best effort: the newest comment by a bot account on the issue, posted after
// the triage run was dispatched. A GitHub failure must not hide the Hermes
// status. The issue-comment counterpart of `findLandedReview` (issue #1629).
async function findLandedComment(
  app: FastifyInstance,
  token: string,
  t: TriageTarget,
  record: { dispatchedAt: number } | null,
): Promise<LandedComment> {
  if (!record) return { checked: false };
  const { dispatchedAt } = record;
  try {
    // `since` narrows the walk to comments touched after the dispatch, so a
    // busy issue does not cost ten pages of comments on every poll.
    const comments = await listIssueComments(token, t.owner, t.repo, t.issueNumber, {
      since: new Date(dispatchedAt - 60_000).toISOString(),
    });
    const newBotComments = comments.filter(
      (c) => c.authorIsBot && c.createdAt && Date.parse(c.createdAt) >= dispatchedAt - 60_000,
    );
    // A comment carrying the triage marker is ours; another bot's comment is
    // not. A custom triage prompt may not use the marker, so the newest bot
    // comment is the fallback — with its author in the payload, so a wrong
    // attribution is visible rather than silent.
    const marked = newBotComments.filter((c) => c.body.includes(TRIAGE_COMMENT_MARKER)).at(-1);
    const fallback = newBotComments.at(-1);
    const landed = marked ?? fallback;
    const attribution = marked ? "marked" : "fallback";
    return {
      checked: true,
      comment: landed
        ? {
            author: landed.author,
            attribution,
            body: landed.body,
            bodyTruncated: landed.bodyTruncated,
            createdAt: landed.createdAt as string,
            ...(landed.htmlUrl !== undefined ? { htmlUrl: landed.htmlUrl } : {}),
          }
        : null,
    };
  } catch (err) {
    app.log.warn({ detail: (err as Error).message }, "triage-status: GitHub comment lookup failed");
    return { checked: false };
  }
}

/**
 * The PR's reviews, read at most once per request.
 *
 * Two things need them: the delta base (the commit the previous round
 * covered) and the duplicate-review warning. The first is only needed once a
 * dispatch is actually going to happen — reading them is a GitHub call (up to
 * ten pages), and a request the relay refuses must not pay for it — so the
 * walk is memoized and the base is resolved lazily, by the relay itself.
 *
 * Shared with the operator's "re-review" route (routes/projects.ts): without
 * a base there, that route's key was always the FIRST round's key, so a
 * second click replayed the first run instead of reviewing anything.
 */
export function reviewReader(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  /**
   * The login of the bot that posts the review (e.g. "s3ntin3l8-hermes[bot]").
   * Only its landed reviews set the delta base — see the setting's comment.
   * Empty = any bot's review counts.
   */
  reviewerBotLogin = "",
): {
  reviews: () => Promise<Awaited<ReturnType<typeof listPullRequestReviews>>>;
  base: () => Promise<string>;
} {
  let cached: Awaited<ReturnType<typeof listPullRequestReviews>> | undefined;
  const reviews = async () => {
    cached ??= await listPullRequestReviews(token, owner, repo, prNumber);
    return cached;
  };
  return {
    reviews,
    /**
     * The commit the previous review round covered — the base of this round's
     * delta.
     *
     * It is the most recent LANDED review by the reviewer bot itself (a
     * DISMISSED review was retracted, so it did not land). The shared workflow
     * computes the same value for the same PR, and both put it in the
     * idempotency key: a request for a range that is already being reviewed
     * therefore names the same range on both paths, and cannot dispatch it
     * twice.
     *
     * A failure to read the reviews is not fatal: the round simply reviews
     * the whole diff (an empty base), which is what the first round does
     * anyway.
     */
    base: async () => {
      try {
        const landed = (await reviews()).filter(
          (r) =>
            r.authorIsBot &&
            // Only the reviewer's OWN reviews count. Another bot's review
            // (claude[bot], Copilot, a Task Master reviewer) landing on the
            // head must neither make this request a no-op nor become the base
            // of the next round — that round would then skip everything the
            // reviewer itself has not looked at yet. The shared workflow
            // applies the same rule (its `mention-trigger` input plus
            // "[bot]"), and the two must agree or their idempotency keys
            // diverge and the same range can be dispatched twice.
            (reviewerBotLogin === "" || r.author === reviewerBotLogin) &&
            // A landed review, not merely a non-dismissed one: a PENDING
            // (draft) review never landed, and using it as the base would
            // skip part of the diff.
            LANDED_REVIEW_STATES.has(r.state) &&
            r.commitId !== "",
        );
        return landed.at(-1)?.commitId ?? "";
      } catch {
        return "";
      }
    },
  };
}

/**
 * A warning for a request whose commit already carries a bot review.
 *
 * Issue #1705 wrote this as "warn, never refuse" — the repository reviews
 * new PRs on its own, and a request for a commit it has already reviewed was
 * routine, so it warned and dispatched anyway. That is now the *refusal*
 * above (a commit the REVIEWER has already reviewed has nothing new to
 * review), and this warning is the rarer case it left: a review by some
 * OTHER bot landed on this commit while a newer review of the reviewer's own
 * covers an older one, so the head is not what the last round looked at.
 *
 * It warns and dispatches anyway: refusing would break the legitimate "ask
 * for a second opinion" case, and the warning is enough for the caller to
 * see it.
 *
 * A GitHub failure degrades to "no warning" — it must never block or fail the
 * dispatch it is attached to.
 */
async function existingBotReviewWarning(
  t: Omit<ReviewTarget, "foreign">,
  reader: { reviews: () => Promise<Awaited<ReturnType<typeof listPullRequestReviews>>> },
): Promise<{ warning?: string }> {
  try {
    const existing = (await reader.reviews())
      .filter(
        (r) =>
          r.authorIsBot &&
          r.commitId === t.headSha &&
          // A DISMISSED review was retracted — it did not land, so warning
          // about it would assert the opposite of what happened.
          LANDED_REVIEW_STATES.has(r.state),
      )
      .at(-1);
    if (!existing) return {};
    return {
      warning: `A review by ${existing.author} (${existing.state}) already landed on this commit`,
    };
  } catch {
    // The warning is best effort: a failed lookup must not fail the request.
    return {};
  }
}
