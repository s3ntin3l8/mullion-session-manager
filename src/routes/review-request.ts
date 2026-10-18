import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { getGitStatus } from "../services/git-status.js";
import { resolveRepoRef } from "../services/host-git.js";
import { resolveGitHubToken } from "../services/github-integration.js";
import {
  findPullRequestByHead,
  getPullRequestByNumber,
  listPullRequestReviews,
} from "../services/github-write.js";
import { GitHubApiError } from "../services/github-fetch.js";
import {
  HermesAuthError,
  HermesNotConfiguredError,
  HermesUnavailableError,
  ReviewConflictError,
  ReviewCooldownError,
  ReviewRunForbiddenError,
  ReviewRunNotFoundError,
  assertReviewerConfigured,
  getHermesReviewStatus,
  getReviewRunForPr,
  requestHermesReview,
  stopHermesReview,
} from "../services/hermes-review.js";

// An agent's `request_review` / `review_status` / `stop_review` (MCP) and
// `mullion review [status|stop]` (CLI) land here via the control socket's
// `reviews.*` ops (plugins/control-socket.ts), which pin a session-scope
// caller to its OWN session id. The repo is always derived from that session's
// project — never from the request body — so a session can only ever ask
// about a PR in the repo it is working in, and can only stop runs it
// dispatched itself. The Hermes URL/key never leave the server
// (services/hermes-integration.ts).

interface ReviewRequestBody {
  prNumber?: number;
}

const reviewRequestSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: { prNumber: { type: "integer", minimum: 1 } },
  },
};

const reviewStatusSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { prNumber: { type: "integer", minimum: 1 } },
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
  prNumber: number;
  headSha: string;
  token: string;
}

// Maps the service's errors to HTTP. Anything unexpected is rethrown (500).
export function replyReviewError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HermesNotConfiguredError) return reply.preconditionFailed(err.message);
  if (err instanceof ReviewCooldownError) {
    reply.header("Retry-After", String(err.retryAfterSeconds));
    return reply.conflict(err.message);
  }
  if (err instanceof ReviewConflictError) return reply.conflict(err.message);
  if (err instanceof ReviewRunNotFoundError) return reply.notFound(err.message);
  if (err instanceof ReviewRunForbiddenError) return reply.forbidden(err.message);
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
 * Session → repo + PR (+ head SHA and a read token). Sends the error reply
 * itself and returns null when the target can't be resolved.
 */
async function resolveReviewTarget(
  app: FastifyInstance,
  reply: FastifyReply,
  sessionId: number,
  requestedPr: number | undefined,
): Promise<ReviewTarget | null> {
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

  // v1: branch detection below reads the local filesystem, so a
  // remote-host project would silently look at the wrong checkout.
  if (project.hostId !== LOCAL_HOST_ID) {
    reply.preconditionFailed("The review relay supports local-host projects only");
    return null;
  }

  // The project's own cwd, not the session's: parseGitRemote reads
  // `<cwd>/.git/config` directly, which doesn't exist for a worktree
  // (where `.git` is a file).
  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) {
    reply.preconditionFailed("This project has no GitHub remote");
    return null;
  }
  const { owner, repo } = repoRef;

  const token = await resolveGitHubToken(app, { owner, repo }, "read");
  if (!token) {
    reply.preconditionFailed("No GitHub credentials are configured");
    return null;
  }

  let prNumber = requestedPr;
  try {
    if (prNumber === undefined) {
      const branch =
        app.pty.get(String(sessionId))?.liveBranch ??
        (await getGitStatus(session.cwd ?? project.cwd))?.branch;
      if (!branch || branch === "(detached)") {
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
    return { owner, repo, prNumber, headSha: pr.headSha, token };
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

export async function reviewRequestRoute(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: ReviewRequestBody }>(
    "/api/sessions/:id/review-request",
    { schema: reviewRequestSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");
      if (!gateReviewer(app, reply)) return reply;

      const target = await resolveReviewTarget(app, reply, sessionId, request.body.prNumber);
      if (!target) return reply;
      const { owner, repo, prNumber, headSha } = target;

      try {
        const run = await requestHermesReview(app, { owner, repo, prNumber, headSha, sessionId });
        return {
          status: "dispatched",
          repo: `${owner}/${repo}`,
          prNumber,
          runId: run.runId,
          runStatus: run.status,
          replayed: run.replayed,
        };
      } catch (err) {
        return replyReviewError(reply, err);
      }
    },
  );

  // Status of the latest review run for the session's PR, plus whether the
  // review bot's verdict actually landed on GitHub — Hermes can report
  // "completed" for a run that posted nothing (e.g. it had no App credentials).
  app.get<{ Params: { id: string }; Querystring: { prNumber?: number } }>(
    "/api/sessions/:id/review-request",
    { schema: reviewStatusSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");
      if (!gateReviewer(app, reply)) return reply;

      const target = await resolveReviewTarget(app, reply, sessionId, request.query.prNumber);
      if (!target) return reply;
      const { owner, repo, prNumber, token } = target;

      try {
        const status = await getHermesReviewStatus(app, { owner, repo, prNumber });
        const record = getReviewRunForPr(owner, repo, prNumber);
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
}

type LandedReview =
  | {
      checked: true;
      review: { author: string; state: string; commitId: string; submittedAt: string } | null;
    }
  | { checked: false };

// Best effort: the newest review by a bot account submitted after the run was
// dispatched and pinned to the commit it was dispatched for. A GitHub failure
// must not hide the Hermes status.
async function findLandedReview(
  app: FastifyInstance,
  token: string,
  t: ReviewTarget,
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
          }
        : null,
    };
  } catch (err) {
    app.log.warn({ detail: (err as Error).message }, "review-status: GitHub review lookup failed");
    return { checked: false };
  }
}
