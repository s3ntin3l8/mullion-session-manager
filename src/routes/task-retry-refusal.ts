import type { FastifyReply } from "fastify";
import type { EnqueueRetryOutcome } from "../services/task-retry.js";
import { SUPERSEDED_RETRY_DETAIL } from "../services/task-claim.js";

// The HTTP response for a REFUSED Retry — the mapping from `retryTask`'s
// outcome reason to what the caller sees. A retry is queued rather than
// refused when the concurrency cap is full, so there is no cap case.
//
// It lives in its own module because routes/tasks.ts is over its size ceiling
// (scripts/check-max-file-lines.mjs is a ratchet: a file may not grow past the
// size it had at the reference commit), and a new refusal case there would
// grow it. Every response below is the one the route used to send, verbatim —
// the status codes, the `error`/`limit`/`message` bodies, and the fallback
// texts — so moving the mapping changes nothing an API client can observe.
export function retryRefusal(
  reply: FastifyReply,
  outcome: Extract<EnqueueRetryOutcome, { ok: false }>,
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
    case "no-worktree":
      return reply.badRequest(outcome.detail ?? "Task has no recorded branch to resume");
  }
}
