// "Merge anyway": a human's override of a merge hold that only NON-required
// checks cause (GitHub's `unstable` merge state).
//
// The override is bound to one PR head (`tasks.mergeOverrideHeadSha`, set by
// POST /api/tasks/:id/merge) and honoured by `classifyMergeReadiness`, so a
// later push voids it and a red REQUIRED check (`blocked`) can never be
// overridden. This file owns the hold's wording and the one predicate the UI
// derives its button from, so the two cannot drift.

import type { FastifyInstance } from "fastify";
import type { projects, tasks } from "../db/schema.js";
import { getPullRequestByNumber } from "./github-write.js";
import { resolveGitHubToken } from "./github-integration.js";
import { resolveRepoRef } from "./host-git.js";

/** The `mergeError` the sweep records for an `unstable` PR with named red checks. */
export const UNSTABLE_HOLD_PREFIX = "Held: a non-required check is red";

/** The merge sweep's `unstable` message: name the red checks when there are any
 * ("failing or still running" sends a human hunting). */
export function unstableHeldReason(red: { name: string; detail?: string | null }[]): string {
  if (red.length === 0) return "A non-required check is failing or still running";
  const named = red.map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name)).join("; ");
  return `${UNSTABLE_HOLD_PREFIX} — ${named}. Fix it, or use "Merge anyway" to override.`;
}

/** A `done` task whose merge is held by named non-required red checks — the only
 * state "Merge anyway" is offered in. */
export function isMergeOverridable(
  task: Pick<typeof tasks.$inferSelect, "status" | "mergeError">,
): boolean {
  return task.status === "done" && (task.mergeError?.startsWith(UNSTABLE_HOLD_PREFIX) ?? false);
}

/**
 * The PR head a "Merge anyway" click binds to — read from GitHub at click time,
 * so the override covers exactly the commit the human was looking at and a
 * later push voids it. `refusal` is a message for a 4xx/5xx the route returns.
 */
export async function resolveMergeOverrideHead(
  app: FastifyInstance,
  task: Pick<typeof tasks.$inferSelect, "prNumber" | "status" | "mergeError">,
  project: typeof projects.$inferSelect,
): Promise<{ headSha: string } | { refusal: string; status: 409 | 502 }> {
  if (!isMergeOverridable(task) || task.prNumber === null) {
    return {
      refusal: "Merge anyway only applies while named non-required checks hold the merge",
      status: 409,
    };
  }
  const repoRef = await resolveRepoRef(app, project);
  const token = repoRef ? await resolveGitHubToken(app, repoRef, "read") : null;
  if (!repoRef || !token) return { refusal: "No GitHub access to read the PR head", status: 502 };
  try {
    const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
    // Not `unstable` any more (a required check went red, or it went green):
    // the sweep decides what to do; an override on it would be meaningless.
    if (pr.mergeableState !== "unstable") {
      return {
        refusal: `The PR is "${pr.mergeableState}", not held by non-required checks; use Merge now`,
        status: 409,
      };
    }
    return { headSha: pr.headSha };
  } catch (err) {
    app.log.warn({ err, prNumber: task.prNumber }, "merge override: could not read the PR head");
    return { refusal: "Could not read the PR from GitHub", status: 502 };
  }
}
