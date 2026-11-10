import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tasks, type projects } from "../db/schema.js";
import { resolveGitHubToken } from "./github-integration.js";
import { createComment, getIssueState, removeLabel } from "./github-write.js";
import { resolveRepoRef } from "./host-git.js";
import { broadcastTaskEvent } from "./task-events.js";
import { LABEL_DONE, recordGithubSyncError } from "./task-github-sync.js";

/** `tasks.needsHumanReason` for an approved task whose PR was closed without merging. */
export const PR_CLOSED_REASON = "pr-closed";

// What a human can do with a `done` task: reject and give-up need `reviewing`,
// so the two that work are "Merge now" (after reopening the PR) and Archive.
const REMEDY =
  "Reopen the PR and use Merge now, or, if the work is abandoned, close the issue and archive the task.";

const closedMessage = (prNumber: number): string =>
  `PR #${prNumber} was closed without merging, so nothing from this approved task landed. ${REMEDY}`;

/**
 * An approved (`done`) task whose PR was CLOSED WITHOUT MERGING has nothing on
 * the default branch, but `done` says "shipped" and the `→ done` sync left its
 * issue open and labelled `mullion-done` (task-github-sync.ts). Nothing else
 * ever looks at it again, so flag it for a human: `needsHumanReason` =
 * `pr-closed` plus a `mergeError` that says why, drop the `mullion-done`
 * label, and comment on the issue. The issue itself stays open on purpose: the
 * work did not land.
 *
 * Idempotent: the write is a compare-and-set on "not already flagged", so the
 * sweeps that reach this on every tick (the merge sweep's `already-done` arm,
 * the re-poll) flag and comment exactly once. Returns whether THIS call
 * flagged the task. The GitHub writes are best-effort and never throw: a
 * failure is recorded in `githubSyncError` like any other sync write, and the
 * local flag has already committed.
 */
export async function flagClosedUnmergedDoneTask(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: Pick<typeof projects.$inferSelect, "cwd" | "hostId">,
): Promise<boolean> {
  if (task.prNumber === null) return false;
  const message = closedMessage(task.prNumber);
  const { changes } = app.db
    .update(tasks)
    .set({ needsHumanReason: PR_CLOSED_REASON, mergeError: message })
    .where(
      and(
        eq(tasks.id, task.id),
        eq(tasks.status, "done"),
        isNull(tasks.mergedAt),
        sql`${tasks.needsHumanReason} IS NOT ${PR_CLOSED_REASON}`,
      ),
    )
    .run();
  if (changes === 0) {
    // Already flagged: nothing to announce. But "Merge now" on a PR that is
    // still closed clears `mergeError` (and clearMergeState does again), leaving
    // the reason with no message, so put it back.
    app.db
      .update(tasks)
      .set({ mergeError: message })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.needsHumanReason, PR_CLOSED_REASON),
          isNull(tasks.mergedAt),
          isNull(tasks.mergeError),
        ),
      )
      .run();
    return false;
  }
  broadcastTaskEvent({
    taskId: task.id,
    projectId: task.projectId,
    kind: "ingested",
    ts: Date.now(),
  });

  if (task.issueNumber === null) return true;
  try {
    const repoRef = await resolveRepoRef(app, project);
    const token = repoRef ? await resolveGitHubToken(app, repoRef) : null;
    if (!repoRef || !token) {
      recordGithubSyncError(
        app,
        task.id,
        `Could not update issue #${task.issueNumber} after its PR was closed unmerged: ${
          repoRef ? "no GitHub token is connected" : "the project's repo could not be resolved"
        }`,
      );
      return true;
    }
    // An issue a human already closed (the task went `done` through the
    // closed-issue sync) has nothing to keep open or relabel: the local flag is
    // enough.
    const { state } = await getIssueState(token, repoRef.owner, repoRef.repo, task.issueNumber);
    if (state === "closed") return true;
    await removeLabel(token, repoRef.owner, repoRef.repo, task.issueNumber, LABEL_DONE);
    await createComment(
      token,
      repoRef.owner,
      repoRef.repo,
      task.issueNumber,
      `PR #${task.prNumber} was closed without merging, so this issue stays open and the task is flagged for a human. ${REMEDY}`,
    );
  } catch (err) {
    app.log.warn(
      { taskId: task.id, issueNumber: task.issueNumber, err },
      "[task-pr-closed] updating the issue after its PR was closed unmerged failed — the local flag is set",
    );
    recordGithubSyncError(app, task.id, err instanceof Error ? err.message : String(err));
  }
  return true;
}
