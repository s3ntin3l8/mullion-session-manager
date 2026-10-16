import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { getGitStatus } from "../services/git-status.js";
import { resolveRepoRef } from "../services/host-git.js";
import { resolveGitHubToken } from "../services/github-integration.js";
import { findPullRequestByHead, getPullRequestByNumber } from "../services/github-write.js";
import {
  HermesAuthError,
  HermesNotConfiguredError,
  HermesUnavailableError,
  ReviewCooldownError,
  requestHermesReview,
} from "../services/hermes-review.js";

// An agent's `request_review` (MCP) / `mullion review` (CLI) lands here via
// the control socket's `reviews.request` op (plugins/control-socket.ts),
// which pins a session-scope caller to its OWN session id. The repo is always
// derived from that session's project — never from the request body — so a
// session can only ever ask for a review of a PR in the repo it is working in.
// The Hermes URL/key never leave the server (services/hermes-integration.ts).

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

export async function reviewRequestRoute(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: ReviewRequestBody }>(
    "/api/sessions/:id/review-request",
    { schema: reviewRequestSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [session] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!session) return reply.notFound("Session not found");
      const [project] = app.db
        .select()
        .from(projects)
        .where(eq(projects.id, session.projectId))
        .all();
      if (!project) return reply.notFound("Project not found");

      // v1: branch detection below reads the local filesystem, so a
      // remote-host project would silently look at the wrong checkout.
      if (project.hostId !== LOCAL_HOST_ID) {
        return reply.preconditionFailed("The review relay supports local-host projects only");
      }

      // The project's own cwd, not the session's: parseGitRemote reads
      // `<cwd>/.git/config` directly, which doesn't exist for a worktree
      // (where `.git` is a file).
      const repoRef = await resolveRepoRef(app, project);
      if (!repoRef) return reply.preconditionFailed("This project has no GitHub remote");
      const { owner, repo } = repoRef;

      const token = await resolveGitHubToken(app, { owner, repo }, "read");
      if (!token) return reply.preconditionFailed("No GitHub credentials are configured");

      let prNumber = request.body.prNumber;
      if (prNumber !== undefined) {
        try {
          await getPullRequestByNumber(token, owner, repo, prNumber);
        } catch {
          return reply.notFound(`PR #${prNumber} was not found in ${owner}/${repo}`);
        }
      } else {
        const branch =
          app.pty.get(String(sessionId))?.liveBranch ??
          (await getGitStatus(session.cwd ?? project.cwd))?.branch;
        if (!branch || branch === "(detached)") {
          return reply.notFound("Could not determine this session's branch — pass prNumber");
        }
        const pr = await findPullRequestByHead(token, owner, repo, `${owner}:${branch}`);
        if (!pr) return reply.notFound(`No open PR found for branch ${branch}`);
        prNumber = pr.number;
      }

      try {
        await requestHermesReview(app, { owner, repo, prNumber });
      } catch (err) {
        if (err instanceof HermesNotConfiguredError) return reply.preconditionFailed(err.message);
        if (err instanceof ReviewCooldownError) {
          reply.header("Retry-After", String(err.retryAfterSeconds));
          return reply.conflict(err.message);
        }
        if (err instanceof HermesAuthError) return reply.badGateway(err.message);
        if (err instanceof HermesUnavailableError) return reply.serviceUnavailable(err.message);
        throw err;
      }
      return { status: "dispatched", repo: `${owner}/${repo}`, prNumber };
    },
  );
}
