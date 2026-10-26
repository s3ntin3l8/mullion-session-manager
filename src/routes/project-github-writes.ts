import type { FastifyInstance, FastifyReply } from "fastify";
import { GitHubApiError, GitHubRateLimitError } from "../services/github-fetch.js";
import { resolveGitHubToken } from "../services/github-integration.js";
import { invalidatePrDetail } from "../services/github-pr-detail.js";
import {
  createComment,
  createPullRequestReview,
  GitHubWriteScopeError,
  replyToReviewThread,
  resolveReviewThread,
} from "../services/github-write.js";
import { loadProjectRepoContext } from "./projects.js";

// The GitHub sidebar's own writes (#1672 a, b): reply to and resolve a review
// thread, comment on an issue or PR, and submit a PR review. Each goes out
// with the "write" token the merge route uses — the GitHub App installation
// token when one is configured, so the write posts as the App, else the
// connected PAT/OAuth account. After a write the PR's cached detail is
// dropped so the next read shows it.

// GitHub's own limit on a comment/review body.
const MAX_BODY_CHARS = 65_536;

const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
type ReviewEvent = (typeof REVIEW_EVENTS)[number];

const bodySchema = {
  body: {
    type: "object",
    required: ["body"],
    additionalProperties: false,
    properties: { body: { type: "string", minLength: 1, maxLength: MAX_BODY_CHARS } },
  },
} as const;

const reviewSchema = {
  body: {
    type: "object",
    required: ["event"],
    additionalProperties: false,
    properties: {
      event: { type: "string", enum: REVIEW_EVENTS },
      body: { type: "string", maxLength: MAX_BODY_CHARS },
      // The head the user reviewed; omitted, GitHub takes the current head.
      headSha: { type: "string", pattern: "^[0-9a-f]{7,40}$" },
    },
  },
} as const;

const writeRateLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

/**
 * GitHub's refusals as the sidebar should see them. A GraphQL mutation that
 * lacks permission comes back as HTTP 200 with an `errors` array, so "not
 * accessible" in the message is a scope problem too, not a 502.
 */
function replyWriteError(reply: FastifyReply, err: unknown, what: string): FastifyReply {
  if (!(err instanceof GitHubApiError)) throw err;
  // A GraphQL error on an HTTP 200 (`githubGraphQL` throws those with the
  // response's own status) — as opposed to a malformed answer with no data.
  const graphqlError = err.statusCode === 200 && err.message.startsWith("GitHub GraphQL error: ");
  if (err instanceof GitHubRateLimitError || (graphqlError && /rate limit/i.test(err.message))) {
    return reply.code(429).send({ message: "GitHub rate limit is in effect", statusCode: 429 });
  }
  // A REST 404 on a write is a number this repo does not have (a token
  // without write access gets a 403 from a repo it can read).
  if (err instanceof GitHubWriteScopeError && err.statusCode === 404) {
    return reply.code(404).send({
      message: `GitHub refused to ${what}: not found in this repository`,
      statusCode: 404,
    });
  }
  // "Resource not accessible by integration" (App token) / "… by personal
  // access token" (fine-grained PAT) / "… not been granted the required
  // scopes" (classic PAT) are GraphQL's permission refusals.
  if (
    err instanceof GitHubWriteScopeError ||
    (graphqlError &&
      /not accessible by|required scopes|must have (push|write) access/i.test(err.message))
  ) {
    return reply.code(403).send({
      message: `GitHub refused to ${what}: the connected token lacks write access to this repository`,
      statusCode: 403,
    });
  }
  if (/own pull request/i.test(err.message)) {
    return reply.code(422).send({
      message:
        "GitHub does not let a pull request's author approve or request changes on it, and this review would post as that author (the connected GitHub App or account). Leave a comment instead.",
      statusCode: 422,
    });
  }
  // 422 (REST validation) or a GraphQL error (an unknown thread id, say):
  // GitHub understood and refused — pass its own reason through. REST's
  // `errors` are strings or objects with a `message`; the top-level
  // `message` ("Validation Failed") is only the fallback.
  if (err.statusCode === 422 || graphqlError) {
    const reason =
      /"errors":\["([^"]+)"/.exec(err.message)?.[1] ??
      /"errors":\[\{[^\]]*?"message":"([^"]+)"/.exec(err.message)?.[1] ??
      /"message":"([^"]+)"/.exec(err.message)?.[1] ??
      /^GitHub GraphQL error: (.+)$/.exec(err.message)?.[1];
    return reply.code(422).send({
      message: `GitHub refused to ${what}${reason ? `: ${reason}` : ""}`,
      statusCode: 422,
    });
  }
  return reply
    .code(502)
    .send({ message: `Could not ${what} — GitHub unavailable`, statusCode: 502 });
}

function parseNumber(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export async function projectGitHubWritesRoute(app: FastifyInstance) {
  const writeContext = (reply: FastifyReply, projectId: string, label: string) =>
    loadProjectRepoContext(app, reply, Number(projectId), {
      unavailableLabel: label,
      resolveToken: (ref) => resolveGitHubToken(app, ref, "write"),
      noTokenMessage: "No GitHub token with write access is available",
    });

  app.post<{ Params: { id: string; number: string; threadId: string }; Body: { body: string } }>(
    "/api/projects/:id/github/prs/:number/threads/:threadId/reply",
    { schema: bodySchema, config: writeRateLimit },
    async (request, reply) => {
      const ctx = await writeContext(reply, request.params.id, "pr thread reply");
      if (!ctx) return;
      const number = parseNumber(request.params.number);
      if (number === null) return reply.badRequest("Invalid PR number");
      const body = request.body.body.trim();
      if (!body) return reply.badRequest("body must not be blank");
      try {
        const posted = await replyToReviewThread(ctx.token, request.params.threadId, body);
        invalidatePrDetail(ctx.repoRef.owner, ctx.repoRef.repo, number);
        return posted;
      } catch (err) {
        return replyWriteError(reply, err, "post this reply");
      }
    },
  );

  app.post<{ Params: { id: string; number: string; threadId: string } }>(
    "/api/projects/:id/github/prs/:number/threads/:threadId/resolve",
    { config: writeRateLimit },
    async (request, reply) => {
      const ctx = await writeContext(reply, request.params.id, "pr thread resolve");
      if (!ctx) return;
      const number = parseNumber(request.params.number);
      if (number === null) return reply.badRequest("Invalid PR number");
      try {
        await resolveReviewThread(ctx.token, request.params.threadId);
        invalidatePrDetail(ctx.repoRef.owner, ctx.repoRef.repo, number);
        return { resolved: true };
      } catch (err) {
        return replyWriteError(reply, err, "resolve this thread");
      }
    },
  );

  // An issue comment — also a PR's conversation comment (a PR is an issue).
  app.post<{ Params: { id: string; number: string }; Body: { body: string } }>(
    "/api/projects/:id/github/issues/:number/comments",
    { schema: bodySchema, config: writeRateLimit },
    async (request, reply) => {
      const ctx = await writeContext(reply, request.params.id, "issue comment");
      if (!ctx) return;
      const number = parseNumber(request.params.number);
      if (number === null) return reply.badRequest("Invalid issue number");
      const body = request.body.body.trim();
      if (!body) return reply.badRequest("body must not be blank");
      try {
        const posted = await createComment(
          ctx.token,
          ctx.repoRef.owner,
          ctx.repoRef.repo,
          number,
          body,
        );
        invalidatePrDetail(ctx.repoRef.owner, ctx.repoRef.repo, number);
        return posted;
      } catch (err) {
        return replyWriteError(reply, err, "post this comment");
      }
    },
  );

  app.post<{
    Params: { id: string; number: string };
    Body: { event: ReviewEvent; body?: string; headSha?: string };
  }>(
    "/api/projects/:id/github/prs/:number/reviews",
    { schema: reviewSchema, config: writeRateLimit },
    async (request, reply) => {
      const ctx = await writeContext(reply, request.params.id, "pr review");
      if (!ctx) return;
      const number = parseNumber(request.params.number);
      if (number === null) return reply.badRequest("Invalid PR number");
      const { event, headSha } = request.body;
      const body = request.body.body?.trim() ?? "";
      // GitHub requires a body for a comment or a change request, not for an approval.
      if (!body && event !== "APPROVE") {
        return reply.badRequest("A comment or change request needs a body");
      }
      try {
        const posted = await createPullRequestReview(
          ctx.token,
          ctx.repoRef.owner,
          ctx.repoRef.repo,
          number,
          { body, event, commitId: headSha },
        );
        invalidatePrDetail(ctx.repoRef.owner, ctx.repoRef.repo, number);
        return posted;
      } catch (err) {
        return replyWriteError(reply, err, "submit this review");
      }
    },
  );
}
