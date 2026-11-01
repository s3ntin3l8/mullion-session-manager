import type { FastifyReply } from "fastify";
import type { RetryTaskOutcome } from "../services/task-claim.js";
import { SUPERSEDED_RETRY_DETAIL } from "../services/task-claim.js";

// The HTTP response for a REFUSED Retry — the mapping from `retryTask`'s
// outcome reason to what the caller sees.
//
// It lives in its own module because routes/tasks.ts is over its size ceiling
// (scripts/check-max-file-lines.mjs is a ratchet: a file may not grow past the
// size it had at the reference commit), and a new refusal case there would
// grow it. Every response below is the one the route used to send, verbatim —
// the status codes, the `error`/`limit`/`message` bodies, and the fallback
// texts — so moving the mapping changes nothing an API client can observe.
export function retryRefusal(
  reply: FastifyReply,
  outcome: Extract<RetryTaskOutcome, { ok: false }>,
): FastifyReply {
  switch (outcome.reason) {
    case "not-found":
      return reply.notFound();
    case "not-failed":
      return reply.conflict(outcome.detail ?? "Task is not failed");
    case "superseded":
      // #2292 — a copy a project merge superseded: another task owns the
      // issue now, so retrying it would start a duplicate worker.
      return reply.conflict(outcome.detail ?? SUPERSEDED_RETRY_DETAIL);
    case "cap":
      return reply
        .code(429)
        .send({ error: "concurrency-cap", limit: outcome.limit, message: outcome.detail });
    case "no-worktree":
      return reply.badRequest(outcome.detail ?? "Task has no recorded branch to resume");
    case "remote-not-supported":
      return reply.code(501).send({ error: "remote-not-supported", message: outcome.detail });
    case "worktree-failed":
      return reply.badGateway(outcome.detail ?? "Failed to resume this task's worktree");
    case "spawn-failed":
      return reply.badGateway(outcome.detail ?? "Failed to spawn a session for this task");
  }
}
